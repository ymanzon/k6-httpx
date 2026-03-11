/**
 * Example 04 — Open-Meteo + LoremPicsum: Métricas Custom y Plugins
 * =================================================================
 * APIs:
 *  - https://api.open-meteo.com/v1/    (clima — sin API key)
 *  - https://picsum.photos              (imágenes — LoremPicsum)
 *
 * Funcionalidades demostradas:
 *  ✅ httpx.declareMetric()     — declarar Trend personalizado (init context)
 *  ✅ httpx.metric()            — registrar valor con tags
 *  ✅ httpx.use()               — sistema de plugins (plugin onResponse)
 *  ✅ .eval()                   — función inline sobre la respuesta
 *  ✅ httpx.openapi()           — validar contra spec OpenAPI
 *  ✅ .validateOpenAPI()        — verificar status code según spec
 *  ✅ httpx.setRateLimitSleep() — configurar espera en 429
 *  ✅ httpx.env()               — leer variables de entorno k6
 *  ✅ httpx.run()               — bloque con tiempo total
 *  ✅ .expectHeader()           — verificar valor de header
 *
 * Ejecutar:
 *   k6 run examples/04_weather_metrics.js
 *   k6 run examples/04_weather_metrics.js -e LAT=19.4326 -e LON=-99.1332
 */

import { httpx } from "../helpers/k6.httpx.js";
import { sleep } from "k6";

// ── Init context ──────────────────────────────────────────────────────────────

// Declarar métricas custom SIEMPRE en el init context (nivel raíz)
// Estas aparecerán en el resumen final de k6 con percentiles p50/p90/p95/p99
httpx.declareMetric("weather_api_ms");      // duración del endpoint de clima
httpx.declareMetric("images_api_ms");       // duración del endpoint de imágenes
httpx.declareMetric("weather_temp_value");  // temperatura como métrica de negocio

// Configurar espera ante rate limiting
httpx.setRateLimitSleep(2000); // 2 segundos si recibimos un 429

// ── Plugin: Logger de rendimiento ─────────────────────────────────────────────
// httpx.use() registra un plugin que recibe cada response automáticamente
// Útil para logging centralizado, alertas, métricas extra sin tocar los tests
httpx.use({
    onResponse(res, meta) {
        const duration = res.timings.duration;
        // Alerta si un request tarda más de 1.5 segundos
        if (duration > 1500) {
            console.warn(`\n⚠️  [Plugin] Request lento detectado: ${meta.method} ${meta.url} — ${duration.toFixed(0)}ms`);
        }
    }
});

// ── Mini spec OpenAPI para validar el endpoint de clima ───────────────────────
// httpx.openapi() carga una spec que luego usa .validateOpenAPI()
httpx.openapi({
    paths: {
        "/v1/forecast": {
            get: {
                responses: {
                    "200": { description: "OK" },
                    "400": { description: "Bad Request" },
                },
            },
        },
    },
});

export const options = {
    scenarios: {
        weather_metrics: {
            executor:   "per-vu-iterations",
            vus:        1,
            iterations: 1,
        },
    },
    thresholds: {
        // Métricas custom aparecen aquí también
        weather_api_ms:  ["p(95)<3000"],
        images_api_ms:   ["p(95)<2000"],
        httpx_success_rate: ["rate>=0.90"],
    },
};

export function teardown() {
    httpx.printTimeline();
}

// ── Flujo principal ───────────────────────────────────────────────────────────

