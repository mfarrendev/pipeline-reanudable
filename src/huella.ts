import { createHash } from "node:crypto";

/**
 * JSON con las claves de los objetos ordenadas. Sin esto, `{a:1,b:2}` y
 * `{b:2,a:1}` darían huellas distintas y un paso se rehará sin motivo.
 */
export function jsonEstable(valor: unknown): string {
  return JSON.stringify(valor, (_clave, v: unknown) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const ordenado: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) ordenado[k] = (v as Record<string, unknown>)[k];
      return ordenado;
    }
    if (typeof v === "bigint") return `${v}n`;
    if (v === undefined) return null;
    return v;
  });
}

export function huella(valor: unknown): string {
  return createHash("sha256").update(jsonEstable(valor)).digest("hex");
}
