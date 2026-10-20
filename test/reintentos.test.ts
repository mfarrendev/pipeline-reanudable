import { describe, expect, it } from "vitest";
import {
  REINTENTO_POR_OMISION,
  ErrorPermanente,
  ErrorTransitorio,
  conReintentos,
  esTransitorio,
  esperaParaIntento,
} from "../src/reintentos.ts";

function opciones(esperas: number[]) {
  return { ...REINTENTO_POR_OMISION, baseMs: 100, maximoMs: 1000, azar: () => 1, esperar: async (ms: number) => void esperas.push(ms) };
}

describe("reintentos", () => {
  it("reintenta lo transitorio con espera exponencial y luego acierta", async () => {
    const esperas: number[] = [];
    let llamadas = 0;
    const r = await conReintentos(async () => {
      if (++llamadas < 4) throw new ErrorTransitorio("429");
      return "ok";
    }, opciones(esperas));
    expect(r).toBe("ok");
    expect(llamadas).toBe(4);
    expect(esperas).toEqual([100, 200, 400]);
  });

  it("no reintenta un error permanente", async () => {
    const esperas: number[] = [];
    let llamadas = 0;
    await expect(
      conReintentos(async () => {
        llamadas++;
        throw new ErrorPermanente("400");
      }, opciones(esperas)),
    ).rejects.toThrow("400");
    expect(llamadas).toBe(1);
  });

  it("se rinde al agotar los intentos", async () => {
    let llamadas = 0;
    await expect(
      conReintentos(async () => {
        llamadas++;
        throw Object.assign(new Error("caído"), { status: 503 });
      }, opciones([])),
    ).rejects.toThrow("caído");
    expect(llamadas).toBe(5);
  });

  it("el jitter queda dentro del techo y el techo respeta el máximo", () => {
    expect(esperaParaIntento(10, { baseMs: 100, maximoMs: 1000, azar: () => 0.999 })).toBeLessThan(1000);
    expect(esperaParaIntento(2, { baseMs: 100, maximoMs: 1000, azar: () => 0 })).toBe(0);
  });

  it("clasifica estados HTTP y códigos de red", () => {
    expect(esTransitorio({ status: 429 })).toBe(true);
    expect(esTransitorio({ status: 500 })).toBe(true);
    expect(esTransitorio({ status: 400 })).toBe(false);
    expect(esTransitorio({ code: "ECONNRESET" })).toBe(true);
    expect(esTransitorio(new TypeError("x is undefined"))).toBe(false);
  });
});
