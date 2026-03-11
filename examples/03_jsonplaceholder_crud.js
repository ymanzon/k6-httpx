/**
 * Example 03 — JSONPlaceholder: CRUD completo y Data-Driven Testing
 * ==================================================================
 * API: https://jsonplaceholder.typicode.com
 *
 * Funcionalidades demostradas:
 *  ✅ httpx.post()             — crear recurso
 *  ✅ httpx.put()              — actualización completa
 *  ✅ httpx.patch()            — actualización parcial
 *  ✅ httpx.delete()           — eliminar recurso
 *  ✅ .contractArray()         — validar TODOS los elementos de un array
 *  ✅ .expectJSON()            — verificar valores concretos del JSON
 *  ✅ .expectJSONSchema()      — verificar tipos sin lanzar excepción
 *  ✅ httpx.data()             — tests data-driven (un test por dataset)
 *  ✅ httpx.run()              — bloque con nombre y tiempo total
 *  ✅ .extract()               — extraer ID del recurso creado
 *  ✅ httpx.var()              — usar el ID en operaciones siguientes
 *  ✅ .toCurl()                — obtener curl equivalente como string
 *
 * Ejecutar:
 *   k6 run examples/03_jsonplaceholder_crud.js
 */

import { httpx } from "../helpers/k6.httpx.js";
import { sleep } from "k6";

// ── Init context ──────────────────────────────────────────────────────────────

httpx.baseUrl("https://jsonplaceholder.typicode.com");

// Dataset para data-driven testing
// Cada item representa un post diferente que se creará y validará
const POST_DATASET = [
    { title: "k6 performance testing",   body: "Load testing con k6 y httpx",     userId: 1 },
    { title: "API contract validation",   body: "Validar contratos de APIs REST",   userId: 2 },
    { title: "Parallel requests in k6",   body: "Usando http.batch para concurrencia", userId: 3 },
];

export const options = {
    scenarios: {
        crud_flow: {
            executor:   "per-vu-iterations",
            vus:        1,
            iterations: 1,
        },
    },
    thresholds: {
        httpx_success_rate: ["rate>=0.95"],
        http_req_duration:  ["p(95)<3000"],
    },
};

export function teardown() {
    httpx.printTimeline();
}

// ── Flujo principal ───────────────────────────────────────────────────────────

export default function () {

    // run() es como scenario() pero imprime el tiempo TOTAL al final
    httpx.run("CRUD Completo + Data-Driven", () => {

        // ── Bloque 1: GET con contractArray ───────────────────────────────────
        httpx.step("GET lista de posts (contractArray)", () => {

            httpx.get("/posts")
                .expectStatus(200)
                .expectTime(2000)
                // contractArray() valida TODOS los elementos del array
                // Diferencia vs contract(): contract() solo valida el primero
                .contractArray({
                    userId: "number",
                    id:     "number",
                    title:  "string",
                    body:   "string",
                });

            console.log("\n✅ Todos los posts tienen la estructura correcta");
        });

        // ── Bloque 2: POST — crear recurso ────────────────────────────────────
        httpx.step("POST crear post nuevo", () => {

            const payload = {
                title:  "Test desde k6-httpx",
                body:   "Creado con httpx.post()",
                userId: 1,
            };

            const res = httpx.post(
                "/posts",
                JSON.stringify(payload),
                { headers: { "Content-Type": "application/json" } }
            );

            res
                .expectStatus(201)
                // expectJSON() verifica valores exactos en el JSON de respuesta
                .expectJSON({
                    title:  "Test desde k6-httpx",
                    userId: 1,
                })
                // expectJSONSchema() verifica solo tipos — no lanza excepción si falla
                // a diferencia de contract(), usa check() internamente (no throw)
                .expectJSONSchema({
                    id:    "number",
                    title: "string",
                    body:  "string",
                })
                // Guarda el ID del recurso creado para usarlo en los pasos siguientes
                .extract({ newPostId: "id" });

            // toCurl() devuelve el comando curl equivalente como string
            console.log("\n📋 cURL equivalente:");
            console.log(res.toCurl());
            console.log(`\n✅ Post creado con ID: ${httpx.var("newPostId")}`);
        });

        // ── Bloque 3: PUT — actualización completa ────────────────────────────
        httpx.step("PUT actualización completa", () => {

            const id = httpx.var("newPostId");

            httpx.put(
                `/posts/${id}`,
                JSON.stringify({
                    id:     id,
                    title:  "Título actualizado (PUT)",
                    body:   "Cuerpo reemplazado completamente",
                    userId: 1,
                }),
                { headers: { "Content-Type": "application/json" } }
            )
            .expectStatus(200)
            .expectJSON({ title: "Título actualizado (PUT)" })
            .contract({
                id:     "number",
                title:  "string",
                body:   "string",
                userId: "number",
            });

            console.log("\n✅ PUT exitoso — recurso actualizado completamente");
        });

        // ── Bloque 4: PATCH — actualización parcial ───────────────────────────
        httpx.step("PATCH actualización parcial", () => {

            const id = httpx.var("newPostId");

            httpx.patch(
                `/posts/${id}`,
                // PATCH solo envía los campos a cambiar
                JSON.stringify({ title: "Solo el título cambia (PATCH)" }),
                { headers: { "Content-Type": "application/json" } }
            )
            .expectStatus(200)
            .expectJSON({ title: "Solo el título cambia (PATCH)" });

            console.log("\n✅ PATCH exitoso — solo el título fue modificado");
        });

        // ── Bloque 5: DELETE ──────────────────────────────────────────────────
        httpx.step("DELETE eliminar recurso", () => {

            const id = httpx.var("newPostId");

            httpx.delete(`/posts/${id}`)
                .expectStatus(200);

            console.log(`\n✅ DELETE exitoso — post ${id} eliminado`);
        });

        // ── Bloque 6: Data-driven testing ─────────────────────────────────────
        httpx.step("Data-driven: crear múltiples posts", () => {

            console.log(`\n📊 Ejecutando data-driven con ${POST_DATASET.length} items...`);

            // httpx.data() ejecuta la función una vez por cada elemento del dataset
            // Equivalente a dataset.forEach(fn) pero integrado en el flujo de httpx
            httpx.data(POST_DATASET, (post) => {

                const res = httpx.post(
                    "/posts",
                    JSON.stringify(post),
                    { headers: { "Content-Type": "application/json" } }
                );

                res
                    .expectStatus(201)
                    .expectJSON({ userId: post.userId })
                    .expectJSON({ title: post.title });

                console.log(`  ✔ Creado: "${post.title}" (userId: ${post.userId})`);
            });
        });

        // ── Bloque 7: GET de un recurso específico con query params ───────────
        httpx.step("GET con query params (buildUrl)", () => {

            // buildUrl() construye la URL con query string de forma segura
            const url = httpx.buildUrl("/posts", { userId: 1 });
            console.log(`\n🔗 URL: ${url}`);

            const res = httpx.get(url);

            res
                .expectStatus(200)
                // Todos los posts del userId 1 deben tener userId=1
                .contractArray({ userId: "number", id: "number", title: "string" });

            const posts = res.json();
            console.log(`\n✅ Posts del userId 1: ${posts.length} encontrados`);
        });

    });

    sleep(1);
}
