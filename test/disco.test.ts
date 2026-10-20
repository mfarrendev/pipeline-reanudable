import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { escribirAtomico, leerJsonSiExiste, limpiarTemporales } from "../src/disco.ts";
import { huella } from "../src/huella.ts";

describe("huella", () => {
  it("no depende del orden de las claves", () => {
    expect(huella({ a: 1, b: { c: 2, d: 3 } })).toBe(huella({ b: { d: 3, c: 2 }, a: 1 }));
  });
  it("cambia si cambia un valor anidado", () => {
    expect(huella({ a: [1, 2] })).not.toBe(huella({ a: [2, 1] }));
  });
});

describe("disco", () => {
  it("escribe atómico sin dejar temporales y lee de vuelta", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr-disco-"));
    const ruta = join(dir, "sub", "x.json");
    await escribirAtomico(ruta, JSON.stringify({ ok: true }));
    expect(await leerJsonSiExiste(ruta)).toEqual({ ok: true });
    expect(await readdir(join(dir, "sub"))).toEqual(["x.json"]);
    expect(await leerJsonSiExiste(join(dir, "no"))).toBeUndefined();
  });
  it("limpia temporales huérfanos sin tocar los archivos finales", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr-disco-"));
    await writeFile(join(dir, "a.json"), "{}");
    await writeFile(join(dir, "a.json.tmp-123-abcd"), "{\"a\":");
    expect(await limpiarTemporales(dir)).toBe(1);
    expect(await readdir(dir)).toEqual(["a.json"]);
    expect(await readFile(join(dir, "a.json"), "utf8")).toBe("{}");
  });
});