export default function () {

    // Coordenadas configurables por variable de entorno
    const lat = httpx.env("LAT", "20.9674"); // Mérida, Yucatán por defecto
    const lon = httpx.env("LON", "-89.5926");

    httpx.run("Weather + Images API", () => {

        // ── Paso 1: Clima actual con métricas custom ──────────────────────────
        httpx.step("Obtener clima actual", () => {

            const url = httpx.buildUrl("https://api.open-meteo.com/v1/forecast", {
                latitude:       lat,
                longitude:      lon,
                current_weather: true,
                hourly:         "temperature_2m",
            });

            const res = httpx.get(url)
                .expectStatus(200)
                .expectTime(3000)
                .contract({
                    latitude:        "number",
                    longitude:       "number",
                    current_weather: "object",
                })
                // validateOpenAPI() verifica que el status code sea válido según la spec
                .validateOpenAPI()
                // eval() permite ejecutar lógica inline sin romper la cadena fluent
                .eval(({ res }) => {
                    const weather = res.json().current_weather;
                    if (weather) {
                        console.log(`\n🌤  Clima en (${lat}, ${lon}):`);
                        console.log(`   Temperatura : ${weather.temperature}°C`);
                        console.log(`   Viento      : ${weather.windspeed} km/h`);
                    }
                })
                .extract({
                    currentTemp:      "current_weather.temperature",
                    currentWindspeed: "current_weather.windspeed",
                });

            // Registrar duración con tags descriptivos
            httpx.metric("weather_api_ms", res.duration(), {
                endpoint: "forecast",
                lat:      lat,
                lon:      lon,
            });

            // Temperatura como métrica de negocio (valor numérico real)
            const temp = httpx.var("currentTemp");
            if (temp !== undefined) {
                httpx.metric("weather_temp_value", temp, { location: `${lat},${lon}` });
            }
        });

        // ── Paso 2: Múltiples ciudades en paralelo ────────────────────────────
        httpx.step("Clima de múltiples ciudades (paralelo)", () => {

            const cities = [
                { name: "Ciudad de México", lat: "19.4326", lon: "-99.1332" },
                { name: "Guadalajara",       lat: "20.6597", lon: "-103.3496" },
                { name: "Monterrey",         lat: "25.6866", lon: "-100.3161" },
            ];

            // Construir los requests para http.batch()
            const requests = cities.map(city => [
                "GET",
                httpx.buildUrl("https://api.open-meteo.com/v1/forecast", {
                    latitude:       city.lat,
                    longitude:      city.lon,
                    current_weather: true,
                }),
            ]);

            // parallel() ejecuta todos en paralelo vía http.batch()
            const responses = httpx.parallel(requests);

            responses.forEach((res, i) => {
                const city = cities[i];
                res.expectStatus(200);

                const weather = res.json().current_weather;
                if (weather) {
                    console.log(`  🏙  ${city.name}: ${weather.temperature}°C, viento ${weather.windspeed} km/h`);
                }

                // Registrar métrica por ciudad con tag
                httpx.metric("weather_api_ms", res.duration(), {
                    endpoint: "forecast",
                    city:     city.name,
                });
            });
        });

        // ── Paso 3: LoremPicsum — imágenes con redirect ───────────────────────
        httpx.step("Obtener metadatos de imagen (LoremPicsum)", () => {

            // LoremPicsum ofrece imágenes aleatorias — usamos la API de info
            const res = httpx.get("https://picsum.photos/v2/list?page=1&limit=3")
                .expectStatus(200)
                .contractArray({
                    id:        "string",
                    author:    "string",
                    width:     "number",
                    height:    "number",
                    url:       "string",
                    download_url: "string",
                })
                // eval() para inspeccionar sin romper la cadena
                .eval(({ res }) => {
                    const images = res.json();
                    console.log(`\n🖼  ${images.length} imágenes disponibles:`);
                    images.forEach(img => {
                        console.log(`   [${img.id}] ${img.author} — ${img.width}x${img.height}`);
                    });
                });

            httpx.metric("images_api_ms", res.duration(), { endpoint: "list" });
        });

        // ── Paso 4: HEAD request a imagen específica ──────────────────────────
        httpx.step("Verificar header Content-Type de imagen", () => {

            // picsum.photos devuelve imágenes JPEG
            // Usamos el endpoint de seed para obtener siempre la misma imagen
            httpx.get("https://picsum.photos/seed/k6httpx/200/300.jpg")
                .expect2xx()
                .expectHeader("Content-Type", "image/jpeg")
                .eval(({ res }) => {
                    console.log(`\n📸 Imagen obtenida — ${(res.body || "").length} bytes`);
                });
        });

    });

    sleep(1);
}
