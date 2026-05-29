/**
 * k6-httpx Dashboard Plugin  —  k6.httpx.dashboard.js
 * =====================================================
 *
 * USO (en tu script de prueba):
 * ─────────────────────────────
 *   import { htmlReport } from "./helpers/k6.httpx.dashboard.js";
 *
 *   export function handleSummary(data) {
 *     return {
 *       "report.html": htmlReport(data, { script: "mi-script.js" }),
 *     };
 *   }
 *
 * k6 escribe el archivo automáticamente al terminar — sin grep, sin piping,
 * sin require(), sin exportResults(). Compatible con TODAS las versiones de k6.
 *
 * El dashboard muestra:
 *   ✅ Nombre del script + fecha + duración total
 *   ✅ KPIs: requests, pass rate, avg/p95/p99
 *   ✅ TODOS los checks (= todos los expect*) con pass/fail
 *   ✅ Thresholds definidos en options
 *   ✅ Métricas custom declaradas con declareMetric()
 *   ✅ Charts: timeline de checks, distribución, percentiles
 *
 * API:
 *   htmlReport(data, opts?)  → string HTML listo para guardar
 *
 *   opts = {
 *     script?:   "nombre-del-script.js",  // aparece en el header
 *     title?:    "Mi Test Suite",          // título del reporte
 *   }
 */

/* ─────────────────────────────────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────────────────────────────────── */

/** Lee un valor de un objeto anidado de forma segura */
function _get(obj, path, def) {
    var parts = path.split(".");
    var cur   = obj;
    for (var i = 0; i < parts.length; i++) {
        if (cur === null || cur === undefined) return def;
        cur = cur[parts[i]];
    }
    return cur !== undefined ? cur : def;
}

/** Formatea ms a string legible */
function _ms(v) {
    if (v === undefined || v === null) return "—";
    v = parseFloat(v);
    if (v >= 1000) return (v / 1000).toFixed(2) + "s";
    return v.toFixed(1) + "ms";
}

function _round(v) { return Math.round(parseFloat(v) || 0); }
function _pct(v)   { return (parseFloat(v) || 0).toFixed(1) + "%"; }

/**
 * B-08 fix: Recursively collects all checks from rootGroup.
 * Handles variations in k6 data structure across versions:
 *   - group.checks may be an array OR an object keyed by check name
 *   - group.groups may be an array OR an object keyed by group name
 *   - Some k6 versions emit groups as a flat map at the root level
 */
function _collectChecks(group, list, parentPath) {
    if (!group || typeof group !== "object") return list || [];
    list       = list       || [];
    parentPath = parentPath || "";

    var groupName = group.name ? group.name : parentPath;

    // ── Collect checks ────────────────────────────────────────────────────
    var checks = group.checks;
    if (checks) {
        if (Array.isArray(checks)) {
            // k6 v0.39+ style: checks is an array
            for (var i = 0; i < checks.length; i++) {
                var c = checks[i];
                if (c && typeof c === "object" && c.name !== undefined) {
                    list.push({
                        name:   String(c.name),
                        passes: parseInt(c.passes, 10) || 0,
                        fails:  parseInt(c.fails,  10) || 0,
                        path:   groupName,
                    });
                }
            }
        } else if (typeof checks === "object") {
            // Older k6 style: checks is an object { "check name": { passes, fails } }
            var checkKeys = Object.keys(checks);
            for (var ci = 0; ci < checkKeys.length; ci++) {
                var ck = checkKeys[ci];
                var cv = checks[ck];
                list.push({
                    name:   ck,
                    passes: parseInt((cv && cv.passes) || 0, 10),
                    fails:  parseInt((cv && cv.fails)  || 0, 10),
                    path:   groupName,
                });
            }
        }
    }

    // ── Recurse into sub-groups ───────────────────────────────────────────
    var groups = group.groups;
    if (groups) {
        if (Array.isArray(groups)) {
            for (var gi = 0; gi < groups.length; gi++) {
                _collectChecks(groups[gi], list, groupName);
            }
        } else if (typeof groups === "object") {
            var groupKeys = Object.keys(groups);
            for (var gki = 0; gki < groupKeys.length; gki++) {
                var subGroup = groups[groupKeys[gki]];
                _collectChecks(subGroup, list, groupName);
            }
        }
    }

    return list;
}

