/**
 * Pipeline de juguete: resume N documentos en paralelo, extrae temas de
 * los resúmenes y redacta un informe. Corre cuatro veces seguidas para
 * mostrar qué pasa al reanudar:
 *
 *   1. se cae a mitad (falla el paso "temas");
 *   2. se reanuda: solo corre lo que faltaba;
 *   3. nada cambió: no corre nada;
 *   4. cambia un documento: se rehace su resumen y lo que cuelga de él.
 */
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Corrida, ErrorPermanente, type Resumen } from "../src/index.ts";
import { llamarModelo } from "./llm-simulado.ts";

const DIR = fileURLToPath(new URL("./salida/corrida", import.meta.url));
const MODELO = "modelo-simulado-1";

function documentos(cambiado: boolean): Record<string, string> {
  const docs: Record<string, string> = {};
  for (let i = 1; i <= 8; i++) docs[`doc${i}`] = `Documento ${i}. `.repeat(400 + i * 50);
  if (cambiado) docs.doc3 += " Párrafo agregado después.";
  return docs;
}

async function correr(opciones: { caerEnTemas?: boolean; docCambiado?: boolean }): Promise<Resumen> {
  const c = new Corrida(DIR, {
    concurrencia: 3,
    topeUSD: 1,
    reintentos: { baseMs: 20, maximoMs: 200 },
    alEvento: (e) => {
      if (e.tipo === "reintento") console.log(`    reintento ${e.paso} (intento ${e.intento}, espera ${e.esperaMs} ms)`);
    },
  });
  try {
    const docs = documentos(opciones.docCambiado ?? false);
    const resumenes = Object.entries(docs).map(([id, texto]) =>
      c.paso(`resumen-${id}`, { texto }, (ctx) => llamarModelo(ctx, `Resume:\n${texto}`, 600), {
        modelo: MODELO,
        version: 1,
        estimadoUSD: 0.02,
      }),
    );
    const nombres = Object.keys(docs).map((id) => `resumen-${id}`);
    const temas = c.paso(
      "temas",
      {},
      async (ctx) => {
        const juntos = Object.values(ctx.dependencias).join("\n");
        const r = await llamarModelo(ctx, `Extrae temas:\n${juntos}`, 1500);
        if (opciones.caerEnTemas) throw new ErrorPermanente("se cortó la luz (simulado)");
        return r;
      },
      { depende: nombres, modelo: MODELO, version: 1, estimadoUSD: 0.05 },
    );
    const informe = c.paso("informe", {}, (ctx) => llamarModelo(ctx, `Redacta informe:\n${String(ctx.dependencias.temas)}`, 4000), {
      depende: ["temas"],
      modelo: MODELO,
      version: 1,
      estimadoUSD: 0.1,
    });
    await Promise.allSettled([...resumenes, temas, informe]);
    await informe;
  } catch (e) {
    console.log(`    la corrida se detuvo: ${(e as Error).message}`);
  } finally {
    await c.cerrar();
  }
  return c.resumen();
}

function mostrar(titulo: string, r: Resumen) {
  console.log(`${titulo}`);
  console.log(`    ejecutados: ${r.ejecutados.length}  reanudados: ${r.reanudados.length}`);
  console.log(
    `    gastado ahora: USD ${r.gastadoUSD.toFixed(4)}  ahorrado al reanudar: USD ${r.ahorradoUSD.toFixed(4)}  acumulado: USD ${r.gastadoAcumuladoUSD.toFixed(4)}`,
  );
}

await rm(DIR, { recursive: true, force: true });
mostrar("1) primera corrida, se cae en 'temas'", await correr({ caerEnTemas: true }));
mostrar("2) reanudación", await correr({}));
mostrar("3) otra vez, sin cambios", await correr({}));
mostrar("4) cambia doc3", await correr({ docCambiado: true }));
