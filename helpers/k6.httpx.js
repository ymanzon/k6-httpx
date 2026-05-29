/**
 * k6-httpx v2 — Enhanced HTTP client library for k6
 * --------------------------------------------------
 *  - http.batch() for true parallel requests
 *  - Dot-notation + array-index path resolver
 *  - Exponential backoff in retry()
 *  - buildUrl() query-param helper
 *  - GET / POST / PUT / PATCH / DELETE / HEAD
 *  - multipart() form-data helper
 *  - Tagged custom metrics (url, method, status)
 *  - beforeAll / afterAll lifecycle hooks
 *  - contract()      handles object AND array responses
 *  - contractArray() validates every element in an array
 *  - Structured error logging on network failures
 *  - Auto-sleep on 429 with Retry-After header support
 *  - Lazy cookie jar (safe in init context)
 *  - env() helper for k6 -e environment variables
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Counter, Rate } from "k6/metrics";

/* ═══════════════════════════════════════════════════
   INTERNAL STATE
═══════════════════════════════════════════════════ */

const _timeline         = [];
const _reportData       = [];
const _customMetrics    = {};
const _plugins          = [];
const _correlationStore = {};
const _hooks            = { beforeAll: [], afterAll: [] };

let _openApiSpec      = null;
let _defaultBaseUrl   = "";
let _rateLimitSleepMs = 1000;

// Built-in aggregate metrics — declared at module level (init context is fine)
const _metricErrors   = new Counter("httpx_errors_total");
const _metricRequests = new Counter("httpx_requests_total");
const _metricDuration = new Trend("httpx_duration_ms", true);
const _metricSuccess  = new Rate("httpx_success_rate");

/* ═══════════════════════════════════════════════════
   COOKIE JAR — lazy, never called in init context
═══════════════════════════════════════════════════ */

let _cookieJar = null;

function _getCookieJar() {
    if (!_cookieJar) {
        _cookieJar = http.cookieJar();
    }
    return _cookieJar;
}

/* ═══════════════════════════════════════════════════
   SESSION / AUTH
═══════════════════════════════════════════════════ */

const _session = {
    token:        null,
    header:       "Authorization",
    prefix:       "Bearer",
    extraHeaders: {},

    setToken(token, header = "Authorization", prefix = "Bearer") {
        this.token  = token;
        this.header = header;
        this.prefix = prefix;
    },

    setHeader(name, value) {
        this.extraHeaders[name] = value;
    },

    clearToken() {
        this.token        = null;
        this.extraHeaders = {};
    },

    apply(headers) {
        // B-05 fix: return a NEW object — never mutate the caller's headers
        var merged = Object.assign({}, headers, this.extraHeaders);
        if (this.token) {
            merged[this.header] = (this.prefix + " " + this.token).trim();
        }
        return merged;
    }
};

/* ═══════════════════════════════════════════════════
   PRIVATE HELPERS
═══════════════════════════════════════════════════ */

/**
 * Declares a custom Trend metric. MUST be called in the init context
 * (top-level module scope, outside default/setup/teardown).
 * After declaring, use httpx.metric(name, value) inside VU functions.
 *
 * Example (in your script, at the top level):
 *   httpx.declareMetric("checkout_ms");
 *   httpx.declareMetric("search_ms");
 */
function _declareMetric(name) {
    if (!_customMetrics[name]) {
        _customMetrics[name] = new Trend(name, true);
    }
    return _customMetrics[name];
}

/**
 * Records a value to a previously declared metric.
 * Must be called AFTER httpx.declareMetric(name) was called in init context.
 */
function _recordMetric(name, value, tags) {
    if (!_customMetrics[name]) {
        throw new Error(
            `[httpx] metric "${name}" not declared. ` +
            `Call httpx.declareMetric("${name}") at the top level of your script (init context) before using it.`
        );
    }
    _customMetrics[name].add(value, tags || {});
}

function _buildUrl(base, params) {
    if (params === undefined) params = {};
    const fullBase = base.startsWith("http") ? base : `${_defaultBaseUrl}${base}`;
    const keys = Object.keys(params).filter(k => params[k] !== undefined && params[k] !== null);
    if (!keys.length) return fullBase;
    const qs = keys.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join("&");
    return `${fullBase}?${qs}`;
}

function _resolvePath(obj, path) {
    // B-02: guard against null/undefined obj or empty/invalid path
    if (obj === null || obj === undefined) return undefined;
    if (typeof path !== "string" || path === "") return undefined;
    return path.split(".").reduce(function(acc, key) {
        if (acc === null || acc === undefined) return undefined;
        // Root array index: "[0]"
        var rootIdx = key.match(/^\[(\d+)\]$/);
        if (rootIdx) {
            return Array.isArray(acc) ? acc[parseInt(rootIdx[1], 10)] : undefined;
        }
        // Property + array index: "items[2]"
        var propIdx = key.match(/^(.+)\[(\d+)\]$/);
        if (propIdx) {
            var prop = acc[propIdx[1]];
            return Array.isArray(prop) ? prop[parseInt(propIdx[2], 10)] : undefined;
        }
        return acc[key];
    }, obj);
}