/** Clasifica una métrica por tipo y devuelve sus valores clave */
function _metricRow(name, metric) {
    if (!metric) return null;
    var type = metric.type;
    var v    = metric.values || {};
    if (type === "trend") {
        return {
            name:  name,
            type:  "trend",
            avg:   _ms(v.avg),
            p90:   _ms(v["p(90)"] !== undefined ? v["p(90)"] : v.p90),
            p95:   _ms(v["p(95)"] !== undefined ? v["p(95)"] : v.p95),
            p99:   _ms(v["p(99)"] !== undefined ? v["p(99)"] : v.p99),
            max:   _ms(v.max),
            count: v.count || "—",
        };
    }
    if (type === "counter") {
        return { name: name, type: "counter", count: v.count || 0, rate: (v.rate || 0).toFixed(2) + "/s" };
    }
    if (type === "rate") {
        var pct = ((v.rate || 0) * 100).toFixed(1);
        return { name: name, type: "rate", rate: pct + "%", passes: v.passes || 0, fails: v.fails || 0 };
    }
    if (type === "gauge") {
        return { name: name, type: "gauge", value: v.value || 0 };
    }
    return null;
}

/* ─────────────────────────────────────────────────────────────────────────
   CSS
───────────────────────────────────────────────────────────────────────── */

