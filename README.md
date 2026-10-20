# pipeline-reanudable

Motor mínimo para correr trabajos caros por pasos, con el estado de cada paso
guardado en disco. Pensado para pipelines de IA, donde cada paso es una o
varias llamadas a un modelo que cuestan tiempo y dinero, pero sirve para
cualquier trabajo largo.

TypeScript, ESM, Node 24, sin dependencias de runtime.

## El problema

Un pipeline escrito como una sola función request-response guarda todo en
memoria hasta el final. Si dura dos horas y se cae en la hora uno (un 529 del
proveedor, un deploy, el portátil que se suspende), se pierde la hora y se
pierde lo pagado: la siguiente vez hay que volver a hacer, y a pagar, todas
las llamadas que ya habían salido bien.

La alternativa es tratar cada paso como una unidad con resultado propio en
disco. Al volver a correr, lo que ya está hecho se lee y lo que falta se
ejecuta. Eso abre otras preguntas, que son las que resuelve esta librería:
cuándo un resultado guardado sigue sirviendo, qué pasa si el proceso muere
mientras escribe, cuánto se gastó en total entre varias reanudaciones y
cómo evitar que dos procesos corran lo mismo a la vez.

## Diseño

- **Un archivo por paso.** `<dir>/pasos/<nombre>.json` guarda el resultado,
  el costo y una huella. La escritura es atómica: archivo temporal en la
  misma carpeta, `fsync`, `rename`. Un proceso que muere a mitad deja como
  mucho un temporal huérfano, que se borra al abrir la corrida; nunca un
  JSON cortado con nombre definitivo.
- **Huella.** SHA-256 de un JSON con claves ordenadas que incluye las
  entradas del paso, su `version`, su `modelo` y las huellas de los pasos de
  los que depende. Si la huella guardada coincide, el paso no corre. Si
  cambia algo, se rehace, y como la huella de los dependientes incluye la
  suya, se rehace también todo lo que cuelga de él. Los pasos que no
  dependen de lo que cambió se siguen leyendo de disco.
- **Grafo.** Un paso declara `depende: ["a", "b"]`; espera a esos pasos y
  recibe sus resultados en `ctx.dependencias`. Lo independiente corre en
  paralelo, con un máximo de `concurrencia` pasos a la vez (4 por omisión).
- **Reintentos.** Backoff exponencial con jitter completo (espera al azar
  entre 0 y `min(maximoMs, baseMs * 2^n)`). Solo se reintenta lo
  transitorio: `ErrorTransitorio`, estados 408, 429 y 5xx, y errores de red
  (`ECONNRESET`, `ETIMEDOUT`...). `ErrorPermanente` y cualquier error
  desconocido no se reintentan: un error de programación repetido cinco
  veces cuesta cinco veces y falla igual.
- **Costo.** El paso reporta lo que gasta con `ctx.gastar({ usd, tokensEntrada,
  tokensSalida })`. Cada reporte se agrega en el momento a
  `<dir>/costos.jsonl`, así que un intento que falla o un proceso que muere
  igual queda contado. El gasto acumulado se calcula desde ese libro.
- **Tope de gasto.** Con `topeUSD`, un paso no se inicia si lo gastado más lo
  comprometido por los pasos en curso más su `estimadoUSD` pasaría el tope.
  Lanza `TopeDeGastoExcedido`. Lo ya guardado sigue en disco: subir el tope y
  volver a correr reanuda desde ahí.
- **Bloqueo.** Al abrir, la corrida crea `<dir>/.bloqueo` con `O_EXCL`
  (crear es atómico, gana un solo proceso) y anota su PID. Si el archivo
  existe y ese PID ya no vive en esta máquina, el bloqueo se considera
  abandonado y se toma. Un bloqueo de otra máquina no se roba nunca.

## API

```ts
import { Corrida, ErrorTransitorio } from "pipeline-reanudable";

const c = new Corrida("salida/mi-corrida", { concurrencia: 3, topeUSD: 5 });

const texto = c.paso("extraer", { archivo: "contrato.pdf" }, async (ctx) => {
  const r = await llamarModelo(/* ... */);
  await ctx.gastar({ usd: r.costo, tokensEntrada: r.entrada, tokensSalida: r.salida });
  return r.texto;
}, { modelo: "modelo-x", version: 2, estimadoUSD: 0.3 });

const resumen = c.paso("resumir", {}, async (ctx) => {
  const t = ctx.dependencias.extraer as string;
  // ...
}, { depende: ["extraer"], modelo: "modelo-x", version: 1 });

await resumen;
console.log(c.resumen()); // ejecutados, reanudados, gastadoUSD, ahorradoUSD, ...
await c.cerrar();          // suelta el bloqueo
```

`paso(nombre, entradas, fn, opciones?)`

