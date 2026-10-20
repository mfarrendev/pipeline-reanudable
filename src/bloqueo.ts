import { hostname } from "node:os";
import { open, readFile, unlink } from "node:fs/promises";

export class CorridaBloqueada extends Error {
  readonly pid: number;
  constructor(ruta: string, pid: number) {
    super(`La corrida ya está tomada por el proceso ${pid} (${ruta}).`);
    this.name = "CorridaBloqueada";
    this.pid = pid;
  }
}

interface ContenidoBloqueo {
  pid: number;
  host: string;
  desde: string;
}

function procesoVivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: existe pero es de otro usuario; cuenta como vivo.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Bloqueo por archivo creado con O_EXCL ("wx"): crear es atómico, así que
 * de dos procesos que lo intentan a la vez gana uno solo. Si el archivo
 * existe pero su dueño murió en esta misma máquina (kill -9, corte), el
 * bloqueo se considera abandonado y se toma. Un bloqueo de otra máquina
 * nunca se roba: no hay forma de saber si ese proceso sigue vivo.
 */
export async function tomarBloqueo(ruta: string): Promise<() => Promise<void>> {
  for (let intento = 0; intento < 3; intento++) {
    try {
      const fh = await open(ruta, "wx");
      const contenido: ContenidoBloqueo = { pid: process.pid, host: hostname(), desde: new Date().toISOString() };
      await fh.writeFile(JSON.stringify(contenido));
      await fh.sync();
      await fh.close();
      let soltado = false;
      return async () => {
        if (soltado) return;
        soltado = true;
        await unlink(ruta).catch(() => {});
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let dueno: ContenidoBloqueo | undefined;
    try {
      dueno = JSON.parse(await readFile(ruta, "utf8")) as ContenidoBloqueo;
    } catch {
      // Archivo vacío o a medio escribir: su dueño murió entre crear y
      // escribir, o lo está escribiendo ahora. Se espera un poco y se relee.
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    if (dueno.host === hostname() && !procesoVivo(dueno.pid)) {
      await unlink(ruta).catch(() => {});
      continue;
    }
    throw new CorridaBloqueada(ruta, dueno.pid);
  }
  throw new CorridaBloqueada(ruta, -1);
}