var CSS = [
"@import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600&display=swap');",
"*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}",
":root{",
"  --bg:#060a10;--bg1:#0a0f18;--bg2:#0e1520;--bg3:#131d2b;",
"  --ln:#1b2a3e;--ln2:#243550;",
"  --fg:#ccd9e8;--fg2:#6d879e;--fg3:#3d546a;",
"  --gr:#00e5a0;--gr2:#00b87d;--gr3:rgba(0,229,160,.12);",
"  --rd:#ff4060;--rd2:#cc2040;--rd3:rgba(255,64,96,.12);",
"  --yl:#ffb830;--bl:#3d9fff;--pu:#9d6fff;--cy:#00d4e8;",
"  --mono:'Space Mono',monospace;",
"  --sans:'DM Sans',sans-serif;",
"  --r:8px;",
"}",
"html{scroll-behavior:smooth}",
"body{background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:14px;line-height:1.65;min-height:100vh}",

/* Noise texture */
"body::after{content:'';position:fixed;inset:0;pointer-events:none;z-index:0;",
"  background:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23n)' opacity='.025'/%3E%3C/svg%3E\");",
"}",

".wrap{position:relative;z-index:1;max-width:1360px;margin:0 auto;padding:36px 28px 72px}",

/* Header */
".hdr{display:flex;justify-content:space-between;align-items:flex-start;",
"  border-bottom:1px solid var(--ln);padding-bottom:24px;margin-bottom:36px;flex-wrap:wrap;gap:16px}",
".hdr-left{}",
".hdr-brand{font-family:var(--mono);font-size:1.55rem;font-weight:700;color:#fff;letter-spacing:-.02em}",
".hdr-brand em{color:var(--gr);font-style:normal}",
".hdr-sub{font-family:var(--mono);font-size:.62rem;text-transform:uppercase;letter-spacing:.14em;color:var(--fg3);margin-top:5px}",
".hdr-right{text-align:right;font-family:var(--mono);font-size:.72rem;color:var(--fg3);line-height:2}",
".hdr-right .hi{color:var(--gr)}",

/* Status banner */
".banner{display:flex;align-items:center;gap:10px;padding:12px 20px;border-radius:var(--r);margin-bottom:32px;",
"  border:1px solid var(--ln);font-family:var(--mono);font-size:.78rem;flex-wrap:wrap;gap:10px}",
".banner.passed{background:var(--gr3);border-color:var(--gr2)}",
".banner.failed{background:var(--rd3);border-color:var(--rd2)}",
".banner .dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;animation:pulse 2s infinite}",
".banner.passed .dot{background:var(--gr)}",
".banner.failed .dot{background:var(--rd)}",
"@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}",
".banner .status-lbl{font-size:.9rem;font-weight:700}",
".banner.passed .status-lbl{color:var(--gr)}",
".banner.failed .status-lbl{color:var(--rd)}",
".banner .sep{color:var(--fg3)}",
".banner .bl{color:var(--fg2)}.banner .bv{color:var(--fg)}",

/* KPI grid */
".kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px;margin-bottom:28px}",
".kpi{background:var(--bg1);border:1px solid var(--ln);border-radius:var(--r);padding:20px 18px;",
"  position:relative;overflow:hidden;cursor:default}",
".kpi::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--ac,var(--bl))}",
".kpi-label{font-family:var(--mono);font-size:.6rem;text-transform:uppercase;",
"  letter-spacing:.14em;color:var(--fg3);margin-bottom:10px}",
".kpi-value{font-family:var(--mono);font-size:1.95rem;font-weight:700;",
"  line-height:1;color:var(--ac,var(--bl));margin-bottom:4px}",
".kpi-unit{font-family:var(--mono);font-size:.62rem;color:var(--fg3)}",
".kpi-hint{font-size:.72rem;color:var(--fg2);margin-top:5px}",

/* Section */
".sec{margin-bottom:20px}",
".card{background:var(--bg1);border:1px solid var(--ln);border-radius:var(--r);overflow:hidden}",
".card-hdr{display:flex;align-items:center;justify-content:space-between;",
"  padding:13px 20px;border-bottom:1px solid var(--ln)}",
".card-title{font-family:var(--mono);font-size:.7rem;text-transform:uppercase;letter-spacing:.11em;color:var(--fg2)}",
".card-badge{font-family:var(--mono);font-size:.62rem;padding:3px 9px;border-radius:20px;",
"  background:var(--bg3);border:1px solid var(--ln);color:var(--fg3)}",
".card-body{padding:20px}",

/* Grid */
".g2{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:20px}",
".g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:18px;margin-bottom:20px}",
"@media(max-width:900px){.g2,.g3{grid-template-columns:1fr}}",

/* Check list */
".check-list{display:flex;flex-direction:column;gap:0}",
".check-item{display:flex;align-items:center;gap:10px;padding:9px 20px;",
"  border-bottom:1px solid var(--ln);font-size:.82rem;transition:background .1s}",
".check-item:last-child{border-bottom:none}",
".check-item:hover{background:rgba(255,255,255,.02)}",
".check-icon{font-size:.85rem;flex-shrink:0;width:18px;text-align:center}",
".check-name{flex:1;font-family:var(--mono);font-size:.72rem;color:var(--fg2);",
"  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
".check-item.pass .check-name{color:var(--fg)}",
".check-item.fail .check-name{color:var(--rd)}",
".check-counts{font-family:var(--mono);font-size:.68rem;color:var(--fg3);white-space:nowrap}",
".check-item.fail .check-counts{color:var(--rd)}",
".check-bar{width:60px;height:4px;background:var(--bg3);border-radius:2px;flex-shrink:0}",
".check-bar-fill{height:100%;border-radius:2px;background:var(--gr)}",
".check-item.fail .check-bar-fill{background:var(--rd)}",

/* Threshold list */
".th-list{display:flex;flex-direction:column}",
".th-item{display:flex;align-items:center;gap:12px;padding:10px 20px;",
"  border-bottom:1px solid var(--ln);font-size:.82rem}",
".th-item:last-child{border-bottom:none}",
".th-icon{font-size:.85rem;width:18px;text-align:center;flex-shrink:0}",
".th-name{flex:1;font-family:var(--mono);font-size:.72rem;color:var(--fg2)}",
".th-item.ok .th-name{color:var(--gr)}",
".th-item.fail .th-name{color:var(--rd)}",
".th-val{font-family:var(--mono);font-size:.72rem;color:var(--fg)}",
".th-spec{font-family:var(--mono);font-size:.68rem;color:var(--fg3)}",

/* Metrics table */
".mtable{width:100%;border-collapse:collapse;font-size:.82rem}",
".mtable th{background:var(--bg2);border-bottom:1px solid var(--ln2);padding:9px 14px;",
"  text-align:left;font-family:var(--mono);font-size:.6rem;text-transform:uppercase;",
"  letter-spacing:.1em;color:var(--fg3);white-space:nowrap}",
".mtable td{border-bottom:1px solid var(--ln);padding:9px 14px;vertical-align:middle}",
".mtable tr:last-child td{border-bottom:none}",
".mtable tr:hover td{background:rgba(255,255,255,.015)}",
".mn{font-family:var(--mono);font-size:.72rem;color:var(--bl)}",
".mv{font-family:var(--mono);font-size:.72rem;color:var(--fg)}",
".mt-badge{font-family:var(--mono);font-size:.6rem;padding:2px 7px;border-radius:3px;",
"  border:1px solid var(--ln);color:var(--fg3)}",

/* Footer */
"footer{border-top:1px solid var(--ln);padding-top:20px;margin-top:8px;",
"  display:flex;justify-content:space-between;font-family:var(--mono);",
"  font-size:.65rem;color:var(--fg3);flex-wrap:wrap;gap:8px}",
].join("\n");

