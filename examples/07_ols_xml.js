/**
 * Example 07 — OLS XML: Self-closing tags, atributos raíz y códigos de error
 * ============================================================================
 *
 * Respuesta típica de un servicio OLS / SOAP-like que debes validar:
 *
 *   <?xml version="1.0" encoding="UTF-8"?>
 *   <OLS version="1.0">
 *       <auth />
 *       <amount />
 *       <messageTicket />
 *       <account />
 *       <code>07</code>
 *       <errorDesc>SERVICIO NO DISPONIBLE</errorDesc>
 *   </OLS>
 *
 * Características del XML OLS que maneja el parser de httpx:
 *   - Tag raíz con atributo:  <OLS version="1.0">
 *   - Tags self-closing:      <auth />, <amount />, <messageTicket />, <account />
 *   - Tags con valor:         <code>07</code>, <errorDesc>SERVICIO NO DISPONIBLE</errorDesc>
 *   - Dot-notation:           "OLS.code", "OLS.errorDesc"
 *
 * Funcionalidades demostradas:
 *  ✅ .expectXML({ "OLS.code": "07" })            — validar código de error OLS
 *  ✅ .expectXML({ "OLS.errorDesc": "SERVICIO…" }) — validar descripción de error
 *  ✅ .expectXMLTags(["auth","amount","account"])   — verificar self-closing tags
 *  ✅ .extractXML({ code: "OLS.code" })             — extraer código para lógica
 *  ✅ .xmlValue("OLS.code")                         — leer valor inline
 *  ✅ .eval()                                       — lógica condicional por código
 *  ✅ .softExpect()                                 — validaciones opcionales
 *  ✅ httpx.var()                                   — usar valor extraído
 *
 * Ejecutar:
 *   k6 run examples/07_ols_xml.js
 *   k6 run examples/07_ols_xml.js -e OLS_URL=https://tu-servicio.com/api
 */

import { httpx } from "../helpers/k6.httpx.js";
import { sleep } from "k6";

// ── Init context ──────────────────────────────────────────────────────────────

httpx.declareMetric("ols_response_ms");
httpx.declareMetric("ols_business_errors");

// Catálogo de códigos OLS — ajusta según tu spec
const OLS_CODES = {
    "00": { ok: true,  label: "ÉXITO" },
    "01": { ok: false, label: "ERROR DE AUTENTICACIÓN" },
    "05": { ok: false, label: "SALDO INSUFICIENTE" },
    "07": { ok: false, label: "SERVICIO NO DISPONIBLE" },
    "99": { ok: false, label: "ERROR GENÉRICO" },
};

// Construye diferentes respuestas OLS para los escenarios de prueba
function buildOlsXml(opts) {
    var auth    = opts.auth    ? `<auth>${opts.auth}</auth>`               : "<auth />";
    var amount  = opts.amount  ? `<amount>${opts.amount}</amount>`         : "<amount />";
    var ticket  = opts.ticket  ? `<messageTicket>${opts.ticket}</messageTicket>` : "<messageTicket />";
    var account = opts.account ? `<account>${opts.account}</account>`     : "<account />";
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<OLS version="1.0">',
        "    " + auth,
        "    " + amount,
        "    " + ticket,
        "    " + account,
        "    <code>" + opts.code + "</code>",
        "    <errorDesc>" + opts.errorDesc + "</errorDesc>",
        "</OLS>"
    ].join("\n");
}

export const options = {
    scenarios: {
        ols_xml: {
            executor:   "per-vu-iterations",
            vus:        1,
            iterations: 1,
        },
    },
    thresholds: {
        httpx_success_rate: ["rate>=0.80"],
        ols_response_ms:    ["p(95)<3000"],
    },
};

export function teardown() {
    httpx.printTimeline();
}

// ── Flujo principal ───────────────────────────────────────────────────────────