| opción | uso |
| --- | --- |
| `version` | Súbela cuando cambie el código o el prompt del paso. |
| `modelo` | Cambiarlo invalida lo guardado. |
| `depende` | Nombres de pasos ya declarados. |
| `estimadoUSD` | Lo que se espera gastar; lo usa el tope. |
| `reintentos` | `intentos`, `baseMs`, `maximoMs`, `esTransitorio`. |

El contexto `ctx` trae `intento` (desde 1), `dependencias` y `gastar()`.
`new Corrida(dir, opciones)` acepta `concurrencia`, `topeUSD`, `reintentos`
y `alEvento`, que recibe `inicio`, `fin`, `reanudado`, `reintento` y `error`.

Las entradas y los resultados tienen que ser serializables a JSON.

## Ejemplo

`ejemplo/` tiene un pipeline de juguete con un modelo simulado (no llama a
ninguna API): resume ocho documentos en paralelo, extrae temas de los
resúmenes y redacta un informe. El modelo simulado cobra por token y
responde "sobrecargado" el 15 % de las veces. El script corre el pipeline
cuatro veces sobre la misma carpeta:

```
$ npm run ejemplo

    reintento temas (intento 1, espera 9 ms)
    la corrida se detuvo: se cortó la luz (simulado)
1) primera corrida, se cae en 'temas'
    ejecutados: 8  reanudados: 0
    gastado ahora: USD 0.1439  ahorrado al reanudar: USD 0.0000  acumulado: USD 0.1439
2) reanudación
    ejecutados: 2  reanudados: 8
    gastado ahora: USD 0.0828  ahorrado al reanudar: USD 0.1208  acumulado: USD 0.2267
3) otra vez, sin cambios
    ejecutados: 0  reanudados: 10
    gastado ahora: USD 0.0000  ahorrado al reanudar: USD 0.2036  acumulado: USD 0.2267
    reintento temas (intento 1, espera 11 ms)
    reintento informe (intento 1, espera 19 ms)
    reintento informe (intento 2, espera 23 ms)
4) cambia doc3
    ejecutados: 3  reanudados: 7
    gastado ahora: USD 0.0976  ahorrado al reanudar: USD 0.1064  acumulado: USD 0.3243
```

En la corrida 1 los ocho resúmenes quedan guardados y el paso `temas` se cae
después de pagar su llamada. La 2 solo corre `temas` e `informe`. La
diferencia entre lo gastado en la 1 (0,1439) y lo ahorrado en la 2 (0,1208)
es justamente la llamada de `temas` que se pagó y se perdió: el libro de
costos la cuenta aunque el paso no haya quedado guardado. En la 4 cambia un
documento y se rehacen su resumen, `temas` e `informe`; los otros siete
resúmenes se leen de disco. Los milisegundos de espera varían entre
corridas por el jitter.

## Pruebas

```
npm test          # vitest
npm run typecheck
npm run build     # dist/
```

Las pruebas miran conducta, no texto. La de `test/kill.test.ts` lanza el
pipeline en un proceso hijo, lo mata con `SIGKILL` cuando ya hay pasos
guardados, reanuda en el proceso de la prueba y comprueba que ningún paso
completo se vuelve a ejecutar, que todos los JSON se leen enteros, que no
quedan temporales y que el bloqueo del hijo muerto se recupera. Otra
variante lo mata tres veces seguidas.

Varias pruebas se midieron metiendo el defecto a mano en `src/` y
comprobando que caen; la mutación y el conteo están anotados al inicio de
cada archivo de prueba.

## Limitaciones

- **Exactamente una vez no existe.** Si el proceso muere después de que el
  modelo respondió y antes del `rename`, ese paso se vuelve a ejecutar y se
  vuelve a pagar. Lo que sí se garantiza es que un paso guardado no se
  repite.
- **Un nodo.** El bloqueo usa el PID y sirve en una sola máquina. Sobre un
  disco de red compartido no detecta procesos muertos de otra máquina, y
  `O_EXCL` en NFS antiguo no es confiable.
- **Reutilización de PID.** Si el proceso dueño murió y el sistema le dio su
  PID a otro proceso vivo, el bloqueo parece tomado y hay que borrar
  `.bloqueo` a mano.
- **El tope es tan bueno como la estimación.** Se frena antes de iniciar un
  paso, no a mitad: un paso que gasta más de lo estimado puede pasar el
  tope.
- **La cascada es por huella, no por contenido.** Si un paso se rehace y da
  exactamente el mismo resultado, sus dependientes se rehacen igual.
- **Todo en JSON.** Resultados grandes o binarios conviene guardarlos aparte
  y devolver su ruta.
- **Sin recolección.** Los archivos de pasos que ya no se declaran quedan en
  disco.
- `fsync` de la carpeta no está disponible en Windows; ahí el `rename` es
  atómico pero puede no sobrevivir a un corte de luz.

## Licencia

MIT. Ver `LICENSE`.
