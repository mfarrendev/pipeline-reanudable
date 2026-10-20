/**
 * Un "LLM" de mentira: tarda, cobra por token y a veces responde 529
 * (sobrecarga). No llama a ninguna API. Los precios son de juguete.
 */
import { ErrorTransitorio, type Contexto } from "../src/index.ts";

const USD_POR_MTOK_ENTRADA = 3;
const USD_POR_MTOK_SALIDA = 15;

let semilla = 7;
function azar(): number {
  semilla = (semilla * 1103515245 + 12345) % 2 ** 31;
  return semilla / 2 ** 31;
}

export async function llamarModelo(ctx: Contexto, prompt: string, tokensSalida: number): Promise<string> {
  const tokensEntrada = Math.ceil(prompt.length / 4);
  await new Promise((r) => setTimeout(r, 40 + tokensSalida / 20));
  if (azar() < 0.15) {
    // Una sobrecarga igual cobra la entrada: el gasto se anota antes de fallar.
    await ctx.gastar({ usd: (tokensEntrada * USD_POR_MTOK_ENTRADA) / 1e6, tokensEntrada });
    throw new ErrorTransitorio("529 sobrecargado (simulado)");
  }
  await ctx.gastar({
    usd: (tokensEntrada * USD_POR_MTOK_ENTRADA + tokensSalida * USD_POR_MTOK_SALIDA) / 1e6,
    tokensEntrada,
    tokensSalida,
  });
  return `[respuesta simulada a ${tokensEntrada} tokens de entrada]`;
}
