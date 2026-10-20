import { pipelineLento } from "./pipeline-lento.ts";

const [dir, bitacora, ms] = process.argv.slice(2);
await pipelineLento(dir!, bitacora!, Number(ms));
