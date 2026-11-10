// validacion.mjs — #289 US-3: dónde se validan los PR/MR del repo (.faro.json > validacion).
//   ci     el CI de la forja manda; en local solo el ciclo
//   local  la suite en local, como siempre (sin clave = local)
//   ambos  el CI de la forja y además la suite local
// La recomendación es pura. El fichero de CI NO se genera aquí: lo escribe el motor (`harness.js ci`
// del plugin instalado), que sabe qué gates tiene el repo; así no hay dos generadores que diverjan.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { leerMetaRepo, escribirMetaRepo } from './meta.mjs';

const MODOS_VALIDACION = Object.freeze(['ci', 'local', 'ambos']);
const consultaCi = (modo) => modo === 'ci' || modo === 'ambos';
const modoDesdeFlag = (v) => { const m = String(v || '').trim().toLowerCase(); return MODOS_VALIDACION.includes(m) ? m : null; };

// Público o plan de pago: el CI de la forja es gratis o va incluido y se puede exigir. Privado en un
// plan gratuito: los minutos son pocos y, sin protección de rama, el pipeline solo informa.
function recomendarValidacion({ publico = false, dePago = false } = {}) {
  if (publico) return { modo: 'ci', motivo: 'El repo es público: los minutos de CI de la forja no cuentan contra tu cuota.' };
  if (dePago) return { modo: 'ci', motivo: 'Tu plan incluye minutos de CI y permite exigir que el pipeline pase antes de integrar.' };
  return { modo: 'local', motivo: 'Repo privado en plan gratuito: los minutos de CI son pocos y, sin protección de rama, el CI sería solo informativo.' };
}

function opcionesValidacion(ctx = {}) {
  const rec = recomendarValidacion(ctx).modo;
  const base = {
    ci: { etiqueta: 'CI de la forja', explica: 'Cada PR/MR se valida en la forja y en local solo corre el ciclo. Gasta minutos de CI; si se agotan, FARO lo detecta y valida en local la suite completa.' },
    local: { etiqueta: 'Local', explica: 'La suite corre en tu máquina al consolidar y al publicar. No gasta minutos de la forja.' },
    ambos: { etiqueta: 'Los dos', explica: 'El CI de la forja y además los tests afectados en local. Más seguro, más lento; gasta minutos de CI (si se agotan, se valida en local).' },
  };
  const out = { [rec]: { ...base[rec], etiqueta: `${base[rec].etiqueta} (Recomendado)` } };
  for (const k of MODOS_VALIDACION) if (k !== rec) out[k] = base[k];
  return out;
}

const RUTAS_CI = { gitlab: '.gitlab-ci.yml', github: '.github/workflows/ci.yml' };
const rutaCi = (forja) => RUTAS_CI[forja] || null;

// El harness del plugin instalado (la última versión de la caché de Claude Code), o null.
function rutaHarnessCache(home = os.homedir()) {
  const base = path.join(home, '.claude', 'plugins', 'cache', 'faro-marketplace', 'faro');
  try {
    const num = (v) => v.split('.').map(Number);
    const cmp = (a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
    const vers = fs.readdirSync(base).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort(cmp);
    for (let i = vers.length - 1; i >= 0; i--) { const h = path.join(base, vers[i], 'hooks', 'harness.js'); if (fs.existsSync(h)) return h; }
  } catch {}
  return null;
}

const ejecutarNode = (harness, args, cwd) => execFileSync(process.execPath, [harness, ...args], { cwd, stdio: 'ignore', timeout: 60000 });

// -> { estado: 'existe' | 'creado' | 'sin-gates' | 'sin-motor', ruta }
//   existe     ya había CI: no se toca
//   creado     el motor lo escribió
//   sin-gates  el repo aún no tiene gates (documental o sin scripts): no hay CI que generar todavía
//   sin-motor  no encuentro el plugin instalado
function generarCi(destino, { forja, harness = rutaHarnessCache(), ejecutar = ejecutarNode } = {}) {
  const ruta = rutaCi(forja);
  if (!ruta) return { estado: 'sin-gates', ruta: null };
  const abs = path.join(destino, ...ruta.split('/'));
  if (fs.existsSync(abs)) return { estado: 'existe', ruta };
  if (!harness || !fs.existsSync(harness)) return { estado: 'sin-motor', ruta };
  try { ejecutar(harness, ['ci'], destino); } catch {}
  return { estado: fs.existsSync(abs) ? 'creado' : 'sin-gates', ruta };
}

function guardarValidacion(destino, modo) {
  if (!MODOS_VALIDACION.includes(modo)) throw new Error(`validacion desconocida: ${modo}`);
  escribirMetaRepo(destino, { ...(leerMetaRepo(destino) || {}), validacion: modo });
}

// Exigir que el pipeline pase solo tiene sentido si el repo YA tiene CI (sin él, toda fusión quedaría
// bloqueada). GitLab lo permite en todos los planes (ajuste del proyecto, por API). GitHub lo hace con
// la protección de rama, que en privados exige plan de pago, y pide el nombre del check: se indica.
function exigirPipeline({ forja, ci, dePago = false, publico = false } = {}) {
  if (ci !== 'creado' && ci !== 'existe') return { accion: null, aviso: null };
  if (forja === 'gitlab') return { accion: 'api', aviso: null };
  if (forja === 'github') {
    if (!dePago && !publico) return { accion: null, aviso: 'Tu plan no permite exigir checks en un repo privado: el CI informa y FARO no integra un PR en rojo.' };
    return { accion: 'indicar', aviso: 'Cuando el CI haya corrido una vez, márcalo como «required status check» en la protección de develop (Settings → Branches).' };
  }
  return { accion: null, aviso: null };
}

export { MODOS_VALIDACION, consultaCi, modoDesdeFlag, recomendarValidacion, opcionesValidacion, rutaCi, rutaHarnessCache, generarCi, guardarValidacion, exigirPipeline };