function _validateType(value, expectedType) {
    if (expectedType === "any")    return true;
    if (expectedType === "null")   return value === null;
    if (expectedType === "array")  return Array.isArray(value);
    if (expectedType === "object") return value !== null && !Array.isArray(value) && typeof value === "object";
    return typeof value === expectedType;
}

function _typeName(value) {
    if (value === null)       return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
}

function _env(key, defaultValue) {
    if (defaultValue === undefined) defaultValue = "";
    return (typeof __ENV !== "undefined" && __ENV[key]) ? __ENV[key] : defaultValue;
}


/* ═══════════════════════════════════════════════════
   XML PARSER
   indexOf-based — reliable across all k6/Goja versions.
   No regex [\s\S] that breaks in some JS engines.

   Supported paths:
     "code"                  → <code>value</code>   (search in full body)
     "OLS.code"              → <OLS>…<code>…</OLS>
     "OLS.auth"              → <OLS>…<auth />…</OLS>  (self-closing → "")
     "channel.item[0].title" → first <item>'s <title>
════════════════════════════════════════════════════ */

/**
 * Extracts the inner text of the first (or Nth) matching tag from an XML string.
 * Handles self-closing tags (<tag />) returning "" and regular tags returning content.
 * @param {string} xml  — XML source string
 * @param {string} tag  — tag name (no angle brackets)
 * @param {number} idx  — -1 for first match, 0..N for Nth match
 * @returns {string|undefined}
 */
function _xmlExtractTag(xml, tag, idx) {
    var openTag  = "<" + tag;
    var closeTag = "</" + tag + ">";
    var count    = 0;
    var pos      = 0;

    while (pos < xml.length) {
        var start = xml.indexOf(openTag, pos);
        if (start === -1) break;

        // Guard against partial tag matches e.g. <codeExtra> when looking for <code>
        var charAfter = start + openTag.length < xml.length
            ? xml[start + openTag.length]
            : "";
        if (charAfter !== " " && charAfter !== ">" &&
            charAfter !== "/" && charAfter !== "\t" &&
            charAfter !== "\n" && charAfter !== "\r") {
            pos = start + 1;
            continue;
        }

        // Find the closing ">" of the opening tag
        var gtPos = xml.indexOf(">", start);
        if (gtPos === -1) { pos = start + 1; continue; }

        // Self-closing tag: <tag/> or <tag attr="…"/>
        if (xml[gtPos - 1] === "/") {
            if (idx < 0 || count === idx) {
                return ""; // present but empty
            }
            count++;
            pos = gtPos + 1;
            continue;
        }

        // Regular tag — find closing counterpart
        var closePos = xml.indexOf(closeTag, gtPos + 1);
        if (closePos === -1) { pos = start + 1; continue; }

        if (idx < 0 || count === idx) {
            return xml.substring(gtPos + 1, closePos);
        }

        count++;
        pos = closePos + closeTag.length;
    }
    return undefined;
}

/**
 * Resolves a dot-notation XML path against an XML string.
 * Returns the trimmed text content, "" for self-closing, undefined if not found.
 *
 * Examples:
 *   _xmlGetValue(xml, "OLS.code")              → "07"
 *   _xmlGetValue(xml, "OLS.auth")              → ""  (self-closing)
 *   _xmlGetValue(xml, "OLS.errorDesc")         → "SERVICIO NO DISPONIBLE"
 *   _xmlGetValue(xml, "channel.item[0].title") → "First Post"
 */
function _xmlGetValue(xml, path) {
    if (!xml || !path) return undefined;

    var parts   = path.split(".");
    var current = xml;

    for (var i = 0; i < parts.length; i++) {
        if (current === undefined || current === null) return undefined;
        current = String(current);

        var part     = parts[i];
        var arrMatch = part.match(/^(.+)\[(\d+)\]$/);
        var tag      = arrMatch ? arrMatch[1] : part;
        var idx      = arrMatch ? parseInt(arrMatch[2], 10) : -1;

        var extracted = _xmlExtractTag(current, tag, idx);
        if (extracted === undefined) return undefined;
        current = extracted;
    }

    // Strip any child tags remaining and return trimmed text
    return current.replace(/<[^>]*>/g, "").trim();
}

/**
 * Reads an attribute value from a specific tag in an XML string.
 * _xmlGetAttr(xml, "OLS", "version") → "1.0"
 */
function _xmlGetAttr(xml, tag, attr) {
    var tagStart = xml.indexOf("<" + tag);
    if (tagStart === -1) return undefined;
    var tagEnd = xml.indexOf(">", tagStart);
    if (tagEnd === -1) return undefined;
    var tagStr = xml.substring(tagStart, tagEnd + 1);
    // Match attr="value" or attr='value'
    var re = new RegExp(attr + '=["\']([^"\']*)["\']');
    var m  = tagStr.match(re);
    return m ? m[1] : undefined;
}

/* ═══════════════════════════════════════════════════
   HTTP RESPONSE WRAPPER
═══════════════════════════════════════════════════ */

class HttpxResponse {

    constructor(res, meta) {
        this.res        = res;
        this.meta       = meta;
        this._jsonCache = undefined;
    }

