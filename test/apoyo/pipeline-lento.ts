import { appendFileSync } from "node:fs";
import { Corrida } from "../../src/index.ts";

export const PASOS = ["p1", "p2", "p3", "p4", "p5", "p6"];

/**
 * Cadena de seis pasos lentos. Cada uno anota en `bitacora` cuándo empieza
 * y cuándo termina, con escritura síncrona para que la línea quede en disco
 * aunque el proceso muera un instante después.
 */
export async function pipelineLento(dir: string, bitacora: string, msPorPaso: number): Promise<void> {
  const c = new Corrida(dir, { concurrencia: 2 });
  let anterior: string | undefined;
  const promesas: Promise<unknown>[] = [];
  for (const n of PASOS) {
    const opciones = anterior ? { depende: [anterior] } : {};
    promesas.push(
      c.paso(
        n,
        { n },
        async (ctx) => {
          appendFileSync(bitacora, `inicio ${n} ${process.pid}\n`);
          await new Promise((r) => setTimeout(r, msPorPaso));
          await ctx.gastar({ usd: 0.01, tokensEntrada: 100, tokensSalida: 50 });
          appendFileSync(bitacora, `fin ${n} ${process.pid}\n`);
          return { paso: n, relleno: "x".repeat(50_000) };
        },
        opciones,
      ),
    );
    anterior = n;
  }
  await Promise.all(promesas);
  await c.cerrar();
}
