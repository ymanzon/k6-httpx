/**
 * Example 08 — Demo completo con generación automática de dashboard
 * =================================================================
 * APIs: PokéAPI · Simpsons · Open-Meteo · JSONPlaceholder · ReqRes
 *
 * EJECUTAR:
 *   k6 run examples/08_demo_dashboard.js
 *   → genera "report.html" automáticamente al terminar ✅
 *
 * Con más VUs:
 *   k6 run examples/08_demo_dashboard.js --vus 3 --iterations 9
 *
 * Con nombre de archivo personalizado:
 *   k6 run examples/08_demo_dashboard.js -e REPORT=mi-reporte.html
 */

import { httpx }      from "../helpers/k6.httpx.js";
import { htmlReport } from "../helpers/k6.httpx.dashboard.js";
import { sleep }      from "k6";

/* ── Init context ────────────────────────────────────────────────────────── */

httpx.baseUrl("https://pokeapi.co/api/v2");

httpx.declareMetric("pokemon_ms");
httpx.declareMetric("quotes_ms");
httpx.declareMetric("weather_ms");
httpx.declareMetric("crud_ms");

var POKEMONS = ["pikachu", "charizard", "mewtwo", "eevee", "snorlax", "gengar", "bulbasaur"];

/* ── Options ─────────────────────────────────────────────────────────────── */

export var options = {
    scenarios: {
        demo: {
            executor:   "per-vu-iterations",
            vus:        1,
            iterations: 3,
        },
    },
    thresholds: {
        http_req_duration:  ["p(95)<5000"],
        http_req_failed:    ["rate<0.1"],
        checks:             ["rate>=0.80"],
        pokemon_ms:         ["p(95)<4000"],
        quotes_ms:          ["p(95)<6000"],
    },
};

/* ── handleSummary — aquí se genera el reporte ───────────────────────────── */
/*
 * k6 llama esta función automáticamente al terminar.
 * Retorna un objeto { "filename": htmlContent } y k6 escribe el archivo.
 * Sin grep, sin piping, sin require().
 */
export function handleSummary(data) {
    var filename = httpx.env("REPORT", "report.html");
    return {
        [filename]: htmlReport(data, {
            script: "08_demo_dashboard.js",
            title:  "k6-httpx Demo Dashboard",
        }),
    };
}

/* ── Hooks ───────────────────────────────────────────────────────────────── */

httpx.beforeAll(function() {
    console.log("\n🚀 Iniciando demo...");
    var res = httpx.post(
        "https://reqres.in/api/login",
        JSON.stringify({ email: "eve.holt@reqres.in", password: "cityslicka" }),
        { headers: { "Content-Type": "application/json" } }
    );
    if (res.ok()) {
        httpx.session.setToken(res.json().token);
        console.log("   ✅ Sesión iniciada");
    }
});

export function setup()    { httpx.runHooks("beforeAll"); }
export function teardown() { httpx.printTimeline(); }

/* ── VU flow ─────────────────────────────────────────────────────────────── */

export default function() {
    var pokemon = POKEMONS[(typeof __ITER !== "undefined" ? __ITER : 0) % POKEMONS.length];

    httpx.scenario("Demo " + pokemon, function() {

        // ── 1. GET con contract + extract ──────────────────────────────
        httpx.step("PokéAPI GET " + pokemon, function() {
            var res = httpx.get("/pokemon/" + pokemon)
                .expectStatus(200)
                .expectTime(4000)
                .contract({ id: "number", name: "string", weight: "number" })
                .extract({ pokemonId: "id" });

            httpx.metric("pokemon_ms", res.duration(), { pokemon: pokemon });
            console.log("   🎮 " + pokemon + " — ID: " + httpx.var("pokemonId"));
        });

        // ── 2. Parallel requests ───────────────────────────────────────
        httpx.step("PokéAPI parallel (type + ability)", function() {
            var rs = httpx.parallel([
                ["GET", "https://pokeapi.co/api/v2/type/fire"],
                ["GET", "https://pokeapi.co/api/v2/ability/1"],
            ]);
            rs[0].expectStatus(200).contract({ id: "number", name: "string" });
            rs[1].expectStatus(200).contract({ id: "number", name: "string" });
            for (var i = 0; i < rs.length; i++) {
                httpx.metric("pokemon_ms", rs[i].duration(), { type: "parallel" });
            }
        });

        // ── 3. Simpsons quote (con retry) ──────────────────────────────
        httpx.step("Simpsons quote", function() {
            var res = httpx.retry(function() {
                var r = httpx.get("https://thesimpsonsquoteapi.glitch.me/quotes?count=1");
                if (!r.ok()) throw new Error("status " + r.status());
                return r;
            }, { retries: 2, baseDelay: 1, factor: 2 });

            res.expect2xx()
               .contract({ quote: "string", character: "string" });

            var q = res.json();
            if (q && q[0]) console.log('   🍩 "' + q[0].quote.slice(0, 55) + '…"');
            httpx.metric("quotes_ms", res.duration());
        });

        // ── 4. Open-Meteo ──────────────────────────────────────────────
        httpx.step("Open-Meteo clima", function() {
            var url = httpx.buildUrl("https://api.open-meteo.com/v1/forecast", {
                latitude: "20.97", longitude: "-89.59", current_weather: "true",
            });
            var res = httpx.get(url)
                .expectStatus(200)
                .contract({ latitude: "number", current_weather: "object" });
            var w = res.json() ? res.json().current_weather : null;
            if (w) console.log("   🌤  " + w.temperature + "°C");
            httpx.metric("weather_ms", res.duration());
        });

        // ── 5. CRUD completo ───────────────────────────────────────────
        httpx.step("JSONPlaceholder CRUD", function() {
            var r1 = httpx.post(
                "https://jsonplaceholder.typicode.com/posts",
                JSON.stringify({ title: "k6 " + pokemon, body: "test", userId: 1 }),
                { headers: { "Content-Type": "application/json" } }
            ).expectStatus(201).extract({ newId: "id" });

            var r2 = httpx.patch(
                "https://jsonplaceholder.typicode.com/posts/1",
                JSON.stringify({ title: "updated" }),
                { headers: { "Content-Type": "application/json" } }
            ).expectStatus(200);

            var r3 = httpx.delete("https://jsonplaceholder.typicode.com/posts/1")
                .expectStatus(200);

            httpx.metric("crud_ms", r1.duration(), { op: "POST" });
            httpx.metric("crud_ms", r2.duration(), { op: "PATCH" });
            httpx.metric("crud_ms", r3.duration(), { op: "DELETE" });
        });

        // ── 6. ReqRes users ────────────────────────────────────────────
        httpx.step("ReqRes users", function() {
            httpx.get("https://reqres.in/api/users?page=1")
                .expectStatus(200)
                .expectTime(2000)
                .contract({ page: "number", data: "array" });
        });

    });

    sleep(1);
}
