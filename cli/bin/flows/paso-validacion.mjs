// flows/paso-validacion.mjs — #289: pregunta dónde se validan los PR/MR (CI de la forja, local o los
// dos), recomendando según el plan y la visibilidad del destino. Compartido por crear y adoptar.
import { argVal, elige, say, warn, C, YES, DRY } from '../lib/core.mjs';
import { recomendarValidacion, opcionesValidacion, modoDesdeFlag } from '../lib/validacion.mjs';

// -> { validacion, dePago, publico } para el meta de finalizarLocal (o el .faro.json de adoptar).
async function elegirValidacion({ alta, s, cuenta, publico = false }) {
  let dePago = false;
  if (!DRY && alta && alta.plan) { try { dePago = !!(await alta.plan(s, cuenta)).dePago; } catch {} }
  const ctx = { publico, dePago };
  const flag = argVal('validacion');
  if (flag) {
    const m = modoDesdeFlag(flag);
    if (m) return { validacion: m, ...ctx };
    warn(`--validacion=${flag} no es válido (ci, local o ambos): pregunto.`);
  }
  const rec = recomendarValidacion(ctx);
  if (YES) return { validacion: rec.modo, ...ctx };
  say(`  ${C.d}${rec.motivo}${C.x}`);
  const validacion = await elige('¿Dónde se validan los PR/MR?', opcionesValidacion(ctx));
  return { validacion, ...ctx };
}

export { elegirValidacion };
