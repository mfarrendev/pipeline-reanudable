import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Corrida, CorridaBloqueada, ErrorPermanente, ErrorTransitorio, TopeDeGastoExcedido, type OpcionesPaso } from "../src/index.ts";

const sinEspera = { reintentos: { esperar: async () => {} } };
const carpeta = () => mkdtemp(join(tmpdir(), "pr-corrida-"));

/** Pipeline de tres pasos (a -> b -> c) que cuenta cuántas veces corre cada uno. */
async function tresPasos(dir: string, cuenta: Record<string, number>, cambios: { entradaA?: string; versionB?: number; modeloB?: string } = {}) {
  const c = new Corrida(dir, sinEspera);
  const correr = (n: string) => async (ctx: { gastar: (g: { usd: number }) => Promise<void> }) => {
    cuenta[n] = (cuenta[n] ?? 0) + 1;
    await ctx.gastar({ usd: 1 });
    return `${n}!`;
  };
  const a = c.paso("a", { texto: cambios.entradaA ?? "hola" }, correr("a"));
  const optsB: OpcionesPaso = { depende: ["a"], version: cambios.versionB ?? 1, modelo: cambios.modeloB ?? "m1" };
  const b = c.paso("b", {}, correr("b"), optsB);
  const x = c.paso("x", {}, correr("x"));
  const d = c.paso("d", {}, correr("d"), { depende: ["b"] });
  await Promise.all([a, b, x, d]);
  const r = c.resumen();
  await c.cerrar();
  return r;
}

describe("Corrida: reanudación", () => {
  it("la segunda vez no ejecuta nada y cuenta lo ahorrado", async () => {
    const dir = await carpeta();
    const cuenta: Record<string, number> = {};
    await tresPasos(dir, cuenta);
    const r = await tresPasos(dir, cuenta);
    expect(cuenta).toEqual({ a: 1, b: 1, x: 1, d: 1 });
    expect(r.ejecutados).toEqual([]);
    expect(r.reanudados.sort()).toEqual(["a", "b", "d", "x"]);
    expect(r.ahorradoUSD).toBe(4);
    expect(r.gastadoUSD).toBe(0);
    expect(r.gastadoAcumuladoUSD).toBe(4);
  });

  it("devuelve el resultado guardado, no uno nuevo", async () => {
    const dir = await carpeta();
    let n = 0;
    const correr = async () => {
      const c = new Corrida(dir);
      const v = await c.paso("p", 1, async () => ({ valor: ++n }));
      await c.cerrar();
      return v;
    };
    expect(await correr()).toEqual({ valor: 1 });
    expect(await correr()).toEqual({ valor: 1 });
  });

  it("cambiar la entrada de un paso rehace ese paso y los que dependen de él, no los demás", async () => {
    const dir = await carpeta();
    const cuenta: Record<string, number> = {};
    await tresPasos(dir, cuenta);
    const r = await tresPasos(dir, cuenta, { entradaA: "chao" });
    expect(cuenta).toEqual({ a: 2, b: 2, x: 1, d: 2 });
    expect(r.reanudados).toEqual(["x"]);
  });

  it("cambiar la versión o el modelo de un paso lo rehace junto con su descendencia", async () => {
    const dir = await carpeta();
    const cuenta: Record<string, number> = {};
    await tresPasos(dir, cuenta);
    await tresPasos(dir, cuenta, { versionB: 2 });
    expect(cuenta).toEqual({ a: 1, b: 2, x: 1, d: 2 });
    await tresPasos(dir, cuenta, { versionB: 2, modeloB: "m2" });
    expect(cuenta).toEqual({ a: 1, b: 3, x: 1, d: 3 });
  });

  it("un registro corrupto en disco se rehace en vez de romper la corrida", async () => {
    const dir = await carpeta();
    const cuenta: Record<string, number> = {};
    await tresPasos(dir, cuenta);
    await writeFile(join(dir, "pasos", "x.json"), '{"formato":1,"huel');
    await tresPasos(dir, cuenta);
    expect(cuenta.x).toBe(2);
    expect(cuenta.a).toBe(1);
  });
});