    /* ── Accessors ─────────────────────────────── */

    json() {
        if (this._jsonCache !== undefined) return this._jsonCache;
        try   { this._jsonCache = this.res.json(); }
        catch { this._jsonCache = null; }
        return this._jsonCache;
    }

    text()     { return this.res.body; }
    status()   { return this.res.status; }
    headers()  { return this.res.headers; }
    ok()       { return this.res.status >= 200 && this.res.status < 300; }
    duration() { return this.res.timings.duration; }

    /* ── cURL export ───────────────────────────── */

    toCurl() {
        var curl = `curl -X ${this.meta.method} "${this.meta.url}"`;
        var hdrs = this.meta.headers || {};
        for (var h in hdrs) {
            curl += ` \\\n  -H "${h}: ${hdrs[h]}"`;
        }
        if (this.meta.body) {
            var body = typeof this.meta.body === "string"
                ? this.meta.body
                : JSON.stringify(this.meta.body);
            curl += ` \\\n  -d '${body}'`;
        }
        return curl;
    }

    /* ── Trace / Debug ─────────────────────────── */

    trace() {
        console.log("\n── REQUEST ──────────────────────────────");
        console.log(this.toCurl());
        console.log("── RESPONSE ─────────────────────────────");
        console.log(`  status   : ${this.res.status}`);
        console.log(`  duration : ${this.res.timings.duration} ms`);
        console.log(`  size     : ${(this.res.body || "").length} bytes`);
        return this;
    }

    debug() {
        console.log(JSON.stringify({
            request: {
                method:  this.meta.method,
                url:     this.meta.url,
                headers: this.meta.headers,
                body:    this.meta.body
            },
            response: {
                status:  this.res.status,
                headers: this.res.headers,
                body:    this.res.body
            }
        }, null, 2));
        return this;
    }

    /* ── Fluent eval ───────────────────────────── */

    eval(fn) {
        fn({ httpx: this, res: this.res });
        return this;
    }

    /* ── Status assertions ─────────────────────── */

    expectStatus(code) {
        var label = `[${this.meta.method}] ${this.meta.url} -> status ${code}`;
        var checks = {};
        checks[label] = function(r) { return r.status === code; };
        check(this.res, checks);
        return this;
    }

    expect2xx() {
        var label = `[${this.meta.method}] ${this.meta.url} -> 2xx`;
        var checks = {};
        checks[label] = function(r) { return r.status >= 200 && r.status < 300; };
        check(this.res, checks);
        return this;
    }

    expectHeader(name, value) {
        var checks = {};
        checks[`header "${name}" includes "${value}"`] = function(r) {
            return r.headers[name] !== undefined && r.headers[name].includes(value);
        };
        check(this.res, checks);
        return this;
    }

    expectTime(ms) {
        var checks = {};
        checks[`response time < ${ms}ms`] = function(r) {
            return r.timings.duration < ms;
        };
        check(this.res, checks);
        return this;
    }

    /* ── JSON assertions ───────────────────────── */

    expectJSON(expected) {
        var data   = this.json();
        var checks = {};
        for (var k in expected) {
            (function(key, val) {
                checks[`json.${key} === ${JSON.stringify(val)}`] = function() {
                    return _resolvePath(data, key) === val;
                };
            })(k, expected[k]);
        }
        check(data, checks);
        return this;
    }

    expectJSONSchema(schema) {
        var data   = this.json();
        var checks = {};
        for (var k in schema) {
            (function(key, expected) {
                checks[`json.${key} is ${expected}`] = function() {
                    return _validateType(_resolvePath(data, key), expected);
                };
            })(k, schema[k]);
        }
        check(data, checks);
        return this;
    }

    /* ── XML assertions ────────────────────────── */

    /**
     * Validates tag => value pairs in an XML response body.
     * Works exactly like expectJSON() but for XML.
     *
     * Supports dot-notation paths and array index notation:
     *   "title"           → <title>...</title>
     *   "channel.title"   → <channel><title>...</title></channel>
     *   "item[0].title"   → first <item>'s <title>
     *   "item[1].link"    → second <item>'s <link>
     *
     * httpx.get("/feed.xml")
     *   .expectXML({
     *     "channel.title":       "My Blog",
     *     "channel.item[0].title": "First Post",
     *   })
     */
    expectXML(expected) {
        var body   = this.text();
        var checks = {};
        for (var k in expected) {
            (function(path, val) {
                checks[`xml.${path} === "${val}"`] = function() {
                    var actual = _xmlGetValue(body, path);
                    return actual === String(val);
                };
            })(k, expected[k]);
        }
        check(body, checks);
        return this;
    }

    /**
     * Checks that all listed tags are PRESENT in the XML body
     * (legacy behavior — presence only, no value check).
     *
     * .expectXMLTags(["title", "link", "description"])
     */
    expectXMLTags(tags) {
        var body   = this.text();
        var checks = {};
        tags.forEach(function(t) {
            checks[`xml <${t}> present`] = function() {
                // Matches: <tag>, <tag attr="">, <tag/>, <tag />
                return body.includes("<" + t + ">")
                    || body.includes("<" + t + " ")
                    || body.includes("<" + t + "/>")
                    || body.includes("<" + t + "/>");
            };
        });
        check(body, checks);
        return this;
    }

