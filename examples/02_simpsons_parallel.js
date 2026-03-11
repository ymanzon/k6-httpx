/**
 * Example 02 — Simpsons API + ReqRes: Paralelismo, Retry y Sesión
 * ================================================================
 * APIs:
 *  - https://thesimpsonsquoteapi.glitch.me  (quotes)
 *  - https://reqres.in/api                  (auth simulada)
 *
 * Funcionalidades demostradas:
 *  ✅ httpx.beforeAll() / afterAll()   — hooks de ciclo de vida
 *  ✅ httpx.runHooks()                 — ejecución en setup/teardown
 *  ✅ httpx.session.setToken()         — token global de sesión
 *  ✅ httpx.session.setHeader()        — header personalizado global
 *  ✅ httpx.session.clearToken()       — limpiar sesión
 *  ✅ httpx.parallel()                 — requests concurrentes (http.batch)
 *  ✅ httpx.retry()                    — reintento con backoff exponencial
 *  ✅ .softExpect()                    — assertion que no detiene el test
 *  ✅ .expectHeader()                  — verificar header de respuesta
 *  ✅ .debug()                         — imprimir request+response completos
 *  ✅ httpx.printTimeline()            — resumen al final
 *
 * Ejecutar:
 *   k6 run examples/02_simpsons_parallel.js
 *   k6 run examples/02_simpsons_parallel.js --vus 2 --iterations 4
 */

import { httpx } from "../helpers/k6.httpx.js";
import { sleep } from "k6";

// ── Init context ──────────────────────────────────────────────────────────────

// beforeAll se ejecuta una sola vez en setup()
// Ideal para login, obtener tokens, preparar datos
httpx.beforeAll(() => {
    console.log("\n🔐 beforeAll: autenticando en ReqRes...");

    // Hacemos login para obtener un token real de la API de ReqRes
    const res = httpx.post(
        "https://reqres.in/api/login",
        JSON.stringify({ email: "eve.holt@reqres.in", password: "cityslicka" }),
        { headers: { "Content-Type": "application/json" } }
    );

    if (res.ok()) {
        const token = res.json().token;
        // Guarda el token globalmente — se añadirá a todos los requests siguientes
        httpx.session.setToken(token);
        // Podemos agregar headers personalizados globales
        httpx.session.setHeader("X-Test-Suite", "k6-httpx-example");
        console.log(`\n✅ Token obtenido: ${token}`);
    } else {
        console.error(`\n❌ Login fallido: ${res.status()}`);
    }
});

// afterAll se ejecuta en teardown() — ideal para limpieza
httpx.afterAll(() => {
    console.log("\n🧹 afterAll: limpiando sesión...");
    httpx.session.clearToken();
    httpx.printTimeline();
    console.log("\n✅ Sesión limpiada");
});

export const options = {
    scenarios: {
        simpsons_flow: {
            executor:   "per-vu-iterations",
            vus:        1,
            iterations: 1,
        },
    },
    thresholds: {
        httpx_success_rate: ["rate>=0.90"],
        http_req_duration:  ["p(95)<5000"],
    },
};

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export function setup() {
    // Ejecuta los hooks registrados con httpx.beforeAll()
    httpx.runHooks("beforeAll");
}

export function teardown() {
    // Ejecuta los hooks registrados con httpx.afterAll()
    httpx.runHooks("afterAll");
}

// ── Flujo principal ───────────────────────────────────────────────────────────

export default function () {

    httpx.scenario("The Simpsons Quote Fest", () => {

        // ── Paso 1: Requests en paralelo con http.batch() ─────────────────────
        httpx.step("Obtener quotes en paralelo", () => {

            console.log("\n⚡ Lanzando 4 requests en paralelo...");

            // parallel() usa http.batch() internamente — requests verdaderamente concurrentes
            // Cada item: [method, url, body?, params?]
            const [q1, q2, q3, q4] = httpx.parallel([
                ["GET", "https://thesimpsonsquoteapi.glitch.me/quotes?count=1"],
                ["GET", "https://thesimpsonsquoteapi.glitch.me/quotes?count=1"],
                ["GET", "https://thesimpsonsquoteapi.glitch.me/quotes?count=1"],
                ["GET", "https://thesimpsonsquoteapi.glitch.me/quotes?count=1"],
            ]);

            // Validamos cada respuesta de forma independiente
            q1.expectStatus(200);
            q2.expectStatus(200);
            q3.expect2xx();
            q4.expectTime(3000);

            // Mostramos las frases obtenidas
            [q1, q2, q3, q4].forEach((r, i) => {
                const quote = r.json();
                if (quote && quote[0]) {
                    console.log(`\n  🍩 Quote ${i + 1}: "${quote[0].quote}" — ${quote[0].character}`);
                }
            });
        });

        // ── Paso 2: Retry con backoff exponencial ─────────────────────────────
        httpx.step("Fetch con retry automático", () => {

            console.log("\n🔄 Intentando con retry (backoff exponencial)...");

            // retry() reintenta la función si lanza una excepción
            // baseDelay=0.5s, factor=2 → delays: 0.5s, 1s, 2s
            const res = httpx.retry(
                () => {
                    const r = httpx.get("https://thesimpsonsquoteapi.glitch.me/quotes?count=3");
                    // Si falla el status, lanza excepción y retry lo reintenta
                    if (r.status() !== 200) throw new Error(`status ${r.status()}`);
                    return r;
                },
                { retries: 3, baseDelay: 0.5, factor: 2, maxDelay: 5 }
            );

            // contract() con respuesta array → valida el primer elemento automáticamente
            res.contract({
                quote:     "string",
                character: "string",
                image:     "string",
            });

            console.log(`\n✅ Retry exitoso — ${res.json().length} quotes obtenidas`);
        });

        // ── Paso 3: softExpect — assertion que no detiene el test ─────────────
        httpx.step("Verificación suave de headers", () => {

            const res = httpx.get("https://thesimpsonsquoteapi.glitch.me/quotes?count=1");

            res
                // softExpect NO falla el test si la assertion falla — solo muestra warning
                // Útil para validaciones opcionales o en ambientes inestables
                .softExpect(r => r.expectHeader("Content-Type", "application/json"))
                .softExpect(r => r.expectTime(500))    // warning si tarda más de 500ms
                .expect2xx();                           // esta sí es una assertion dura

            // .ok() retorna true si status es 2xx
            console.log(`\n💚 Request OK: ${res.ok()} | Status: ${res.status()}`);
        });

        // ── Paso 4: Verificar autenticación con ReqRes ────────────────────────
        httpx.step("Verificar sesión autenticada", () => {

            // El token seteado en beforeAll se añade automáticamente
            // via httpx.session — no necesitamos pasarlo manualmente
            const res = httpx.get("https://reqres.in/api/users/2");

            res
                .expectStatus(200)
                .contract({
                    "data.id":         "number",
                    "data.email":      "string",
                    "data.first_name": "string",
                })
                // .extract() con dot-notation anidada
                .extract({
                    userEmail: "data.email",
                    userFirst: "data.first_name",
                });

            console.log(`\n👤 Usuario: ${httpx.var("userFirst")} (${httpx.var("userEmail")})`);
        });

        // ── Paso 5: debug() — imprime request + response completos ────────────
        httpx.step("Debug completo de un request", () => {

            console.log("\n🔍 Modo debug activado:");
            httpx.get("https://reqres.in/api/users?page=1")
                .expect2xx()
                // debug() imprime JSON completo del request y la respuesta
                .debug();
        });

    });

    sleep(1);
}