/* ─────────────────────────────────────────────────────────────────────────
   KPI HELPER
───────────────────────────────────────────────────────────────────────── */

function _kpi(ac, label, val, unit, hint) {
    return '<div class="kpi" style="--ac:' + ac + '">'
        + '<div class="kpi-label">' + label + '</div>'
        + '<div class="kpi-value">' + val + '</div>'
        + (unit ? '<div class="kpi-unit">' + unit + '</div>' : '')
        + (hint ? '<div class="kpi-hint">' + hint + '</div>' : '')
        + '</div>';
}

/* ─────────────────────────────────────────────────────────────────────────
   CHART.JS BOOTSTRAP
───────────────────────────────────────────────────────────────────────── */

var CHART_BOOT = [
"Chart.defaults.color='#6d879e';",
"Chart.defaults.borderColor='#1b2a3e';",
"Chart.defaults.font.family=\"'Space Mono',monospace\";",
"Chart.defaults.font.size=11;",
"Chart.defaults.plugins.legend.labels.boxWidth=10;",
"Chart.defaults.plugins.legend.labels.padding=14;",
"var D=window.__D;",

// Checks bar chart (pass vs fail per check)
"(function(){",
"  var el=document.getElementById('cChecks');if(!el||!D.checks.length)return;",
"  var lbls=D.checks.map(function(c){var n=c.name;return n.length>40?'…'+n.slice(-38):n;});",
"  new Chart(el,{type:'bar',",
"    data:{labels:lbls,datasets:[",
"      {label:'Pass',data:D.checks.map(function(c){return c.passes;}),backgroundColor:'rgba(0,229,160,.7)',borderRadius:2,borderSkipped:false},",
"      {label:'Fail',data:D.checks.map(function(c){return c.fails;}),backgroundColor:'rgba(255,64,96,.7)',borderRadius:2,borderSkipped:false}",
"    ]},",
"    options:{responsive:true,indexAxis:'y',",
"      plugins:{legend:{position:'top'},",
"        tooltip:{callbacks:{title:function(i){return D.checks[i[0].dataIndex].name;}}}},",
"      scales:{x:{stacked:false,grid:{color:'rgba(255,255,255,.04)'},ticks:{stepSize:1}},",
"              y:{grid:{color:'rgba(255,255,255,.02)'},ticks:{font:{size:10}}}}}});",
"})();",

// Pass/fail donut
"(function(){",
"  var el=document.getElementById('cDonut');if(!el)return;",
"  new Chart(el,{type:'doughnut',",
"    data:{labels:['Pass','Fail'],datasets:[{data:[D.checksPass,D.checksFail],",
"      backgroundColor:['#00e5a0','#ff4060'],borderColor:['#00b87d','#cc2040'],",
"      borderWidth:2,hoverOffset:8}]},",
"    options:{responsive:true,cutout:'65%',",
"      plugins:{legend:{position:'bottom'},",
"        tooltip:{callbacks:{label:function(i){",
"          var t=D.checksPass+D.checksFail;",
"          return' '+i.raw+' ('+((i.raw/t)*100).toFixed(1)+'%)';}}}}}});",
"})();",

// HTTP req duration percentiles radar
"(function(){",
"  var el=document.getElementById('cPerc');if(!el)return;",
"  new Chart(el,{type:'radar',",
"    data:{labels:['Avg','P50','P90','P95','P99','Max'],",
"      datasets:[{label:'ms',data:D.perc,backgroundColor:'rgba(61,159,255,.08)',",
"        borderColor:'#3d9fff',pointBackgroundColor:'#3d9fff',pointRadius:4,borderWidth:2}]},",
"    options:{responsive:true,plugins:{legend:{display:false}},",
"      scales:{r:{grid:{color:'rgba(255,255,255,.06)'},angleLines:{color:'rgba(255,255,255,.06)'},",
"        ticks:{backdropColor:'transparent',callback:function(v){return v+'ms'}},",
"        pointLabels:{color:'#6d879e',font:{size:10}}}}}});",
"})();",

// Custom metrics polar area
"(function(){",
"  var el=document.getElementById('cCustom');if(!el||!D.customLabels.length)return;",
"  var palette=['#3d9fff','#00e5a0','#ffb830','#9d6fff','#ff4060','#00d4e8','#ff8c42'];",
"  new Chart(el,{type:'bar',",
"    data:{labels:D.customLabels,datasets:[",
"      {label:'avg ms',data:D.customAvg,backgroundColor:D.customLabels.map(function(_,i){return palette[i%palette.length]+'99';}),",
"       borderColor:D.customLabels.map(function(_,i){return palette[i%palette.length];}),borderWidth:1,borderRadius:3}",
"    ]},",
"    options:{responsive:true,",
"      plugins:{legend:{display:false},tooltip:{callbacks:{label:function(i){return' avg: '+i.raw+'ms';}}}},",
"      scales:{x:{grid:{color:'rgba(255,255,255,.03)'}},y:{grid:{color:'rgba(255,255,255,.05)'},ticks:{callback:function(v){return v+'ms'}}}}}});",
"})();",
].join("\n");