    /**
     * Checks that specific tags are EMPTY / self-closing in the XML body.
     * Matches both <tag /> and <tag></tag> (empty content).
     *
     * .expectXMLEmpty(["auth", "amount", "messageTicket"])
     */
    expectXMLEmpty(tags) {
        var body   = this.text();
        var checks = {};
        tags.forEach(function(t) {
            checks[`xml <${t}> is empty`] = function() {
                // Self-closing: <tag/> or <tag />
                var selfClose = body.includes("<" + t + "/>") || body.includes("<" + t + " />");
                // Empty with closing tag: <tag></tag>
                var emptyPair = new RegExp("<" + t + "[^>]*>\s*<\/" + t + ">").test(body);
                return selfClose || emptyPair;
            };
        });
        check(body, checks);
        return this;
    }

    /**
     * Reads and returns a specific XML tag value using dot-notation.
     * Useful for extracting XML values mid-chain.
     *
     * var title = res.xmlValue("channel.title");
     */
    xmlValue(path) {
        return _xmlGetValue(this.text(), path);
    }

    /**
     * Extracts XML tag values into the correlation store.
     * Same API as .extract() but for XML responses.
     *
     * .extractXML({ feedTitle: "channel.title", firstItem: "channel.item[0].title" })
     * httpx.var("feedTitle") → "My Blog"
     */
    extractXML(map) {
        var body = this.text();
        for (var storageKey in map) {
            var path  = map[storageKey];
            var value = _xmlGetValue(body, path);
            if (value !== undefined) {
                _correlationStore[storageKey] = value;
            } else {
                console.warn(`[httpx] extractXML: path "${path}" not found in XML`);
            }
        }
        return this;
    }

    /* ── Contract ──────────────────────────────── */

    /**
     * Validates the JSON response shape using k6 check() — SOFT mode.
     * Failures are recorded as failed checks (visible in CLI + dashboard)
     * but do NOT stop the VU iteration. Use contractStrict() for hard-fail.
     *
     * - OBJECT response  → validates keys directly.
     * - ARRAY  response  → validates the first element automatically.
     *
     * Supported types: "string"|"number"|"boolean"|"object"|"array"|"null"|"any"
     *
     * httpx.get("/users").contract({ id: "number", name: "string" })
     * httpx.get("/users/1").contract({ id: "number", name: "string" })
     */
    contract(schema) {
        // B-03 fix: use check() so failures appear in k6 summary, not as exceptions
        var raw    = this.json();
        var prefix = "[" + this.meta.method + "] " + this.meta.url + " contract";
        var checks = {};

        if (raw === null || raw === undefined) {
            checks[prefix + ": body is valid JSON"] = function() { return false; };
            check(null, checks);
            return this;
        }

        var target = Array.isArray(raw) ? raw[0] : raw;

        if (Array.isArray(raw) && raw.length === 0) {
            console.warn("[httpx] contract: empty array — schema not validated");
            return this;
        }

        for (var k in schema) {
            (function(key, expectedType) {
                var val = _resolvePath(target, key);
                checks[prefix + ": " + key + " is " + expectedType] = function() {
                    return _validateType(val, expectedType);
                };
            })(k, schema[k]);
        }
        check(raw, checks);
        return this;
    }

    /**
     * Validates the JSON response shape — STRICT mode.
     * Throws an Error on the first violation, stopping the iteration.
     * Use contract() for soft/non-blocking validation.
     *
     * httpx.get("/users/1").contractStrict({ id: "number", name: "string" })
     */
    contractStrict(schema) {
        var raw    = this.json();
        var prefix = "[" + this.meta.method + "] " + this.meta.url;

        if (raw === null || raw === undefined) {
            throw new Error(prefix + " contract: body is empty or not valid JSON");
        }

        var target = Array.isArray(raw) ? raw[0] : raw;
        if (Array.isArray(raw) && raw.length === 0) {
            console.warn("[httpx] contractStrict: empty array — schema not validated");
            return this;
        }
        if (typeof target !== "object" || target === null) {
            throw new Error(prefix + " contract: target is not an object, got " + _typeName(target));
        }

        for (var k in schema) {
            var value    = _resolvePath(target, k);
            var expected = schema[k];
            if (!_validateType(value, expected)) {
                throw new Error(
                    prefix + " contract violation: " + k + " expected " + expected + ", got " + _typeName(value)
                );
            }
        }
        return this;
    }

    /**
     * Validates every element of an array response — SOFT mode (uses check()).
     * Failures appear in k6 summary but don't stop the iteration.
     *
     * httpx.get("/users").contractArray({ id: "number", name: "string" })
     */
    contractArray(schema) {
        // B-03 fix: use check() instead of throw
        var data   = this.json();
        var prefix = "[" + this.meta.method + "] " + this.meta.url + " contractArray";
        var checks = {};

        if (!Array.isArray(data)) {
            checks[prefix + ": response is array"] = function() { return false; };
            check(null, checks);
            return this;
        }

        for (var i = 0; i < data.length; i++) {
            var item = data[i];
            for (var k in schema) {
                (function(idx, key, expectedType) {
                    var val = _resolvePath(item, key);
                    checks[prefix + "[" + idx + "]: " + key + " is " + expectedType] = function() {
                        return _validateType(val, expectedType);
                    };
                })(i, k, schema[k]);
            }
        }
        check(data, checks);
        return this;
    }

