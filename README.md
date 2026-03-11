# k6-httpx ⚡

> Enhanced HTTP client library for [k6](https://k6.io) — fluent API, contract validation, parallel requests, custom metrics, and more.

[![k6](https://img.shields.io/badge/k6-v0.45+-blue?logo=k6)](https://k6.io)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

📖 **[Documentación completa → GitHub Pages](https://tu-usuario.github.io/k6-httpx)**

---

## ¿Qué es k6-httpx?

`k6-httpx` es una librería que extiende el cliente HTTP nativo de k6 con una **API fluent** para hacer más rápido y legible el escribir pruebas de carga y performance.

```javascript
// Sin k6-httpx 😩
const res = http.get("https://api.com/users");
check(res, { "status 200": r => r.status === 200 });
check(res, { "responde rápido": r => r.timings.duration < 500 });
const data = res.json();
if (typeof data[0].id !== "number") throw new Error("contract error");

// Con k6-httpx 🚀
httpx.get("/users")
  .expectStatus(200)
  .expectTime(500)
  .contract({ id: "number", name: "string" });
```

---

## Características

| Feature | Descripción |
|---|---|
| **Fluent API** | Encadena assertions, extracciones y validaciones |
| **http.batch()** | `httpx.parallel()` usa batch real de k6 |
| **Contract validation** | Valida objetos y arrays automáticamente |
| **Retry + backoff** | Exponential backoff configurable |
| **Custom metrics** | Trend metrics con tags para Grafana |
| **Session / Auth** | Token global aplicado a todos los requests |
| **Lifecycle hooks** | `beforeAll` / `afterAll` integrados |
| **Data-driven** | `httpx.data()` para iterar sobre datasets |
| **Plugin system** | `httpx.use()` con hook `onResponse` |
| **HTML report** | `httpx.report()` genera reporte visual |

---

## Instalación

```bash
# Clonar el repo
git clone https://github.com/tu-usuario/k6-httpx.git

# O solo copiar la librería a tu proyecto
cp helpers/k6.httpx.js tu-proyecto/helpers/
```

**Requisito:** k6 v0.45+ instalado. → [Instalar k6](https://k6.io/docs/get-started/installation/)

---

## Quickstart

```javascript
import { httpx } from "./helpers/k6.httpx.js";
import { sleep } from "k6";

// Init context — configuración global
httpx.baseUrl("https://pokeapi.co/api/v2");
httpx.declareMetric("pokemon_ms");   // ← siempre en init context

export const options = {
  thresholds: {
    http_req_duration: ["p(95)<2000"],
    pokemon_ms:        ["p(95)<1500"],
  }
};

export default function () {
  httpx.step("Buscar Pokémon", () => {
    const res = httpx.get("/pokemon/pikachu")
      .expectStatus(200)
      .expectTime(2000)
      .contract({ id: "number", name: "string" })
      .extract({ pokemonId: "id" });

    httpx.metric("pokemon_ms", res.duration());
    console.log(`ID: ${httpx.var("pokemonId")}`);
  });

  sleep(1);
}
```

```bash
k6 run quickstart.js
```

---

## Estructura del proyecto

```
k6-httpx/
├── helpers/
│   └── k6.httpx.js          # La librería
├── examples/
│   ├── 01_pokemon_basics.js         # GET, buildUrl, contract, extract
│   ├── 02_simpsons_parallel.js      # parallel, retry, session, hooks
│   ├── 03_jsonplaceholder_crud.js   # POST/PUT/PATCH/DELETE, data-driven
│   ├── 04_weather_metrics.js        # Custom metrics, plugins, openapi
│   └── 05_load_test.js              # Test de carga completo multi-VU
├── docs/
│   └── index.html                   # GitHub Pages — documentación
├── .github/
│   └── workflows/
│       └── pages.yml                # Deploy automático a GitHub Pages
└── README.md
```

---

## Ejemplos

### 01 — Pokemon API: Conceptos Básicos
```bash
k6 run examples/01_pokemon_basics.js
k6 run examples/01_pokemon_basics.js -e POKEMON=charizard
```
Demuestra: `httpx.get()`, `buildUrl()`, `.contract()`, `.extract()`, `.trace()`, `httpx.head()`

---

### 02 — Simpsons + ReqRes: Parallel y Session
```bash
k6 run examples/02_simpsons_parallel.js
```
Demuestra: `httpx.parallel()`, `httpx.retry()`, `session.setToken()`, `beforeAll/afterAll`, `.softExpect()`, `.debug()`

---

### 03 — JSONPlaceholder: CRUD Completo
```bash
k6 run examples/03_jsonplaceholder_crud.js
```
Demuestra: `httpx.post/put/patch/delete()`, `.contractArray()`, `httpx.data()`, `.expectJSON()`, `.toCurl()`

---

### 04 — Open-Meteo + LoremPicsum: Métricas y Plugins
```bash
k6 run examples/04_weather_metrics.js
k6 run examples/04_weather_metrics.js -e LAT=19.4326 -e LON=-99.1332
```
Demuestra: `declareMetric()`, `httpx.metric()`, `httpx.use()`, `httpx.openapi()`, `.eval()`

---

### 05 — Load Test Completo
```bash
# Smoke test (1 VU)
k6 run examples/05_load_test.js -e STAGE=smoke

# Load test (5 VUs, 5 minutos)
k6 run examples/05_load_test.js -e STAGE=load

# Stress test (hasta 20 VUs)
k6 run examples/05_load_test.js -e STAGE=stress
```
Demuestra: `ramping-vus`, thresholds por métrica custom, todas las funcionalidades combinadas.

---

## API Reference Rápida

### HTTP Methods
```javascript
httpx.get(url, params?)
httpx.post(url, body?, params?)
httpx.put(url, body?, params?)
httpx.patch(url, body?, params?)
httpx.delete(url, params?)
httpx.head(url, params?)
httpx.parallel([[method, url, body?, params?], ...])
```

### Assertions (encadenables)
```javascript
.expectStatus(200)
.expect2xx()
.expectTime(500)
.expectHeader("Content-Type", "application/json")
.expectJSON({ title: "hello" })
.expectJSONSchema({ id: "number", name: "string" })
.contract({ id: "number" })        // objeto o primer elemento de array
.contractArray({ id: "number" })   // todos los elementos del array
.softExpect(fn)                    // assertion sin throw
```

### Extracción y correlación
```javascript
.extract({ tokenKey: "data.token", userId: "[0].id" })
httpx.var("tokenKey")   // leer valor extraído
```

### Session
```javascript
httpx.session.setToken(token)
httpx.session.setHeader("X-Api-Key", key)
httpx.session.clearToken()
```

### Métricas custom
```javascript
// Init context:
httpx.declareMetric("my_trend_ms")

// VU context:
httpx.metric("my_trend_ms", res.duration(), { endpoint: "users" })
```

### Lifecycle hooks
```javascript
httpx.beforeAll(() => { /* login, seed data */ })
httpx.afterAll(() => { /* cleanup, report */ })

export function setup()    { httpx.runHooks("beforeAll"); }
export function teardown() { httpx.runHooks("afterAll");  }
```

### Utilidades
```javascript
httpx.baseUrl("https://api.com")
httpx.buildUrl("/users", { page: 1, limit: 10 })
httpx.env("BASE_URL", "http://localhost:3000")
httpx.step("Nombre del paso", () => { ... })
httpx.scenario("Nombre del escenario", () => { ... })
httpx.retry(fn, { retries: 3, baseDelay: 1, factor: 2 })
httpx.data(dataset, (item) => { ... })
httpx.use({ onResponse(res, meta) { ... } })
httpx.printTimeline()
httpx.report()      // HTML en stdout
httpx.reportHtml()  // HTML como string
```

---

## Regla de oro: Init vs VU Context

```javascript
// ✅ Init context (nivel raíz del módulo)
httpx.baseUrl("...");
httpx.declareMetric("my_ms");
httpx.beforeAll(() => { ... });
httpx.use(plugin);

// ✅ VU context (dentro de funciones)
export default function () {
  httpx.get("/users");
  httpx.metric("my_ms", 123);
  httpx.cookies; // cookie jar
}
```

> `httpx.declareMetric()` y `httpx.cookies` **no pueden** llamarse en init context porque internamente crean `new Trend()` y `http.cookieJar()` que k6 reserva para el contexto de VU.

---

## GitHub Pages

La documentación completa se despliega automáticamente en GitHub Pages al hacer push a `main`.

Para activarla:
1. Ve a **Settings → Pages**
2. Source: **GitHub Actions**
3. El workflow `.github/workflows/pages.yml` se encarga del resto

---

## Licencia

MIT © 2025
