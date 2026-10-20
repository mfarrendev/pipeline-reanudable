import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tomarBloqueo } from "./bloqueo.ts";
import { escribirAtomico, leerJsonSiExiste, limpiarTemporales } from "./disco.ts";
import { huella } from "./huella.ts";
import { REINTENTO_POR_OMISION, conReintentos, type OpcionesReintento } from "./reintentos.ts";
import { Semaforo } from "./semaforo.ts";

export interface Costo {
  usd: number;
  tokensEntrada: number;
  tokensSalida: number;
}

export interface Gasto {
  usd: number;
  tokensEntrada?: number;
  tokensSalida?: number;
}

export interface Contexto {
  /** Intento actual, desde 1. */
  intento: number;
  /** Resultados de los pasos declarados en `depende`, por nombre. */
  dependencias: Readonly<Record<string, unknown>>;
  /**
   * Reporta lo que costó una llamada. Se anota en disco al momento, así
   * que un intento fallido o un proceso que muere después igual cuenta.
   */
  gastar(gasto: Gasto): Promise<void>;
}

export interface OpcionesPaso {
  /** Súbela cuando cambie el código o el prompt del paso: invalida lo guardado. */
  version?: string | number;
  /** Modelo usado; cambiarlo también invalida lo guardado. */
  modelo?: string;
  /** Pasos (ya declarados) cuyo resultado necesita este. */
  depende?: readonly string[];
  /** Cuánto se espera que cueste, para frenar ANTES de pasarse del tope. */
  estimadoUSD?: number;
  reintentos?: Partial<OpcionesReintento>;
}

export interface OpcionesCorrida {
  /** Pasos que pueden correr a la vez. Por omisión, 4. */
  concurrencia?: number;
  /** Tope de gasto acumulado de la corrida (todas las reanudaciones). */
  topeUSD?: number;
  reintentos?: Partial<OpcionesReintento>;
  alEvento?: (e: Evento) => void;
}

export type Evento =
  | { tipo: "reanudado"; paso: string; ahorradoUSD: number }
  | { tipo: "inicio"; paso: string; motivo: "nuevo" | "cambio" }
  | { tipo: "fin"; paso: string; costo: Costo }
  | { tipo: "reintento"; paso: string; intento: number; esperaMs: number; error: unknown }
  | { tipo: "error"; paso: string; error: unknown };

export interface RegistroPaso<T = unknown> {
  formato: 1;
  nombre: string;
  huella: string;
  version: string | number | null;
  modelo: string | null;
  resultado: T;
  costo: Costo;
  terminado: string;
}

export interface Resumen {
  ejecutados: string[];
  reanudados: string[];
  gastadoUSD: number;
  gastadoAcumuladoUSD: number;
  ahorradoUSD: number;
  tokensEntrada: number;
  tokensSalida: number;
}

export class TopeDeGastoExcedido extends Error {
  constructor(paso: string, gastado: number, estimado: number, tope: number) {
    super(
      `El paso "${paso}" no se inicia: gastado ${gastado.toFixed(4)} + comprometido/estimado ${estimado.toFixed(4)} superaría el tope de ${tope.toFixed(4)} USD.`,
    );
    this.name = "TopeDeGastoExcedido";
  }
}

const NOMBRE_VALIDO = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const costoCero = (): Costo => ({ usd: 0, tokensEntrada: 0, tokensSalida: 0 });

export class Corrida {
  readonly dir: string;
  private readonly opciones: OpcionesCorrida;
  private readonly semaforo: Semaforo;
  private readonly pasos = new Map<string, Promise<{ valor: unknown; huella: string }>>();
  private inicio: Promise<void> | undefined;
  private soltar: (() => Promise<void>) | undefined;
  private gastadoPrevio = 0;
  private reservado = 0;
  private readonly sesion = { ...costoCero() };
  private ahorrado = 0;
  private readonly ejecutados: string[] = [];
  private readonly reanudados: string[] = [];

  constructor(dir: string, opciones: OpcionesCorrida = {}) {
    this.dir = dir;
    this.opciones = opciones;
    this.semaforo = new Semaforo(opciones.concurrencia ?? 4);
  }

  private get carpetaPasos() {
    return join(this.dir, "pasos");
  }
  private get libroCostos() {
    return join(this.dir, "costos.jsonl");
  }

  /** Toma el bloqueo y carga el gasto previo. `paso()` lo llama solo. */
  abrir(): Promise<void> {
    this.inicio ??= (async () => {
      await mkdir(this.carpetaPasos, { recursive: true });
      this.soltar = await tomarBloqueo(join(this.dir, ".bloqueo"));
      await limpiarTemporales(this.carpetaPasos);
      this.gastadoPrevio = await this.leerGastoPrevio();
    })();
    return this.inicio;
  }

  async cerrar(): Promise<void> {
    if (this.inicio) await this.inicio.catch(() => {});
    await Promise.allSettled([...this.pasos.values()]);
    await this.soltar?.();
  }

  /** Gasto acumulado: lo de corridas anteriores más lo de esta. */
  get gastadoUSD(): number {
    return this.gastadoPrevio + this.sesion.usd;
  }

  resumen(): Resumen {
    return {
      ejecutados: [...this.ejecutados],
      reanudados: [...this.reanudados],
      gastadoUSD: this.sesion.usd,
      gastadoAcumuladoUSD: this.gastadoUSD,
      ahorradoUSD: this.ahorrado,
      tokensEntrada: this.sesion.tokensEntrada,
      tokensSalida: this.sesion.tokensSalida,
    };
  }

