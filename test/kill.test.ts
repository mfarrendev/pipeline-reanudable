/*
 * Medición (2026-10-20): bloqueo.ts nunca roba el bloqueo de un proceso
 * muerto (`dueno.host === hostname()` -> `false`). Cayeron 2 de 2: la
 * reanudación tras kill -9 queda bloqueada por el archivo del hijo muerto.
 * Revertido.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PASOS, pipelineLento } from "./apoyo/pipeline-lento.ts";

const HIJO = fileURLToPath(new URL("./apoyo/hijo.ts", import.meta.url));

function contarGuardados(dir: string): number {
  try {
    return readdirSync(join(dir, "pasos")).filter((n) => n.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function lineas(bitacora: string): string[] {
  return existsSync(bitacora) ? readFileSync(bitacora, "utf8").trim().split("\n").filter(Boolean) : [];
}

/** Lanza el pipeline en un proceso hijo y lo mata con SIGKILL cuando han terminado `pasosAntes` pasos. */
async function lanzarYMatar(dir: string, bitacora: string, pasosAntes: number): Promise<void> {
  const hijo = spawn(process.execPath, [HIJO, dir, bitacora, "120"], { stdio: "inherit" });
  const fin = new Promise<void>((r) => hijo.on("exit", () => r()));
  const t0 = Date.now();
  const guardadosAlInicio = contarGuardados(dir);
  // Se espera a que haya archivos de paso GUARDADOS, no a la línea "fin" de
  // la bitácora: entre una y otro está la escritura, y bajo carga matar en
  // ese hueco hacía que el test contara pasos que aún no estaban en disco.
  while (contarGuardados(dir) - guardadosAlInicio < pasosAntes) {
    if (hijo.exitCode !== null) break;
    if (Date.now() - t0 > 15_000) throw new Error("El hijo no avanzó.");
    await new Promise((r) => setTimeout(r, 5));
  }
  // Un poco más para que la muerte caiga a mitad de un paso o de una escritura.
  await new Promise((r) => setTimeout(r, 15));
  hijo.kill("SIGKILL");
  await fin;
}

async function pasosGuardados(dir: string): Promise<string[]> {
  const nombres = await readdir(join(dir, "pasos"));
  const guardados: string[] = [];
  for (const n of nombres.filter((n) => n.endsWith(".json"))) {
    // Todo archivo final debe ser JSON completo: nunca a medio escribir.
    const r = JSON.parse(await readFile(join(dir, "pasos", n), "utf8")) as { nombre: string; resultado: { relleno: string } };
    expect(r.resultado.relleno).toHaveLength(50_000);
    guardados.push(r.nombre);
  }
  return guardados.sort();
}

describe("muerte con kill -9 a mitad de corrida", () => {
  it("reanuda sin repetir pasos completos y sin estado corrupto", { timeout: 30_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr-kill-"));
    const bitacora = join(dir, "bitacora.txt");

    await lanzarYMatar(dir, bitacora, 2);
    const antes = await pasosGuardados(dir);
    expect(antes.length).toBeGreaterThanOrEqual(2);
    expect(antes.length).toBeLessThan(PASOS.length);
    // El bloqueo del hijo muerto quedó en disco; la reanudación debe tomarlo.
    expect(existsSync(join(dir, ".bloqueo"))).toBe(true);

    const yo = String(process.pid);
    await pipelineLento(dir, bitacora, 5);

    const reejecutados = lineas(bitacora)
      .filter((l) => l.startsWith("inicio ") && l.endsWith(` ${yo}`))
      .map((l) => l.split(" ")[1]!);
    for (const p of antes) expect(reejecutados).not.toContain(p);
    expect(reejecutados.sort()).toEqual(PASOS.filter((p) => !antes.includes(p)).sort());

    expect(await pasosGuardados(dir)).toEqual([...PASOS].sort());
    const restos = (await readdir(join(dir, "pasos"))).filter((n) => !n.endsWith(".json"));
    expect(restos).toEqual([]);
    expect(existsSync(join(dir, ".bloqueo"))).toBe(false);
  });

  it("aguanta varias muertes seguidas y cada paso termina guardado una sola vez", { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr-kill-"));
    const bitacora = join(dir, "bitacora.txt");
    for (const corte of [1, 1, 2]) await lanzarYMatar(dir, bitacora, corte);
    await pipelineLento(dir, bitacora, 5);
    expect(await pasosGuardados(dir)).toEqual([...PASOS].sort());

    // Un paso puede haberse INICIADO más de una vez (lo cortaron a mitad),
    // pero solo puede haber TERMINADO más de una vez si se perdió lo
    // guardado, que es justo lo que no debe pasar... salvo la ventana entre
    // "fin" en la bitácora y el rename, que es de microsegundos y se tolera
    // como máximo una vez por muerte.
    const fines = lineas(bitacora).filter((l) => l.startsWith("fin "));
    expect(fines.length).toBeLessThanOrEqual(PASOS.length + 3);
  });
});