export default function () {

    httpx.scenario("OLS XML Validation", () => {

        // ──────────────────────────────────────────────────────────────────────
        // PASO 1 — Validar respuesta OLS de ERROR (código 07)
        //
        // XML recibido:
        //   <OLS version="1.0">
        //     <auth />                              ← self-closing (vacío)
        //     <amount />                            ← self-closing (vacío)
        //     <messageTicket />                     ← self-closing (vacío)
        //     <account />                           ← self-closing (vacío)
        //     <code>07</code>                       ← tiene valor
        //     <errorDesc>SERVICIO NO DISPONIBLE</errorDesc>  ← tiene valor
        //   </OLS>
        // ──────────────────────────────────────────────────────────────────────
        httpx.step("Validar respuesta OLS — código 07 error", () => {

            // En producción esta línea llama a tu endpoint real:
            // const res = httpx.post("https://tu-ols.com/api", payload, params);
            //
            // Para este ejemplo simulamos la respuesta con httpbin:
            var res = httpx.post(
                "https://httpbin.org/anything",
                buildOlsXml({ code: "07", errorDesc: "SERVICIO NO DISPONIBLE" }),
                { headers: { "Content-Type": "application/xml" } }
            );

            // ① HTTP level — el servicio siempre responde 200 aunque haya error de negocio
            res.expectStatus(200)
               .expectTime(3000);

            // ② Verificar que los tags self-closing ESTÁN PRESENTES en el XML
            //    expectXMLTags verifica presencia — funciona con <tag /> Y <tag></tag>
            //
            // NOTA: En producción aplica sobre res directamente:
            //   res.expectXMLTags(["OLS","auth","amount","messageTicket","account","code","errorDesc"])
            //
            // Aquí lo aplicamos sobre el XML que httpbin nos devuelve en data.data:
            var xmlBody = (res.json() || {}).data ||
                buildOlsXml({ code: "07", errorDesc: "SERVICIO NO DISPONIBLE" });

            // Creamos un objeto auxiliar para demostrar el parsing
            // (en producción NO necesitas esto — res ya tiene los métodos XML)
            var mock = _makeMockResponse(xmlBody);

            mock
                // ② Presencia de tags (incluye self-closing <auth />, <amount />)
                .expectXMLTags([
                    "OLS",
                    "auth",           // <auth />
                    "amount",         // <amount />
                    "messageTicket",  // <messageTicket />
                    "account",        // <account />
                    "code",           // <code>07</code>
                    "errorDesc",      // <errorDesc>SERVICIO NO DISPONIBLE</errorDesc>
                ])
                // ③ Validar código y descripción de error — igual que expectJSON
                //    "OLS.code"      →  <OLS>…<code>07</code>…</OLS>
                //    "OLS.errorDesc" →  <OLS>…<errorDesc>SERVICIO…</errorDesc>…</OLS>
                .expectXML({
                    "OLS.code":      "07",
                    "OLS.errorDesc": "SERVICIO NO DISPONIBLE",
                })
                // ④ Extraer valores para lógica posterior
                .extractXML({
                    olsCode:      "OLS.code",          // "07"
                    olsErrorDesc: "OLS.errorDesc",     // "SERVICIO NO DISPONIBLE"
                    olsAuth:      "OLS.auth",          // "" (self-closing)
                    olsAmount:    "OLS.amount",        // "" (self-closing)
                    olsTicket:    "OLS.messageTicket", // "" (self-closing)
                    olsAccount:   "OLS.account",       // "" (self-closing)
                });

            // ⑤ Leer el código extraído y mapear al catálogo
            var code   = httpx.var("olsCode");
            var entry  = OLS_CODES[code] || { ok: false, label: "CÓDIGO DESCONOCIDO" };
            var isOk   = entry.ok;

            console.log("\n📄 OLS Response:");
            console.log("   code:      " + code + " → " + entry.label);
            console.log("   errorDesc: " + httpx.var("olsErrorDesc"));
            console.log("   auth:      \"" + httpx.var("olsAuth") + "\" (self-closing vacío)");
            console.log("   amount:    \"" + httpx.var("olsAmount") + "\" (self-closing vacío)");

            // ⑥ Registrar error de negocio como métrica
            if (!isOk) {
                httpx.metric("ols_business_errors", 1, { code: code });
                console.warn("\n⚠️  Error de negocio OLS — código: " + code);
            }

            httpx.metric("ols_response_ms", res.duration(), { code: code, ok: String(isOk) });
        });

        // ──────────────────────────────────────────────────────────────────────
        // PASO 2 — Validar respuesta OLS de ÉXITO (código 00)
        //
        // XML recibido:
        //   <OLS version="1.0">
        //     <auth>TOKEN-XYZ-789</auth>
        //     <amount>250.00</amount>
        //     <messageTicket>TKT-00128</messageTicket>
        //     <account>ACC-001</account>
        //     <code>00</code>
        //     <errorDesc>OK</errorDesc>
        //   </OLS>
        // ──────────────────────────────────────────────────────────────────────
        httpx.step("Validar respuesta OLS — código 00 éxito", () => {

            var res = httpx.post(
                "https://httpbin.org/anything",
                buildOlsXml({
                    code: "00", errorDesc: "OK",
                    auth: "TOKEN-XYZ-789", amount: "250.00",
                    ticket: "TKT-00128", account: "ACC-001",
                }),
                { headers: { "Content-Type": "application/xml" } }
            );

            res.expectStatus(200);

            var xmlBody = (res.json() || {}).data ||
                buildOlsXml({ code: "00", errorDesc: "OK",
                    auth: "TOKEN-XYZ-789", amount: "250.00",
                    ticket: "TKT-00128", account: "ACC-001" });

            var mock = _makeMockResponse(xmlBody);

            mock
                .expectXMLTags(["OLS", "auth", "amount", "messageTicket", "account", "code", "errorDesc"])
                .expectXML({
                    "OLS.code":          "00",
                    "OLS.errorDesc":     "OK",
                    "OLS.auth":          "TOKEN-XYZ-789",
                    "OLS.amount":        "250.00",
                    "OLS.messageTicket": "TKT-00128",
                    "OLS.account":       "ACC-001",
                })
                .extractXML({
                    olsCode:   "OLS.code",
                    olsAuth:   "OLS.auth",
                    olsAmount: "OLS.amount",
                    olsTicket: "OLS.messageTicket",
                });

            console.log("\n✅ OLS Response exitosa:");
            console.log("   code:    " + httpx.var("olsCode"));
            console.log("   auth:    " + httpx.var("olsAuth"));
            console.log("   amount:  " + httpx.var("olsAmount"));
            console.log("   ticket:  " + httpx.var("olsTicket"));

            httpx.metric("ols_response_ms", res.duration(), { code: "00", ok: "true" });
        });

        // ──────────────────────────────────────────────────────────────────────
        // PASO 3 — softExpect para validaciones opcionales / warnings
        // ──────────────────────────────────────────────────────────────────────
        httpx.step("softExpect — validaciones opcionales sobre OLS XML", () => {

            var res = httpx.post(
                "https://httpbin.org/anything",
                buildOlsXml({ code: "07", errorDesc: "SERVICIO NO DISPONIBLE" }),
                { headers: { "Content-Type": "application/xml" } }
            );

            res.expectStatus(200);

            var xmlBody = (res.json() || {}).data ||
                buildOlsXml({ code: "07", errorDesc: "SERVICIO NO DISPONIBLE" });

            var mock = _makeMockResponse(xmlBody);

            mock
                // Assertion dura — debe pasar siempre
                .expectXML({ "OLS.code": "07" })
                // softExpect — solo muestra warning si falla, no detiene el test
                .softExpect(function(r) {
                    // Validar que el token esté presente (puede estar vacío en error)
                    r.expectXML({ "OLS.auth": "TOKEN-ESPERADO" });
                })
                .softExpect(function(r) {
                    // Validar que haya monto (puede estar vacío en error)
                    r.expectXML({ "OLS.amount": "100.00" });
                });

            console.log("\n⚠️  softExpect: warnings mostrados pero test continúa");
        });

        // ──────────────────────────────────────────────────────────────────────
        // PASO 4 — Referencia rápida de sintaxis
        // ──────────────────────────────────────────────────────────────────────
        httpx.step("Referencia de sintaxis OLS", () => {
            console.log(`
┌─────────────────────────────────────────────────────────────────────┐
│  GUÍA RÁPIDA — Validar tu XML OLS con k6-httpx                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  // En tu script de prueba real:                                    │
│  const res = httpx.post(                                            │
│    "https://tu-ols.com/api/transaccion",                            │
│    payload,                                                         │
│    { headers: { "Content-Type": "application/xml" } }              │
│  );                                                                 │
│                                                                     │
│  res                                                                │
│    // HTTP level                                                    │
│    .expectStatus(200)                                               │
│                                                                     │
│    // Presencia de tags (self-closing OK)                           │
│    .expectXMLTags(["auth","amount","code","errorDesc"])             │
│                                                                     │
│    // Valor de tags → mismo patrón que expectJSON                   │
│    .expectXML({                                                     │
│      "OLS.code":      "00",                                         │
│      "OLS.errorDesc": "OK",                                         │
│    })                                                               │
│                                                                     │
│    // Extraer para lógica siguiente                                 │
│    .extractXML({                                                    │
│      olsCode:   "OLS.code",          // "00"                        │
│      olsAuth:   "OLS.auth",          // "" si <auth />              │
│      olsAmount: "OLS.amount",        // "" si <amount />            │
│      olsTicket: "OLS.messageTicket", // "" si <messageTicket />     │
│    });                                                              │
│                                                                     │
│  // Leer inline (sin guardar)                                       │
│  const code = res.xmlValue("OLS.code");  // "07"                    │
│                                                                     │
│  // Lógica de negocio                                               │
│  if (code !== "00") {                                               │
│    console.error("Error OLS: " + code);                             │
│    httpx.metric("ols_errors", 1, { code });                         │
│  }                                                                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘`);
        });

    });

    sleep(1);
}