  paso<T>(nombre: string, entradas: unknown, fn: (ctx: Contexto) => Promise<T>, opciones: OpcionesPaso = {}): Promise<T> {
    if (!NOMBRE_VALIDO.test(nombre)) return Promise.reject(new Error(`Nombre de paso inválido: "${nombre}".`));
    if (this.pasos.has(nombre)) return Promise.reject(new Error(`El paso "${nombre}" ya se declaró en esta corrida.`));
    const deps = opciones.depende ?? [];
    for (const d of deps) {
      if (!this.pasos.has(d)) {
        return Promise.reject(new Error(`El paso "${nombre}" depende de "${d}", que no se ha declarado antes.`));
      }
    }
    const promesa = this.ejecutarPaso(nombre, entradas, fn, opciones, deps);
    this.pasos.set(nombre, promesa);
    // Evita "unhandled rejection" si nadie espera directamente este paso;
    // quien lo espere recibe el error igual.
    promesa.catch(() => {});
    return promesa.then((r) => r.valor as T);
  }

  private async ejecutarPaso<T>(
    nombre: string,
    entradas: unknown,
    fn: (ctx: Contexto) => Promise<T>,
    opciones: OpcionesPaso,
    deps: readonly string[],
  ): Promise<{ valor: unknown; huella: string }> {
    await this.abrir();
    const resueltas = await Promise.all(deps.map((d) => this.pasos.get(d)!));
    const dependencias: Record<string, unknown> = {};
    const huellasDeps: Record<string, string> = {};
    deps.forEach((d, i) => {
      dependencias[d] = resueltas[i]!.valor;
      huellasDeps[d] = resueltas[i]!.huella;
    });

    // La huella de un paso incluye la de sus dependencias: si una se
    // rehace, todo lo que cuelga de ella se rehace también.
    const h = huella({
      entradas,
      version: opciones.version ?? null,
      modelo: opciones.modelo ?? null,
      dependencias: huellasDeps,
    });
    const ruta = join(this.carpetaPasos, `${nombre}.json`);
    const guardado = await this.leerRegistro(ruta);
    if (guardado && guardado.huella === h) {
      this.reanudados.push(nombre);
      this.ahorrado += guardado.costo.usd;
      this.opciones.alEvento?.({ tipo: "reanudado", paso: nombre, ahorradoUSD: guardado.costo.usd });
      return { valor: guardado.resultado, huella: h };
    }

    return this.semaforo.con(async () => {
      const estimado = opciones.estimadoUSD ?? 0;
      const tope = this.opciones.topeUSD;
      if (tope !== undefined && this.gastadoUSD + this.reservado + estimado > tope) {
        throw new TopeDeGastoExcedido(nombre, this.gastadoUSD, this.reservado + estimado, tope);
      }
      this.reservado += estimado;
      const costo = costoCero();
      this.opciones.alEvento?.({ tipo: "inicio", paso: nombre, motivo: guardado ? "cambio" : "nuevo" });
      try {
        const r = { ...REINTENTO_POR_OMISION, ...this.opciones.reintentos, ...opciones.reintentos };
        const valor = await conReintentos(
          (intento) =>
            fn({
              intento,
              dependencias,
              gastar: (g) => this.anotarGasto(nombre, g, costo),
            }),
          {
            ...r,
            alReintentar: (info) => {
              this.opciones.alEvento?.({ tipo: "reintento", paso: nombre, ...info });
              r.alReintentar?.(info);
            },
          },
        );
        const registro: RegistroPaso<T> = {
          formato: 1,
          nombre,
          huella: h,
          version: opciones.version ?? null,
          modelo: opciones.modelo ?? null,
          resultado: valor,
          costo,
          terminado: new Date().toISOString(),
        };
        await escribirAtomico(ruta, JSON.stringify(registro, null, 2));
        this.ejecutados.push(nombre);
        this.opciones.alEvento?.({ tipo: "fin", paso: nombre, costo });
        return { valor, huella: h };
      } catch (error) {
        this.opciones.alEvento?.({ tipo: "error", paso: nombre, error });
        throw error;
      } finally {
        this.reservado -= estimado;
      }
    });
  }

  private async anotarGasto(paso: string, g: Gasto, costo: Costo): Promise<void> {
    if (!(g.usd >= 0) || !Number.isFinite(g.usd)) throw new RangeError(`Gasto inválido en "${paso}": ${g.usd}`);
    const linea = { paso, usd: g.usd, tokensEntrada: g.tokensEntrada ?? 0, tokensSalida: g.tokensSalida ?? 0, en: new Date().toISOString() };
    costo.usd += linea.usd;
    costo.tokensEntrada += linea.tokensEntrada;
    costo.tokensSalida += linea.tokensSalida;
    this.sesion.usd += linea.usd;
    this.sesion.tokensEntrada += linea.tokensEntrada;
    this.sesion.tokensSalida += linea.tokensSalida;
    await appendFile(this.libroCostos, JSON.stringify(linea) + "\n", "utf8");
  }

  private async leerGastoPrevio(): Promise<number> {
    let texto: string;
    try {
      texto = await readFile(this.libroCostos, "utf8");
    } catch {
      return 0;
    }
    let total = 0;
    for (const linea of texto.split("\n")) {
      if (!linea) continue;
      try {
        total += (JSON.parse(linea) as { usd: number }).usd;
      } catch {
        // Última línea cortada por un proceso muerto a mitad de escribir.
      }
    }
    return total;
  }

  private async leerRegistro(ruta: string): Promise<RegistroPaso | undefined> {
    try {
      const r = await leerJsonSiExiste<RegistroPaso>(ruta);
      return r?.formato === 1 ? r : undefined;
    } catch {
      // Un registro ilegible no se arregla solo: se rehace el paso.
      return undefined;
    }
  }
}