    /**
     * Validates every element of an array response — STRICT mode.
     * Throws on first violation. Use contractArray() for soft validation.
     *
     * httpx.get("/users").contractArrayStrict({ id: "number", name: "string" })
     */
    contractArrayStrict(schema) {
        var data   = this.json();
        var prefix = "[" + this.meta.method + "] " + this.meta.url;

        if (!Array.isArray(data)) {
            throw new Error(prefix + " contractArrayStrict: expected array, got " + typeof data);
        }

        for (var i = 0; i < data.length; i++) {
            var item = data[i];
            for (var k in schema) {
                var value    = _resolvePath(item, k);
                var expected = schema[k];
                if (!_validateType(value, expected)) {
                    throw new Error(
                        prefix + " contractArrayStrict violation at [" + i + "]: " + k +
                        " expected " + expected + ", got " + _typeName(value)
                    );
                }
            }
        }
        return this;
    }

    /* ── Soft assertion ────────────────────────── */

    softExpect(fn) {
        try   { fn(this); }
        catch (err) { console.warn(`[httpx] soft assertion failed: ${err.message}`); }
        return this;
    }

    /* ── Correlation extraction ────────────────── */

    /**
     * Extracts values from the JSON body into the correlation store.
     *
     * .extract({ authToken: "data.token", firstId: "[0].id" })
     * httpx.var("authToken") → "abc123"
     */
    extract(map) {
        var data = this.json();
        for (var storageKey in map) {
            var path  = map[storageKey];
            var value = _resolvePath(data, path);
            if (value !== undefined) {
                _correlationStore[storageKey] = value;
            } else {
                console.warn(`[httpx] extract: path "${path}" not found in response`);
            }
        }
        return this;
    }

    /* ── OpenAPI validation ────────────────────── */

    validateOpenAPI() {
        if (!_openApiSpec) return this;

        var pathname;
        try   { pathname = new URL(this.meta.url).pathname; }
        catch { return this; }

        var method = this.meta.method.toLowerCase();
        if (!_openApiSpec.paths || !_openApiSpec.paths[pathname]) return this;

        var spec = _openApiSpec.paths[pathname][method];
        if (!spec || !spec.responses) return this;

        var status = String(this.res.status);
        var valid  = Object.keys(spec.responses).indexOf(status) !== -1;
        var checks = {};
        checks[`OpenAPI: ${method.toUpperCase()} ${pathname} status valid`] = function() {
            return valid;
        };
        check(this.res, checks);
        return this;
    }
}

/* ═══════════════════════════════════════════════════
   CORE REQUEST FUNCTION
═══════════════════════════════════════════════════ */

function _request(method, url, body, params) {
    if (body   === undefined) body   = null;
    if (params === undefined) params = {};

    var fullUrl = url.startsWith("http") ? url : `${_defaultBaseUrl}${url}`;

    if (!params.headers) params.headers = {};
    params.headers = _session.apply(params.headers);

    // Lazy cookie jar — only instantiated inside VU context
    params.jar = _getCookieJar();

    var res;
    try {
        res = http.request(method, fullUrl, body, params);
    } catch (err) {
        _metricErrors.add(1, { method: method, url: fullUrl });
        console.error(`[httpx] Network error — ${method} ${fullUrl}: ${err.message}`);
        throw err;
    }

    var tags = { method: method, url: fullUrl, status: String(res.status) };

    _metricRequests.add(1, tags);
    _metricDuration.add(res.timings.duration, tags);
    _metricSuccess.add(res.status < 400 ? 1 : 0, tags);

    // B-06 fix: include VU and iteration so printTimeline is useful in multi-VU runs
    var _vu   = typeof __VU   !== "undefined" ? __VU   : 0;
    var _iter = typeof __ITER !== "undefined" ? __ITER : 0;
    _timeline.push({ vu: _vu, iter: _iter, method: method, url: fullUrl, status: res.status, duration: res.timings.duration });
    _reportData.push({ method: method, url: fullUrl, status: res.status, duration: res.timings.duration });

    if (res.status === 429) {
        var retryAfter = res.headers["Retry-After"];
        var delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : _rateLimitSleepMs;
        console.warn(`[httpx] 429 Too Many Requests — sleeping ${delay}ms`);
        sleep(delay / 1000);
    }

    _plugins.forEach(function(p) {
        if (typeof p.onResponse === "function") {
            try { p.onResponse(res, { method: method, url: fullUrl }); }
            catch (e) { console.warn(`[httpx] plugin error: ${e.message}`); }
        }
    });

    return new HttpxResponse(res, {
        method:  method,
        url:     fullUrl,
        headers: params.headers,
        body:    body
    });
}

