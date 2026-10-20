/** Limita cuántas tareas corren a la vez. Orden de llegada. */
export class Semaforo {
  private libres: number;
  private readonly cola: Array<() => void> = [];

  constructor(cupos: number) {
    if (!Number.isInteger(cupos) || cupos < 1) throw new RangeError("La concurrencia debe ser un entero >= 1.");
    this.libres = cupos;
  }

  async con<T>(fn: () => Promise<T>): Promise<T> {
    if (this.libres > 0) this.libres--;
    else await new Promise<void>((r) => this.cola.push(r));
    try {
      return await fn();
    } finally {
      const siguiente = this.cola.shift();
      if (siguiente) siguiente();
      else this.libres++;
    }
  }
}
