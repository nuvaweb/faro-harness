// Ayudas para tests SENSIBLES AL TIEMPO (#177). Un umbral absoluto en milisegundos da rojos falsos cuando la
// maquina va cargada (bateria completa + otros procesos). Dos remedios, ambos deterministas y visibles:
//   · umbral(baseMs): el umbral escala con la LENTITUD medida de esta maquina ahora mismo (calibracion CPU).
//   · conReintento(fn): si la comprobacion falla, UN unico reintento, marcado en la salida (# REINTENTO).
// Un fallo real (algoritmo cuadratico, hook que cuelga) falla las dos veces: el reintento no lo esconde.

const REFERENCIA_MS = 25;   // lo que tarda la calibracion en una maquina descargada de desarrollo
let _factor;
/** Cuantas veces mas lenta va la maquina ahora que en reposo (>= 1, tope 8). Se mide una vez por proceso. */
export function factorCarga() {
  if (_factor !== undefined) return _factor;
  const t0 = process.hrtime.bigint();
  let x = 0; for (let i = 0; i < 3e6; i++) x = (x + i * 31) % 1000003;
  if (x < 0) throw new Error('inalcanzable');   // evita que se optimice el bucle
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  _factor = Math.min(8, Math.max(1, ms / REFERENCIA_MS));
  return _factor;
}
/** baseMs escalado por la carga actual. */
export const umbral = (baseMs) => Math.round(baseMs * factorCarga());
/** Plazo de un proceso hijo: el de siempre, ampliado por la carga (nunca recortado). */
export const plazo = (baseMs) => Math.round(baseMs * Math.max(1, Math.min(4, factorCarga())));
/** Ejecuta fn; si lanza, lo vuelve a intentar UNA vez, dejando constancia. */
export function conReintento(fn, etiqueta = '') {
  try { return fn(); }
  catch (e) {
    console.log(`# REINTENTO unico${etiqueta ? ` (${etiqueta})` : ''}: la primera medicion fallo (${String((e && e.message) || e).split('\n')[0].slice(0, 120)}); puede ser carga de la maquina`);
    return fn();
  }
}