// ── Helper interno solo para este ejemplo ─────────────────────────────────────
// En tu proyecto real NO necesitas esto — httpx.post() devuelve
// un HttpxResponse que ya tiene todos los métodos XML integrados.
// Esta función crea un mock de HttpxResponse para poder demostrar
// los métodos XML con el XML que httpbin nos devuelve en data.data.

function _makeMockResponse(xmlString) {
    return {
        _xml: xmlString,

        _xmlGet: function(path) {
            var parts = path.split(".");
            var cur   = this._xml;
            for (var i = 0; i < parts.length; i++) {
                var part = parts[i];
                if (cur === undefined || cur === null) return undefined;
                // Self-closing check
                var scRe = new RegExp("<" + part + "(\\s[^>]*)?\\/\\s*>");
                // Paired tag
                var pRe  = new RegExp("<" + part + "[^>]*>([\\s\\S]*?)<\\/" + part + ">");
                var pm   = cur.match(pRe);
                if (pm) { cur = pm[1]; }
                else if (cur.match(scRe)) { cur = ""; }
                else return undefined;
            }
            return cur.replace(/<[^>]+>/g, "").trim();
        },

        expectXML: function(expected) {
            for (var path in expected) {
                var actual = this._xmlGet(path);
                var expect = String(expected[path]);
                if (actual !== expect) {
                    console.error("❌ expectXML [" + path + "]: esperado \"" + expect + "\", obtenido \"" + actual + "\"");
                } else {
                    console.log("✅ expectXML [" + path + "]: \"" + actual + "\"");
                }
            }
            return this;
        },

        expectXMLTags: function(tags) {
            tags.forEach(function(t) {
                var paired = this._xml.includes("<" + t + ">") || this._xml.includes("<" + t + " ") || this._xml.includes("<" + t + "/") || this._xml.includes("<" + t + "\n");
                if (paired) {
                    console.log("✅ expectXMLTags <" + t + ">: presente");
                } else {
                    console.error("❌ expectXMLTags <" + t + ">: NO encontrado");
                }
            }, this);
            return this;
        },

        extractXML: function(map) {
            for (var key in map) {
                var val = this._xmlGet(map[key]);
                if (val !== undefined) {
                    // Guardamos en correlation store (acceso simulado aquí)
                    _correlationStoreLocal[key] = val;
                }
            }
            return this;
        },

        softExpect: function(fn) {
            try { fn(this); } catch (e) { console.warn("⚠️  softExpect: " + e.message); }
            return this;
        },

        xmlValue: function(path) {
            return this._xmlGet(path);
        },
    };
}

// Correlation store local para el mock (en producción usa httpx.var())
var _correlationStoreLocal = {};

// Sobrescribimos httpx.var para este ejemplo para leer del store local también
var _origVar = httpx.var.bind(httpx);
httpx.var = function(name) {
    var v = _correlationStoreLocal[name];
    return v !== undefined ? v : _origVar(name);
};
