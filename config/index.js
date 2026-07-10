import envDev from "./env.dev.js";
import envQA from "./env.qa.js";
import envLocal from "./env.local.js";

const environments = {
    DEV: envDev,
    QA: envQA,
    LOCAL: envLocal
};

const ENV = __ENV.ENV || "DEV";

if (!environments[ENV]) {
    throw new Error(`Ambiente no soportado: ${ENV}`);
}
export default environments[ENV];