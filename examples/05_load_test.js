/**
 * Example 05 — Flujo Completo de Carga: Pokemon + ReqRes
 * =======================================================
 * Un test de carga realista que combina TODAS las funcionalidades
 * de k6-httpx en un escenario multi-VU con thresholds estrictos.
 *
 * Funcionalidades demostradas:
 *  ✅ Todo lo anterior combinado en un test de carga real
 *  ✅ Múltiples scenarios de k6 (ramping VUs)
 *  ✅ Thresholds por métrica custom
 *  ✅ httpx.beforeAll() para login global
 *  ✅ httpx.data() con dataset variable
 *  ✅ httpx.parallel() para requests concurrentes
 *  ✅ httpx.retry() para resiliencia
 *  ✅ Métricas custom por endpoint con tags
 *  ✅ httpx.printTimeline() en teardown
 *  ✅ httpx.report() para reporte HTML
 *
 * Ejecutar (smoke test — 1 VU):
 *   k6 run examples/05_load_test.js -e STAGE=smoke
 *
 * Ejecutar (load test completo):
 *   k6 run examples/05_load_test.js -e STAGE=load
 *
 * Ejecutar (stress test):
 *   k6 run examples/05_load_test.js -e STAGE=stress
 */

import { httpx } from "../helpers/k6.httpx.js";
import { sleep } from "k6";

// ── Init context ──────────────────────────────────────────────────────────────

httpx.declareMetric("pokemon_fetch_ms");
httpx.declareMetric("user_fetch_ms");
httpx.declareMetric("login_ms");

// Dataset de pokémon a consultar en cada iteración
const POKEMON_LIST = [
    "bulbasaur", "charmander", "squirtle",
    "pikachu",   "mewtwo",     "eevee",
    "gengar",    "snorlax",    "alakazam",
];

// ── Configuración de stages según el ambiente ─────────────────────────────────
const STAGES = {
    smoke: [
        { duration: "30s", target: 1 },
    ],
    load: [
        { duration: "1m",  target: 5  },  // ramp-up
        { duration: "3m",  target: 5  },  // steady state
        { duration: "1m",  target: 0  },  // ramp-down
    ],
    stress: [
        { duration: "2m",  target: 10 },
        { duration: "5m",  target: 10 },
        { duration: "2m",  target: 20 },
        { duration: "2m",  target: 0  },
    ],
};

const stage = httpx.env("STAGE", "smoke");

export const options = {
    scenarios: {
        pokemon_load: {
            executor: "ramping-vus",
            stages:   STAGES[stage] || STAGES.smoke,
        },
    },
    thresholds: {
        // Métricas nativas de k6
        http_req_duration:    ["p(95)<3000", "p(99)<5000"],
        http_req_failed:      ["rate<0.05"],   // menos del 5% de fallos

        // Métricas propias de k6-httpx
        httpx_success_rate:   ["rate>=0.95"],
        httpx_duration_ms:    ["p(95)<3000"],

        // Métricas custom declaradas arriba
        pokemon_fetch_ms:     ["p(95)<2000"],
        user_fetch_ms:        ["p(95)<1500"],
        login_ms:             ["p(95)<1000"],
    },
};

// ── Hooks de ciclo de vida ────────────────────────────────────────────────────

httpx.beforeAll(() => {
    console.log(`\n🚀 Iniciando test de carga — stage: ${stage}`);
    console.log("🔐 Autenticando...");

    const res = httpx.retry(
        () => {
            const r = httpx.post(
                "https://reqres.in/api/login",
                JSON.stringify({ email: "eve.holt@reqres.in", password: "cityslicka" }),
                { headers: { "Content-Type": "application/json" } }
            );
            if (!r.ok()) throw new Error(`login failed: ${r.status()}`);
            return r;
        },
        { retries: 3, baseDelay: 1, factor: 2 }
    );

    httpx.session.setToken(res.json().token);
    httpx.metric("login_ms", res.duration());
    console.log("✅ Sesión iniciada correctamente");
});

httpx.afterAll(() => {
    console.log("\n📊 Generando reporte final...");
    httpx.printTimeline();
    // report() imprime el HTML del reporte en stdout
    // Capturar con: k6 run ... 2>&1 | grep -A9999 "<!DOCTYPE" > report.html
    // httpx.report();  // descomenta para generar HTML
});

export function setup() {
    httpx.runHooks("beforeAll");
}

export function teardown() {
    httpx.runHooks("afterAll");
}

// ── Flujo VU ──────────────────────────────────────────────────────────────────

export default function () {

    // Seleccionar un pokemon aleatorio del dataset
    const pokemon = POKEMON_LIST[Math.floor(Math.random() * POKEMON_LIST.length)];

    httpx.scenario(`VU iteración — ${pokemon}`, () => {

        // ── Paso 1: Pokémon + stats en paralelo ───────────────────────────────
        httpx.step("Fetch Pokémon + species (paralelo)", () => {

            const [pokemonRes, speciesRes] = httpx.parallel([
                ["GET", `https://pokeapi.co/api/v2/pokemon/${pokemon}`],
                ["GET", `https://pokeapi.co/api/v2/pokemon-species/${pokemon}`],
            ]);

            pokemonRes
                .expectStatus(200)
                .contract({ id: "number", name: "string", weight: "number" })
                .extract({ currentPokemonId: "id" });

            speciesRes
                .expectStatus(200)
                .contract({ id: "number", name: "string" });

            httpx.metric("pokemon_fetch_ms", pokemonRes.duration(), { pokemon });
            httpx.metric("pokemon_fetch_ms", speciesRes.duration(), { pokemon, type: "species" });
        });

        // ── Paso 2: Lista de usuarios con data-driven ─────────────────────────
        httpx.step("Fetch usuarios data-driven", () => {

            const pages = [1, 2];

            httpx.data(pages, (page) => {
                const url = httpx.buildUrl("https://reqres.in/api/users", { page });
                const res = httpx.get(url)
                    .expectStatus(200)
                    .contract({
                        page:        "number",
                        per_page:    "number",
                        total:       "number",
                        data:        "array",
                    });

                httpx.metric("user_fetch_ms", res.duration(), { page: String(page) });
            });
        });

        // ── Paso 3: Retry robusto en endpoint externo ─────────────────────────
        httpx.step("Fetch con retry robusto", () => {

            httpx.retry(
                () => {
                    const res = httpx.get(
                        `https://pokeapi.co/api/v2/ability/${Math.floor(Math.random() * 10) + 1}`
                    );
                    if (res.status() !== 200) throw new Error(`status: ${res.status()}`);
                    res.contract({ id: "number", name: "string" });
                    httpx.metric("pokemon_fetch_ms", res.duration(), { endpoint: "ability" });
                },
                { retries: 2, baseDelay: 0.5, factor: 2, maxDelay: 4 }
            );
        });

    });

    // Think time entre iteraciones (simula usuario real)
    sleep(Math.random() * 2 + 1); // entre 1 y 3 segundos
}