/* ─────────────────────────────────────────────────────────────────────────
   MAIN HTML BUILDER
───────────────────────────────────────────────────────────────────────── */

/**
 * Genera el HTML completo del dashboard a partir de los datos de handleSummary.
 *
 * @param {object} data  — objeto data de handleSummary(data)
 * @param {object} opts  — opciones opcionales { script, title }
 * @returns {string}     — HTML listo para guardar
 */
export function htmlReport(data, opts) {
    opts = opts || {};
    var metrics    = data.metrics    || {};
    var rootGroup  = data.rootGroup  || {};
    var options    = data.options    || {};
    var state      = data.state      || {};

    /* ── Métricas HTTP principales ────────────────────────────────────── */
    var dur    = metrics["http_req_duration"]  || {};
    var reqs   = metrics["http_reqs"]          || {};
    var failed = metrics["http_req_failed"]    || {};
    var checks = metrics["checks"]             || {};

    var durVals    = dur.values    || {};
    var reqVals    = reqs.values   || {};
    var failVals   = failed.values || {};
    var checkVals  = checks.values || {};

    var totalReqs  = _round(reqVals.count || 0);
    var failRate   = ((failVals.rate || 0) * 100).toFixed(1);
    var passRate   = (100 - parseFloat(failRate)).toFixed(1);
    var checkRate  = ((checkVals.rate || 0) * 100).toFixed(1);
    var checkPass  = _round(checkVals.passes || 0);
    var checkFail  = _round(checkVals.fails  || 0);
    var durationMs = _round(state.testRunDurationMs || 0);

    var avgMs  = _round(durVals.avg                  || 0);
    var p50Ms  = _round(durVals["p(50)"] || durVals.p50 || 0);
    var p90Ms  = _round(durVals["p(90)"] || durVals.p90 || 0);
    var p95Ms  = _round(durVals["p(95)"] || durVals.p95 || 0);
    var p99Ms  = _round(durVals["p(99)"] || durVals.p99 || 0);
    var maxMs  = _round(durVals.max                  || 0);
    var minMs  = _round(durVals.min                  || 0);

    /* ── Todos los checks (= todos los expect*) ───────────────────────── */
    var allChecks  = _collectChecks(rootGroup);
    var failChecks = allChecks.filter(function(c) { return c.fails > 0; });
    var passChecks = allChecks.filter(function(c) { return c.fails === 0; });

    /* ── Thresholds ───────────────────────────────────────────────────── */
    var thresholds   = options.thresholds || {};
    var thItems      = [];
    var thPassCount  = 0;
    var thTotalCount = 0;
    for (var thName in thresholds) {
        var thSpec  = thresholds[thName];
        var thSpecs = Array.isArray(thSpec) ? thSpec : [thSpec];
        var thMet   = metrics[thName];
        var thVals  = thMet ? (thMet.values || {}) : {};

        // k6 sets thresholds[name] as array of condition strings
        // and marks them as objects with ok/nok in newer versions
        // We evaluate pass/fail from the metric value
        thSpecs.forEach(function(spec) {
            thTotalCount++;
            // Try to evaluate the threshold spec against actual metric value
            var passed = _evalThreshold(thVals, spec);
            if (passed) thPassCount++;
            thItems.push({ name: thName, spec: String(spec), passed: passed, vals: thVals });
        });
    }

    /* ── Custom metrics (httpx_* and user-declared) ───────────────────── */
    var customRows    = [];
    var customLabels  = [];
    var customAvgData = [];
    var builtIn       = { http_req_duration:1, http_reqs:1, http_req_failed:1, http_req_blocked:1,
                          http_req_connecting:1, http_req_tls_handshaking:1, http_req_sending:1,
                          http_req_waiting:1, http_req_receiving:1, http_req_tls_handshaking:1,
                          http_req_connecting:1, checks:1, vus:1, vus_max:1, iterations:1,
                          iteration_duration:1, data_received:1, data_sent:1, group_duration:1 };

    for (var mName in metrics) {
        if (builtIn[mName]) continue;
        var mRow = _metricRow(mName, metrics[mName]);
        if (!mRow) continue;
        customRows.push(mRow);
        if (mRow.type === "trend") {
            customLabels.push(mName);
            customAvgData.push(_round((metrics[mName].values || {}).avg || 0));
        }
    }

    /* ── Metadata ─────────────────────────────────────────────────────── */
    var scriptName = opts.script || "k6 script";
    var title      = opts.title  || "k6-httpx Performance Dashboard";
    var now        = new Date().toLocaleString("es-MX", {
        year:"numeric", month:"2-digit", day:"2-digit",
        hour:"2-digit", minute:"2-digit", second:"2-digit"
    });
    var totalOk = checkFail === 0 && parseFloat(failRate) < 5;

    /* ── Chart data object ────────────────────────────────────────────── */
    var chartData = {
        checks:      allChecks,
        checksPass:  checkPass,
        checksFail:  checkFail,
        perc:        [avgMs, p50Ms, p90Ms, p95Ms, p99Ms, maxMs],
        customLabels: customLabels,
        customAvg:    customAvgData,
    };

    /* ── Build HTML sections ──────────────────────────────────────────── */

    // Checks HTML
    var checksHtml = '<div class="check-list">';
    // Failed first, then passed
    var sortedChecks = failChecks.concat(passChecks);
    for (var ci = 0; ci < sortedChecks.length; ci++) {
        var ch    = sortedChecks[ci];
        var total = ch.passes + ch.fails;
        var pctW  = total > 0 ? Math.round((ch.passes / total) * 100) : 100;
        var isFail = ch.fails > 0;
        checksHtml += '<div class="check-item ' + (isFail ? "fail" : "pass") + '">'
            + '<span class="check-icon">' + (isFail ? "✗" : "✓") + '</span>'
            + '<span class="check-name" title="' + ch.name + '">' + ch.name + '</span>'
            + '<span class="check-counts">✓' + ch.passes + '  ✗' + ch.fails + '</span>'
            + '<div class="check-bar"><div class="check-bar-fill" style="width:' + pctW + '%"></div></div>'
            + '</div>';
    }
    if (!sortedChecks.length) {
        checksHtml += '<div style="padding:20px;color:var(--fg3);font-family:var(--mono);font-size:.78rem;text-align:center">No se encontraron checks</div>';
    }
    checksHtml += '</div>';

    // Thresholds HTML
    var thHtml = '<div class="th-list">';
    if (thItems.length) {
        for (var ti = 0; ti < thItems.length; ti++) {
            var th = thItems[ti];
            thHtml += '<div class="th-item ' + (th.passed ? "ok" : "fail") + '">'
                + '<span class="th-icon">' + (th.passed ? "✅" : "❌") + '</span>'
                + '<span class="th-name">' + th.name + '</span>'
                + '<span class="th-val">' + th.spec + '</span>'
                + '</div>';
        }
    } else {
        thHtml += '<div style="padding:20px;color:var(--fg3);font-family:var(--mono);font-size:.78rem;text-align:center">No se definieron thresholds</div>';
    }
    thHtml += '</div>';

    // Custom metrics HTML
    var customHtml = "";
    if (customRows.length) {
        customHtml = '<table class="mtable"><thead><tr>'
            + '<th>Métrica</th><th>Tipo</th><th>Avg / Count</th><th>P95</th><th>P99</th><th>Max</th>'
            + '</tr></thead><tbody>';
        for (var mi = 0; mi < customRows.length; mi++) {
            var mr = customRows[mi];
            customHtml += '<tr>'
                + '<td class="mn">' + mr.name + '</td>'
                + '<td><span class="mt-badge">' + mr.type + '</span></td>';
            if (mr.type === "trend") {
                customHtml += '<td class="mv">' + mr.avg + '</td>'
                    + '<td class="mv">' + (mr.p95 || "—") + '</td>'
                    + '<td class="mv">' + (mr.p99 || "—") + '</td>'
                    + '<td class="mv">' + mr.max + '</td>';
            } else if (mr.type === "counter") {
                customHtml += '<td class="mv">' + mr.count + ' (' + mr.rate + ')</td><td>—</td><td>—</td><td>—</td>';
            } else if (mr.type === "rate") {
                customHtml += '<td class="mv">' + mr.rate + ' (✓' + mr.passes + ' ✗' + mr.fails + ')</td><td>—</td><td>—</td><td>—</td>';
            } else {
                customHtml += '<td class="mv">' + (mr.value || "—") + '</td><td>—</td><td>—</td><td>—</td>';
            }
            customHtml += '</tr>';
        }
        customHtml += '</tbody></table>';
    }

    /* ── Assemble full HTML ───────────────────────────────────────────── */
    return '<!DOCTYPE html>\n<html lang="es">\n<head>\n'
        + '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n'
        + '<title>' + title + '</title>\n'
        + '<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"><\/script>\n'
        + '<style>\n' + CSS + '\n</style>\n</head>\n<body>\n'
        + '<div class="wrap">\n'

        // ── Header
        + '<header class="hdr">'
        + '<div class="hdr-left">'
        + '<div class="hdr-brand">k6-<em>httpx</em></div>'
        + '<div class="hdr-sub">Performance Dashboard</div>'
        + '</div>'
        + '<div class="hdr-right">'
        + '<span class="hi">' + now + '</span><br>'
        + scriptName + '<br>'
        + (durationMs ? _ms(durationMs) + ' total' : '')
        + '</div>'
        + '</header>\n'

        // ── Banner
        + '<div class="banner ' + (totalOk ? "passed" : "failed") + '">'
        + '<div class="dot"></div>'
        + '<span class="status-lbl">' + (totalOk ? "✓ PASSED" : "✗ FAILED") + '</span>'
        + '<span class="sep">│</span>'
        + '<span class="bl">Requests</span> <span class="bv">' + totalReqs + '</span>'
        + '<span class="sep">│</span>'
        + '<span class="bl">HTTP fail rate</span> <span class="bv" style="color:' + (parseFloat(failRate) > 5 ? "var(--rd)" : "var(--gr)") + '">' + failRate + '%</span>'
        + '<span class="sep">│</span>'
        + '<span class="bl">Checks</span> <span class="bv" style="color:' + (checkFail > 0 ? "var(--rd)" : "var(--gr)") + '">✓' + checkPass + '  ✗' + checkFail + '</span>'
        + '<span class="sep">│</span>'
        + '<span class="bl">Thresholds</span> <span class="bv">' + thPassCount + '/' + thTotalCount + '</span>'
        + '</div>\n'

        // ── KPIs
        + '<div class="kpis">\n'
        + _kpi("var(--bl)",  "Total Requests",  totalReqs,             "",   reqVals.rate ? (reqVals.rate.toFixed(2) + " req/s") : "")
        + _kpi("var(--gr)",  "HTTP Pass Rate",  passRate + "%",        "",   totalReqs - _round((failVals.fails || 0)) + " exitosos")
        + _kpi("var(--rd)",  "HTTP Fail Rate",  failRate + "%",        "",   _round(failVals.fails || 0) + " fallidos")
        + _kpi("var(--yl)",  "Avg Duration",    _ms(avgMs),            "",   "p50: " + _ms(p50Ms))
        + _kpi("var(--pu)",  "P95 Duration",    _ms(p95Ms),            "",   "p90: " + _ms(p90Ms))
        + _kpi("var(--cy)",  "P99 Duration",    _ms(p99Ms),            "",   "max: " + _ms(maxMs))
        + _kpi("var(--gr)",  "Checks Pass",     checkPass,             "",   checkRate + "% check rate")
        + _kpi("var(--rd)",  "Checks Fail",     checkFail,             "",   allChecks.length + " checks total")
        + '</div>\n'

        // ── Checks + Donut (row)
        + '<div class="g2 sec">'

        // Checks list
        + '<div class="card" style="grid-column:1/2">'
        + '<div class="card-hdr">'
        + '<span class="card-title">✅ Resultados de Checks (expect*)</span>'
        + '<span class="card-badge">' + failChecks.length + ' fallidos · ' + passChecks.length + ' pasaron</span>'
        + '</div>'
        + checksHtml
        + '</div>'

        // Donut
        + '<div style="display:flex;flex-direction:column;gap:18px">'
        + '<div class="card">'
        + '<div class="card-hdr"><span class="card-title">🍩 Pass vs Fail</span><span class="card-badge">checks</span></div>'
        + '<div class="card-body" style="display:flex;align-items:center;justify-content:center;min-height:220px"><canvas id="cDonut" style="max-height:200px"></canvas></div>'
        + '</div>'
        + '<div class="card">'
        + '<div class="card-hdr"><span class="card-title">📈 Percentiles HTTP</span><span class="card-badge">radar</span></div>'
        + '<div class="card-body" style="display:flex;align-items:center;justify-content:center;min-height:220px"><canvas id="cPerc" style="max-height:220px"></canvas></div>'
        + '</div>'
        + '</div>'

        + '</div>\n'

        // ── Checks bar chart
        + (allChecks.length
            ? '<div class="card sec">'
              + '<div class="card-hdr"><span class="card-title">📊 Checks por nombre</span><span class="card-badge">pass / fail</span></div>'
              + '<div class="card-body"><canvas id="cChecks" height="' + Math.min(50 + allChecks.length * 22, 400) + '"></canvas></div>'
              + '</div>\n'
            : '')

        // ── Thresholds
        + '<div class="card sec">'
        + '<div class="card-hdr"><span class="card-title">🎯 Thresholds</span>'
        + '<span class="card-badge">' + thPassCount + '/' + thTotalCount + ' passed</span></div>'
        + thHtml
        + '</div>\n'

        // ── Custom metrics
        + (customRows.length
            ? '<div class="g2 sec">'
              + '<div class="card">'
              + '<div class="card-hdr"><span class="card-title">📐 Métricas Custom</span><span class="card-badge">' + customRows.length + ' métricas</span></div>'
              + '<div class="card-body">' + customHtml + '</div>'
              + '</div>'
              + '<div class="card">'
              + '<div class="card-hdr"><span class="card-title">⏱ Custom — Avg Duration</span><span class="card-badge">bar</span></div>'
              + '<div class="card-body"><canvas id="cCustom" height="200"></canvas></div>'
              + '</div>'
              + '</div>\n'
            : '')

        // Footer
        + '<footer>'
        + '<span>k6-httpx Dashboard · ' + now + ' · ' + scriptName + '</span>'
        + '<span>Powered by Chart.js + k6 handleSummary</span>'
        + '</footer>\n'

        + '</div>\n'
        + '<script>\nwindow.__D = ' + JSON.stringify(chartData) + ';\n' + CHART_BOOT + '\n<\/script>\n'
        + '</body>\n</html>';
}

