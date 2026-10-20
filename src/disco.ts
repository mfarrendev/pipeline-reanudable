import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

const SUFIJO_TEMPORAL = ".tmp-";

/**
 * Escribe `contenido` en `ruta` de forma atómica: primero a un temporal en
 * la misma carpeta, fsync, y luego rename. Un proceso muerto a mitad deja,
 * como mucho, un temporal huérfano; nunca un archivo final a medio escribir.
 * También se hace fsync de la carpeta para que el rename sobreviva a un
 * corte de luz (en sistemas que lo permiten).
 */
export async function escribirAtomico(ruta: string, contenido: string): Promise<void> {
  const carpeta = dirname(ruta);
  await mkdir(carpeta, { recursive: true });
  const temporal = `${ruta}${SUFIJO_TEMPORAL}${process.pid}-${randomBytes(4).toString("hex")}`;
  const fh = await open(temporal, "w");
  try {
    await fh.writeFile(contenido, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(temporal, ruta);
  } catch (e) {
    await unlink(temporal).catch(() => {});
    throw e;
  }
  await sincronizarCarpeta(carpeta);
}

async function sincronizarCarpeta(carpeta: string): Promise<void> {
  try {
    const fh = await open(carpeta, "r");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    // Algunos sistemas (Windows) no permiten abrir carpetas; no es fatal.
  }
}

export async function leerJsonSiExiste<T>(ruta: string): Promise<T | undefined> {
  let texto: string;
  try {
    texto = await readFile(ruta, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  return JSON.parse(texto) as T;
}

/** Borra los temporales que dejó un proceso muerto. Devuelve cuántos borró. */
export async function limpiarTemporales(carpeta: string): Promise<number> {
  let nombres: string[];
  try {
    nombres = await readdir(carpeta);
  } catch {
    return 0;
  }
  let borrados = 0;
  for (const n of nombres) {
    if (n.includes(SUFIJO_TEMPORAL)) {
      await unlink(join(carpeta, n)).catch(() => {});
      borrados++;
    }
  }
  return borrados;
}
