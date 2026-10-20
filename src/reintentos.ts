/** Error que no se arregla reintentando (entrada inválida, 400, 401...). */
export class ErrorPermanente extends Error {
  constructor(mensaje: string, opciones?: ErrorOptions) {
    super(mensaje, opciones);
    this.name = "ErrorPermanente";
  }
}

/** Error que puede desaparecer al reintentar (429, 5xx, red). */
export class ErrorTransitorio extends Error {
  constructor(mensaje: string, opciones?: ErrorOptions) {
    super(mensaje, opciones);
    this.name = "ErrorTransitorio";
  }
}

const CODIGOS_RED = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET"]);

/**
 * Clasificación por omisión. Lo desconocido se trata como PERMANENTE: un
 * error de programación reintentado cinco veces es cinco veces el gasto y
 * el mismo error.
 */
export function esTransitorio(e: unknown): boolean {
  if (e instanceof ErrorPermanente) return false;
  if (e instanceof ErrorTransitorio) return true;
  if (e && typeof e === "object") {
    const o = e as { status?: unknown; code?: unknown };
    if (typeof o.status === "number") return o.status === 408 || o.status === 429 || o.status >= 500;
    if (typeof o.code === "string") return CODIGOS_RED.has(o.code);
  }
  return false;
}

export interface OpcionesReintento {
  /** Intentos totales, incluido el primero. */
  intentos: number;
  baseMs: number;
  maximoMs: number;
  esTransitorio: (e: unknown) => boolean;
  esperar: (ms: number) => Promise<void>;
  azar: () => number;
  alReintentar?: (info: { intento: number; esperaMs: number; error: unknown }) => void;
}

export const REINTENTO_POR_OMISION: OpcionesReintento = {
  intentos: 5,
  baseMs: 500,
  maximoMs: 30_000,
  esTransitorio,
  esperar: (ms) => new Promise((r) => setTimeout(r, ms)),
  azar: Math.random,
};

/** Backoff exponencial con "full jitter": espera al azar en [0, min(max, base*2^n)]. */
export function esperaParaIntento(n: number, o: Pick<OpcionesReintento, "baseMs" | "maximoMs" | "azar">): number {
  const techo = Math.min(o.maximoMs, o.baseMs * 2 ** n);
  return Math.floor(o.azar() * techo);
}

export async function conReintentos<T>(fn: (intento: number) => Promise<T>, o: OpcionesReintento): Promise<T> {
  for (let intento = 1; ; intento++) {
    try {
      return await fn(intento);
    } catch (e) {
      if (intento >= o.intentos || !o.esTransitorio(e)) throw e;
      const esperaMs = esperaParaIntento(intento - 1, o);
      o.alReintentar?.({ intento, esperaMs, error: e });
      await o.esperar(esperaMs);
    }
  }
}