/* ═══════════════════════════════════════════════════
   PARALLEL — true batch via http.batch()
═══════════════════════════════════════════════════ */

function _parallelBatch(requests) {
    var batchInput = requests.map(function(req) {
        var method = req[0];
        var url    = req[1];
        var body   = req[2] !== undefined ? req[2] : null;
        var params = req[3] !== undefined ? req[3] : {};
        if (!params.headers) params.headers = {};
        params.headers = _session.apply(params.headers);
        var fullUrl = url.startsWith("http") ? url : `${_defaultBaseUrl}${url}`;
        return [method, fullUrl, body, params];
    });

    var results = http.batch(batchInput);

    return results.map(function(res, i) {
        var method = batchInput[i][0];
        var url    = batchInput[i][1];
        var body   = batchInput[i][2];
        var params = batchInput[i][3];
        var tags   = { method: method, url: url, status: String(res.status) };
        _metricRequests.add(1, tags);
        _metricDuration.add(res.timings.duration, tags);
        _metricSuccess.add(res.status < 400 ? 1 : 0, tags);
        var _pvu   = typeof __VU   !== "undefined" ? __VU   : 0;
        var _piter = typeof __ITER !== "undefined" ? __ITER : 0;
        _timeline.push({ vu: _pvu, iter: _piter, method: method, url: url, status: res.status, duration: res.timings.duration });
        _reportData.push({ method: method, url: url, status: res.status, duration: res.timings.duration });
        return new HttpxResponse(res, { method: method, url: url, headers: params.headers, body: body });
    });
}

/* ═══════════════════════════════════════════════════
   RETRY WITH EXPONENTIAL BACKOFF
═══════════════════════════════════════════════════ */

function _retryWithBackoff(fn, options) {
    // B-04 fix: use for loop with explicit lastError — correct return in all code paths
    var opts      = options || {};
    var retries   = opts.retries   !== undefined ? opts.retries   : 3;
    var baseDelay = opts.baseDelay !== undefined ? opts.baseDelay : 1;
    var factor    = opts.factor    !== undefined ? opts.factor    : 2;
    var maxDelay  = opts.maxDelay  !== undefined ? opts.maxDelay  : 30;

    // Ensure at least 1 attempt
    if (retries < 1) retries = 1;

    var lastError;
    for (var attempt = 0; attempt < retries; attempt++) {
        try {
            // If fn() returns a value, it propagates correctly via return
            return fn();
        } catch (err) {
            lastError = err;
            if (attempt < retries - 1) {
                // Exponential backoff: delay = baseDelay * factor^attempt (capped at maxDelay)
                var delay = Math.min(baseDelay * Math.pow(factor, attempt), maxDelay);
                console.warn(
                    "[httpx] retry " + (attempt + 1) + "/" + retries +
                    " failed — waiting " + delay.toFixed(2) + "s. " + err.message
                );
                sleep(delay);
            }
        }
    }
    // All retries exhausted — throw the last error
    console.error("[httpx] retry: all " + retries + " attempts failed — " + lastError.message);
    throw lastError;
}

/* ═══════════════════════════════════════════════════
   LIFECYCLE HOOKS
═══════════════════════════════════════════════════ */

function _beforeAll(fn) {
    _hooks.beforeAll.push(fn);
}

function _afterAll(fn) {
    _hooks.afterAll.push(fn);
}

function _runHooks(phase) {
    var list = _hooks[phase] || [];
    list.forEach(function(fn) {
        try { fn(); }
        catch (err) { console.error(`[httpx] ${phase} hook error: ${err.message}`); }
    });
}

/* ═══════════════════════════════════════════════════
   REPORT BUILDER
═══════════════════════════════════════════════════ */

