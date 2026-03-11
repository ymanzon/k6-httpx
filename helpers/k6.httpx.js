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
        if (this.token) {
            headers[this.header] = `${this.prefix} ${this.token}`.trim();
        }
        Object.assign(headers, this.extraHeaders);
        return headers;
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
    return path.split(".").reduce(function(acc, key) {
        if (acc === null || acc === undefined) return undefined;
        var rootIdx = key.match(/^\[(\d+)\]$/);
        if (rootIdx) {
            return Array.isArray(acc) ? acc[parseInt(rootIdx[1], 10)] : undefined;
        }
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

    /* ── XML assertion ─────────────────────────── */

    expectXML(tags) {
        var body   = this.text();
        var checks = {};
        tags.forEach(function(t) {
            checks[`xml <${t}> present`] = function() { return body.includes(`<${t}>`); };
        });
        check(body, checks);
        return this;
    }

    /* ── Contract ──────────────────────────────── */

    /**
     * Validates the JSON response shape against a type schema.
     *
     * - OBJECT response  → validates keys directly.
     * - ARRAY  response  → validates the FIRST element automatically.
     *   (covers list endpoints: GET /users → [{ id, name }, ...])
     *
     * Supported types: "string" | "number" | "boolean" | "object" | "array" | "null" | "any"
     *
     * httpx.get("/users").contract({ id: "number", name: "string" })
     * httpx.get("/users/1").contract({ id: "number", name: "string" })
     */
    contract(schema) {
        var raw = this.json();

        if (raw === null || raw === undefined) {
            throw new Error("contract: response body is empty or not valid JSON");
        }

        if (Array.isArray(raw)) {
            if (raw.length === 0) {
                console.warn("[httpx] contract: empty array response, schema not validated");
                return this;
            }
            var item = raw[0];
            for (var k in schema) {
                var value    = _resolvePath(item, k);
                var expected = schema[k];
                if (!_validateType(value, expected)) {
                    throw new Error(
                        `contract violation at [0]: "${k}" expected ${expected}, got ${_typeName(value)}`
                    );
                }
            }
            return this;
        }

        if (typeof raw !== "object") {
            throw new Error(`contract: expected object or array, got ${typeof raw}`);
        }

        for (var k in schema) {
            var value    = _resolvePath(raw, k);
            var expected = schema[k];
            if (!_validateType(value, expected)) {
                throw new Error(
                    `contract violation: "${k}" expected ${expected}, got ${_typeName(value)}`
                );
            }
        }
        return this;
    }

    /**
     * Validates that the response is an array AND that EVERY element
     * matches the schema.
     *
     * httpx.get("/users").contractArray({ id: "number", name: "string" })
     */
    contractArray(schema) {
        var data = this.json();

        if (!Array.isArray(data)) {
            throw new Error(`contractArray: expected array, got ${typeof data}`);
        }

        data.forEach(function(item, index) {
            for (var k in schema) {
                var value    = _resolvePath(item, k);
                var expected = schema[k];
                if (!_validateType(value, expected)) {
                    throw new Error(
                        `contractArray violation at [${index}]: "${k}" expected ${expected}, got ${_typeName(value)}`
                    );
                }
            }
        });
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

    _timeline.push({ method: method, url: fullUrl, status: res.status, duration: res.timings.duration });
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
        _timeline.push({ method: method, url: url, status: res.status, duration: res.timings.duration });
        _reportData.push({ method: method, url: url, status: res.status, duration: res.timings.duration });
        return new HttpxResponse(res, { method: method, url: url, headers: params.headers, body: body });
    });
}

/* ═══════════════════════════════════════════════════
   RETRY WITH EXPONENTIAL BACKOFF
═══════════════════════════════════════════════════ */

function _retryWithBackoff(fn, options) {
    if (options === undefined) options = {};
    var retries   = options.retries   !== undefined ? options.retries   : 3;
    var baseDelay = options.baseDelay !== undefined ? options.baseDelay : 1;
    var factor    = options.factor    !== undefined ? options.factor    : 2;
    var maxDelay  = options.maxDelay  !== undefined ? options.maxDelay  : 30;

    var attempt = 0;
    while (attempt < retries) {
        try {
            return fn();
        } catch (err) {
            attempt++;
            if (attempt >= retries) {
                console.error(`[httpx] retry: all ${retries} attempts failed — ${err.message}`);
                throw err;
            }
            var delay = Math.min(baseDelay * Math.pow(factor, attempt - 1), maxDelay);
            console.warn(`[httpx] retry attempt ${attempt}/${retries} — waiting ${delay.toFixed(2)}s`);
            sleep(delay);
        }
    }
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
        console.log("\n── TIMELINE ─────────────────────────────");
        _timeline.forEach(function(t) {
            var mark = t.status < 400 ? "✔" : "✘";
            console.log(`  ${mark} ${t.method.padEnd(7)} ${t.status}  ${t.duration.toFixed(1)}ms  ${t.url}`);
        });
        console.log("─────────────────────────────────────────");
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
    }

};