describe("Corrida: grafo y concurrencia", () => {
  it("corre en paralelo lo independiente sin pasar el límite", async () => {
    const c = new Corrida(await carpeta(), { concurrencia: 2 });
    let activos = 0;
    let maximo = 0;
    const lento = async () => {
      activos++;
      maximo = Math.max(maximo, activos);
      await new Promise((r) => setTimeout(r, 30));
      activos--;
      return 1;
    };
    const t0 = Date.now();
    await Promise.all(["p1", "p2", "p3", "p4", "p5", "p6"].map((n) => c.paso(n, n, lento)));
    await c.cerrar();
    expect(maximo).toBe(2);
    expect(Date.now() - t0).toBeLessThan(6 * 30);
  });

  it("un paso espera a sus dependencias y recibe sus resultados", async () => {
    const c = new Corrida(await carpeta());
    const orden: string[] = [];
    const a = c.paso("a", 0, async () => {
      await new Promise((r) => setTimeout(r, 20));
      orden.push("a");
      return 2;
    });
    const b = c.paso("b", 0, async () => (orden.push("b"), 3));
    const s = c.paso("suma", 0, async (ctx) => (orden.push("suma"), (ctx.dependencias.a as number) + (ctx.dependencias.b as number)), {
      depende: ["a", "b"],
    });
    expect(await s).toBe(5);
    await Promise.all([a, b]);
    await c.cerrar();
    expect(orden.at(-1)).toBe("suma");
  });

  it("rechaza dependencias no declaradas y nombres repetidos", async () => {
    const c = new Corrida(await carpeta());
    await expect(c.paso("b", 0, async () => 1, { depende: ["a"] })).rejects.toThrow(/no se ha declarado/);
    await c.paso("a", 0, async () => 1);
    await expect(c.paso("a", 0, async () => 1)).rejects.toThrow(/ya se declaró/);
    await expect(c.paso("../fuera", 0, async () => 1)).rejects.toThrow(/inválido/);
    await c.cerrar();
  });

  it("si una dependencia falla, el dependiente falla sin ejecutarse", async () => {
    const c = new Corrida(await carpeta(), sinEspera);
    let corrioB = false;
    const a = c.paso("a", 0, async () => {
      throw new ErrorPermanente("roto");
    });
    const b = c.paso("b", 0, async () => (corrioB = true), { depende: ["a"] });
    await expect(a).rejects.toThrow("roto");
    await expect(b).rejects.toThrow("roto");
    expect(corrioB).toBe(false);
    await c.cerrar();
  });
});

describe("Corrida: reintentos dentro de un paso", () => {
  it("reintenta lo transitorio y anota el gasto de los intentos fallidos", async () => {
    const dir = await carpeta();
    const c = new Corrida(dir, sinEspera);
    const v = await c.paso("p", 0, async (ctx) => {
      await ctx.gastar({ usd: 0.5 });
      if (ctx.intento < 3) throw new ErrorTransitorio("sobrecargado");
      return "listo";
    });
    expect(v).toBe("listo");
    expect(c.resumen().gastadoUSD).toBe(1.5);
    await c.cerrar();
    const lineas = (await readFile(join(dir, "costos.jsonl"), "utf8")).trim().split("\n");
    expect(lineas).toHaveLength(3);
  });

  it("no reintenta un error permanente ni guarda el paso", async () => {
    const dir = await carpeta();
    let intentos = 0;
    const c = new Corrida(dir, sinEspera);
    await expect(c.paso("p", 0, async () => (intentos++, Promise.reject(new ErrorPermanente("400"))))).rejects.toThrow("400");
    expect(intentos).toBe(1);
    await c.cerrar();
    await expect(readFile(join(dir, "pasos", "p.json"))).rejects.toThrow();
  });
});

describe("Corrida: tope de gasto", () => {
  it("se detiene antes de iniciar un paso que pasaría el tope", async () => {
    const dir = await carpeta();
    const c = new Corrida(dir, { topeUSD: 1, concurrencia: 1 });
    const corridos: string[] = [];
    const caro = (n: string) => async (ctx: { gastar: (g: { usd: number }) => Promise<void> }) => {
      corridos.push(n);
      await ctx.gastar({ usd: 0.4 });
    };
    await c.paso("p1", 0, caro("p1"), { estimadoUSD: 0.4 });
    await c.paso("p2", 0, caro("p2"), { estimadoUSD: 0.4 });
    await expect(c.paso("p3", 0, caro("p3"), { estimadoUSD: 0.4 })).rejects.toBeInstanceOf(TopeDeGastoExcedido);
    expect(corridos).toEqual(["p1", "p2"]);
    expect(c.gastadoUSD).toBeCloseTo(0.8);
    await c.cerrar();
  });

  it("el tope cuenta lo gastado en corridas anteriores", async () => {
    const dir = await carpeta();
    const c1 = new Corrida(dir);
    await c1.paso("p1", 0, async (ctx) => ctx.gastar({ usd: 0.9 }));
    await c1.cerrar();
    const c2 = new Corrida(dir, { topeUSD: 1 });
    await expect(c2.paso("p2", 0, async () => {}, { estimadoUSD: 0.2 })).rejects.toBeInstanceOf(TopeDeGastoExcedido);
    await c2.cerrar();
  });

  it("con pasos en paralelo, reserva lo estimado para no pasarse entre todos", async () => {
    const c = new Corrida(await carpeta(), { topeUSD: 1, concurrencia: 4 });
    const lento = async () => new Promise<void>((r) => setTimeout(r, 20));
    const res = await Promise.allSettled(["a", "b", "c"].map((n) => c.paso(n, 0, lento, { estimadoUSD: 0.4 })));
    expect(res.filter((r) => r.status === "rejected")).toHaveLength(1);
    await c.cerrar();
  });
});

describe("Corrida: bloqueo", () => {
  it("dos corridas sobre la misma carpeta no pueden estar abiertas a la vez", async () => {
    const dir = await carpeta();
    const c1 = new Corrida(dir);
    await c1.abrir();
    const c2 = new Corrida(dir);
    await expect(c2.paso("p", 0, async () => 1)).rejects.toBeInstanceOf(CorridaBloqueada);
    await c1.cerrar();
    const c3 = new Corrida(dir);
    expect(await c3.paso("p", 0, async () => 1)).toBe(1);
    await c3.cerrar();
  });
});