function _buildReport() {
    var total  = _reportData.length;
    var passed = _reportData.filter(function(r) { return r.status >= 200 && r.status < 400; }).length;
    var failed = total - passed;
    var sum    = _reportData.reduce(function(s, r) { return s + r.duration; }, 0);
    var avgMs  = total ? (sum / total).toFixed(2) : 0;
    var maxMs  = total ? Math.max.apply(null, _reportData.map(function(r) { return r.duration; })).toFixed(2) : 0;

    var rows = _reportData.map(function(r) {
        var ok  = r.status >= 200 && r.status < 400;
        var cls = ok ? "pass" : "fail";
        var sc  = ok ? "status-ok" : "status-err";
        return `<tr class="${cls}">
            <td class="method">${r.method}</td>
            <td class="url">${r.url}</td>
            <td class="${sc}">${r.status}</td>
            <td>${r.duration.toFixed(2)} ms</td>
        </tr>`;
    }).join("\n");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>k6-httpx Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", Arial, sans-serif; background: #0d1117; color: #c9d1d9; padding: 24px; }
  h1   { font-size: 1.6rem; margin-bottom: 6px; color: #58a6ff; }
  .sub { color: #8b949e; font-size: .85rem; margin-bottom: 24px; }
  .cards { display: flex; gap: 16px; margin-bottom: 28px; flex-wrap: wrap; }
  .card  { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 14px 22px; min-width: 110px; }
  .card .label { font-size: .72rem; color: #8b949e; text-transform: uppercase; letter-spacing: .06em; }
  .card .value { font-size: 1.8rem; font-weight: bold; margin-top: 4px; }
  .blue   { color: #58a6ff; } .green { color: #3fb950; }
  .red    { color: #f85149; } .yellow{ color: #d29922; }
  table   { width: 100%; border-collapse: collapse; font-size: .88rem; }
  thead th { background: #161b22; border: 1px solid #30363d; padding: 10px 14px; text-align: left; color: #8b949e; }
  tbody td { border: 1px solid #21262d; padding: 9px 14px; }
  .pass td { background: rgba(63,185,80,.04); }
  .fail td { background: rgba(248,81,73,.06); }
  .method     { font-weight: 700; font-family: monospace; color: #79c0ff; }
  .url        { font-family: monospace; font-size: .82rem; }
  .status-ok  { color: #3fb950; font-weight: bold; }
  .status-err { color: #f85149; font-weight: bold; }
</style>
</head>
<body>
<h1>k6-httpx Report</h1>
<p class="sub">Generated: ${new Date().toISOString()}</p>
<div class="cards">
  <div class="card"><div class="label">Total</div><div class="value blue">${total}</div></div>
  <div class="card"><div class="label">Passed</div><div class="value green">${passed}</div></div>
  <div class="card"><div class="label">Failed</div><div class="value red">${failed}</div></div>
  <div class="card"><div class="label">Avg</div><div class="value yellow">${avgMs} ms</div></div>
  <div class="card"><div class="label">Max</div><div class="value yellow">${maxMs} ms</div></div>
</div>
<table>
  <thead><tr><th>Method</th><th>URL</th><th>Status</th><th>Duration</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</body>
</html>`;
}

/* ═══════════════════════════════════════════════════
   PUBLIC API
═══════════════════════════════════════════════════ */

export const httpx = {

    /* ── HTTP Methods ──────────────────────────── */

    get:    function(url, params)       { return _request("GET",    url, null, params); },
    post:   function(url, body, params) { return _request("POST",   url, body, params); },
    put:    function(url, body, params) { return _request("PUT",    url, body, params); },
    patch:  function(url, body, params) { return _request("PATCH",  url, body, params); },
    delete: function(url, params)       { return _request("DELETE", url, null, params); },
    head:   function(url, params)       { return _request("HEAD",   url, null, params); },

    /* ── Session / Auth ────────────────────────── */

    session: {
        setToken:   function(token, header, prefix) { _session.setToken(token, header, prefix); },
        setHeader:  function(name, value)            { _session.setHeader(name, value); },
        clearToken: function()                       { _session.clearToken(); }
    },

    /* ── Config ────────────────────────────────── */

    /**
     * Sets a base URL for all relative-path requests.
     * httpx.baseUrl("https://api.myapp.com")
     * httpx.get("/users") → GET https://api.myapp.com/users
     */
    baseUrl: function(url) {
        _defaultBaseUrl = url.replace(/\/$/, "");
    },

    /**
     * Sets the default sleep (ms) when a 429 is received
     * and no Retry-After header is present.
     */
    setRateLimitSleep: function(ms) {
        _rateLimitSleepMs = ms;
    },

    /* ── URL Builder ───────────────────────────── */

    /**
     * Builds a URL with query params.
     * httpx.buildUrl("/users", { page: 1, limit: 10 })
     * → "https://base.com/users?page=1&limit=10"
     */
    buildUrl: _buildUrl,

    /* ── Env vars ──────────────────────────────── */

    /**
     * Reads a k6 -e environment variable with an optional default.
     * httpx.env("BASE_URL", "http://localhost:3000")
     */
    env: _env,

    /* ── Correlation ───────────────────────────── */

    /**
     * Reads a value previously stored with .extract().
     * httpx.var("authToken")
     */
    var: function(name) { return _correlationStore[name]; },

    /* ── Custom Metrics ────────────────────────── */

    /**
     * Declares a custom Trend metric in the init context.
     * MUST be called at the TOP LEVEL of your script (outside default/setup/teardown).
     *
     * // In your script (init context):
     * httpx.declareMetric("checkout_ms");
     *
     * // Then inside default():
     * httpx.metric("checkout_ms", res.duration(), { endpoint: "checkout" });
     */
    declareMetric: function(name) {
        _declareMetric(name);
    },

    /**
     * Records a value to a previously declared metric.
     * Throws a clear error if declareMetric() was not called first.
     *
     * httpx.metric("checkout_ms", res.duration(), { region: "us-east" })
     */
    metric: function(name, value, tags) {
        _recordMetric(name, value, tags);
    },

    /* ── Step / Scenario / Run ─────────────────── */

    step: function(name, fn) {
        console.log(`\n▶ STEP: ${name}`);
        var start  = Date.now();
        var result = fn();
        console.log(`✔ END  [${name}] — ${Date.now() - start}ms`);
        return result;
    },

    scenario: function(name, fn) {
        console.log(`\n══ SCENARIO: ${name} ══`);
        return fn();
    },

    run: function(name, fn) {
        console.log(`\n▶▶ RUN: ${name}`);
        var start  = Date.now();
        var result = fn();
        console.log(`✔✔ TOTAL [${name}] — ${Date.now() - start}ms`);
        return result;
    },

    /* ── Parallel ──────────────────────────────── */

    parallel: _parallelBatch,

    /* ── Retry ─────────────────────────────────── */

    retry: _retryWithBackoff,

    /* ── Data-driven ───────────────────────────── */

    /**
     * Runs fn once per item in dataset.
     * httpx.data(users, (u) => httpx.post("/login", u).expectStatus(200))
     */
    data: function(dataset, fn) {
        dataset.forEach(fn);
    },

    /* ── Multipart ─────────────────────────────── */

    /**
     * Returns fields as-is for multipart/form-data.
     * k6 handles plain objects as form-data automatically.
     */
    multipart: function(fields) {
        return fields;
    },

    /* ── Lifecycle Hooks ───────────────────────── */

    beforeAll: _beforeAll,
    afterAll:  _afterAll,
    runHooks:  _runHooks,

    /* ── Plugins ───────────────────────────────── */

    use: function(plugin) {
        _plugins.push(plugin);
    },

    /* ── OpenAPI ───────────────────────────────── */

    openapi: function(spec) {
        _openApiSpec = spec;
    },

    /* ── Timeline ──────────────────────────────── */

    printTimeline: function() {
        // B-06 fix: group by VU and show iter number
        console.log("\n── TIMELINE ─────────────────────────────────────────");
        var byVu = {};
        _timeline.forEach(function(t) {
            var key = "VU" + (t.vu || 0);
            if (!byVu[key]) byVu[key] = [];
            byVu[key].push(t);
        });
        var vuKeys = Object.keys(byVu).sort();
        vuKeys.forEach(function(vuKey) {
            console.log("  " + vuKey + ":");
            byVu[vuKey].forEach(function(t) {
                var mark = t.status < 400 ? "✔" : "✘";
                var iter = t.iter !== undefined ? " [iter " + t.iter + "]" : "";
                console.log(
                    "    " + mark + " " + t.method.padEnd(7) +
                    " " + t.status +
                    "  " + t.duration.toFixed(1) + "ms" +
                    iter +
                    "  " + t.url
                );
            });
        });
        console.log("─────────────────────────────────────────────────────");
        console.log("  Total: " + _timeline.length + " requests");
    },

    /* ── Cookie Jar ────────────────────────────── */

    get cookies() {
        return _getCookieJar();
    },

    /* ── Report ────────────────────────────────── */

    /**
     * Logs the full HTML report to stdout.
     * Capture it with: k6 run script.js 2>&1 | grep -A9999 "<!DOCTYPE" > report.html
     */
    report: function() {
        console.log(_buildReport());
    },

    /**
     * Returns the raw HTML report string.
     * Use this in teardown() to write the file via k6's experimental/fs.
     */
    reportHtml: function() {
        return _buildReport();
    },

    /* ── Export ────────────────────────────────────── */

    /**
     * Exports all collected request data as a structured object.
     * Use with handleSummary + dashboard plugin:
     *
     *   import { htmlReport } from "./helpers/k6.httpx.dashboard.js";
     *   export function handleSummary(data) {
     *     return { "report.html": htmlReport(data, { script: "my-script.js" }) };
     *   }
     *
     * Returns: { meta, requests, metricNames }
     */
    exportResults: function() {
        var total  = _reportData.length;
        var passed = 0;
        var failed = 0;
        var sorted = [];

        for (var i = 0; i < _reportData.length; i++) {
            var r = _reportData[i];
            if (r.status >= 200 && r.status < 400) { passed++; } else { failed++; }
            sorted.push(r.duration);
        }
        sorted.sort(function(a, b) { return a - b; });

        function pct(p) {
            if (!sorted.length) return 0;
            var idx = Math.ceil((p / 100) * sorted.length) - 1;
            return sorted[idx < 0 ? 0 : idx];
        }

        var sum  = 0;
        for (var j = 0; j < sorted.length; j++) sum += sorted[j];
        var avgMs = total ? sum / total : 0;

        var metricNames = [];
        for (var name in _customMetrics) { metricNames.push(name); }

        return {
            meta: {
                generatedAt:   new Date().toISOString(),
                totalRequests: total,
                passed:        passed,
                failed:        failed,
                passRate:      total ? parseFloat((passed / total * 100).toFixed(2)) : 0,
                failRate:      total ? parseFloat((failed / total * 100).toFixed(2)) : 0,
                avgMs:         parseFloat(avgMs.toFixed(2)),
                minMs:         total ? parseFloat(sorted[0].toFixed(2)) : 0,
                maxMs:         total ? parseFloat(sorted[sorted.length - 1].toFixed(2)) : 0,
                p50Ms:         parseFloat(pct(50).toFixed(2)),
                p90Ms:         parseFloat(pct(90).toFixed(2)),
                p95Ms:         parseFloat(pct(95).toFixed(2)),
                p99Ms:         parseFloat(pct(99).toFixed(2)),
            },
            requests:    _reportData.slice(),
            metricNames: metricNames,
        };
    }

};