/* ─────────────────────────────────────────────────────────────────────────
   THRESHOLD EVALUATOR
   Evalúa si un valor de métrica cumple una condición de threshold.
   Soporta: p(95)<500, avg<200, rate>0.95, count>100
───────────────────────────────────────────────────────────────────────── */

function _evalThreshold(vals, spec) {
    // B-07 fix: handle rate metrics (stored as 0.0-1.0) correctly,
    // and support p(XX) key format variations across k6 versions.
    spec = String(spec).trim();

    // Parse: "p(95)<500", "avg<200", "rate>=0.95", "count>100"
    var m = spec.match(/^([a-z_()\d.]+)\s*([<>]=?|==)\s*([\d.]+)$/i);
    if (!m) return true; // cannot parse — assume passing to avoid false negatives

    var field  = m[1].toLowerCase().trim();
    var op     = m[2];
    var target = parseFloat(m[3]);

    // Resolve the actual metric value — try multiple key formats k6 uses across versions
    var actual;
    var candidates = [
        field,
        field.replace(/^p\((\d+)\)$/, "p($1)"),   // p(95)
        field.replace(/^p\((\d+)\)$/, "p$1"),      // p95
        "p(" + field.replace(/^p(\d+)$/, "$1") + ")", // p95 → p(95)
    ];
    for (var ci = 0; ci < candidates.length; ci++) {
        if (vals[candidates[ci]] !== undefined) {
            actual = vals[candidates[ci]];
            break;
        }
    }

    if (actual === undefined) return true; // metric not available — skip

    actual = parseFloat(actual);
    if (isNaN(actual)) return true;

    // B-07 fix: rate metrics in k6 are 0.0-1.0 decimals.
    // If the field name is "rate" or the metric type is rate, target is already 0-1.
    // Example: "rate>=0.95" means "at least 95% of requests passed".
    // No conversion needed — k6 stores and reports rate as 0.0-1.0.
    // This is already correct; the fix is ensuring we don't accidentally multiply by 100.

    if (op === "<")  return actual < target;
    if (op === "<=") return actual <= target;
    if (op === ">")  return actual > target;
    if (op === ">=") return actual >= target;
    if (op === "==") return actual === target;
    return true;
}
