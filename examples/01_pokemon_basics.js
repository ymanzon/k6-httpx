/**
 * Example 01 — Pokemon API: Conceptos básicos de HTTP
 * =====================================================
 * API: https://pokeapi.co/api/v2/
 *
 * Funcionalidades demostradas:
 *  ✅ httpx.baseUrl()          — URL base para requests relativos
 *  ✅ httpx.get()              — petición GET
 *  ✅ httpx.buildUrl()         — construcción de URL con query params
 *  ✅ .expectStatus()          — verificar código HTTP exacto
 *  ✅ .expect2xx()             — verificar rango 2xx
 *  ✅ .expectTime()            — verificar tiempo de respuesta
 *  ✅ .contract()              — validar tipos del JSON (objeto y array)
 *  ✅ .extract()               — extraer valores para reutilizar
 *  ✅ .expectJSON()            — verificar valores concretos en el JSON
 *  ✅ .trace()                 — imprimir request/response en consola
 *  ✅ httpx.var()              — leer valores extraídos
 *  ✅ httpx.step()             — agrupar pasos con timing
 *  ✅ httpx.scenario()         — agrupar un flujo completo
 *  ✅ httpx.printTimeline()    — resumen de todas las requests al final
 *
 * Ejecutar:
 *   k6 run examples/01_pokemon_basics.js
 *   k6 run examples/01_pokemon_basics.js -e POKEMON=charizard
 */

import { httpx } from "../helpers/k6.httpx.js";
import { sleep } from "k6";

// ── Init context ─────────────────────────────────────────────────────────────
// baseUrl define el prefijo para todas las rutas relativas
httpx.baseUrl("https://pokeapi.co/api/v2");

export const options = {
    scenarios: {
        pokemon_basics: {
            executor:   "per-vu-iterations",
            vus:        1,
            iterations: 1,
        },
    },
    thresholds: {
        // La tasa de éxito global de httpx debe ser >= 95%
        httpx_success_rate: ["rate>=0.95"],
        // Todas las requests deben responder en menos de 3 segundos
        http_req_duration: ["p(95)<3000"],
    },
};

export function teardown() {
    // Imprime un resumen de todos los requests realizados
    httpx.printTimeline();
}

// ── Flujo principal ───────────────────────────────────────────────────────────
export default function () {

    // Lee el nombre del pokemon desde env o usa "pikachu por defecto"
    const pokemon = httpx.env("POKEMON", "pikachu");

    httpx.scenario("Explorar Pokémon", () => {

        // ── Paso 1: Obtener un Pokémon por nombre ─────────────────────────────
        httpx.step("Obtener Pokémon por nombre", () => {

            const res = httpx.get(`/pokemon/${pokemon}`)
                .expectStatus(200)
                .expectTime(2000)
                // contract() valida que el objeto tenga las claves con los tipos correctos
                // Cuando la respuesta es un objeto lo valida directamente
                .contract({
                    id:             "number",
                    name:           "string",
                    base_experience: "number",
                    height:         "number",
                    weight:         "number",
                })
                // extract() guarda valores para usarlos en siguientes pasos
                // Soporta dot-notation para rutas anidadas
                .extract({
                    pokemonId:      "id",
                    pokemonName:    "name",
                    pokemonSprite:  "sprites.front_default",
                });

            console.log(`\n🎮 Pokémon encontrado: ${res.json().name} (ID: ${res.json().id})`);
            console.log(`   Peso: ${res.json().weight} | Altura: ${res.json().height}`);
        });

        // ── Paso 2: Obtener lista de Pokémon con paginación ───────────────────
        httpx.step("Listar Pokémon con paginación", () => {

            // buildUrl() construye la query string automáticamente
            const url = httpx.buildUrl("/pokemon", { limit: 5, offset: 0 });
            console.log(`\n🔗 URL construida: ${url}`);

            httpx.get(url)
                .expect2xx()
                // Cuando la respuesta es un objeto con resultados anidados,
                // contract() valida el objeto raíz directamente
                .contract({
                    count:    "number",
                    results:  "array",
                })
                // expectJSON() verifica valores concretos usando dot-notation
                .expectJSON({ count: 1302 })   //1350 es el valor correcto
        });

        // ── Paso 3: Obtener tipo "fire" y validar su estructura ───────────────
        httpx.step("Obtener tipo fuego", () => {

            httpx.get("/type/fire")
                .expectStatus(200)
                .expectTime(2000)
                .contract({
                    id:   "number",
                    name: "string",
                })
                // expectJSON() con valor esperado exacto
                .expectJSON({ name: "fire" })
                // trace() imprime el curl equivalente + status + duración
                .trace();
        });

        // ── Paso 4: Usar valor extraído en otro request ───────────────────────
        httpx.step("Buscar por ID extraído", () => {

            // httpx.var() lee el valor guardado por .extract() en el paso 1
            const id = httpx.var("pokemonId");
            console.log(`\n🔁 Usando ID extraído: ${id}`);

            httpx.get(`/pokemon/${id}`)
                .expectStatus(200)
                // expectJSON() verifica que el nombre coincida con lo extraído
                .expectJSON({ name: httpx.var("pokemonName") });
        });

        // ── Paso 5: HEAD request para verificar disponibilidad ────────────────
        httpx.step("Verificar disponibilidad (HEAD)", () => {

            httpx.head(`/pokemon/${pokemon}`)
                .expectStatus(200)
                .expectTime(1000);

            console.log("\n✅ Endpoint disponible (HEAD OK)");
        });

    });

    sleep(1);
}
