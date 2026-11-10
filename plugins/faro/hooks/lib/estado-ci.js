// lib/estado-ci.js — DOMINIO PURO (#289): de lo que la forja dice del CI de un PR/MR a un estado comun.
//   verde      todo lo que corrio paso
//   rojo       algo fallo por el codigo (manda sobre lo pendiente: ya se sabe que no entra)
//   pendiente  algo en cola o en curso
//   sin-ci     no hay nada configurado que haya corrido
//   sin-cuota  fallo porque la forja no tiene minutos o credito: NO es un fallo del codigo
// Sin E/S: los adaptadores (github-contrato.js, forge-gitlab-proyecto.js) traen los datos.
'use strict';

const ESTADOS = Object.freeze(['verde', 'rojo', 'pendiente', 'sin-ci', 'sin-cuota']);

// GitHub no documenta un conclusion propio para "sin minutos": el job falla sin arrancar y la causa va
// en la anotacion del check-run ("The job was not started because ..."). Si GitHub cambiara el texto,
// el fallo se veria como rojo con la anotacion a la vista: nunca se oculta un fallo.
const RE_FACTURACION = /job was not started because|spending limit|billing|payments have failed|budget is preventing/i;
const FALLO_GH = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);

function normalizarGithub({ checkRuns = [], statuses = [], anotaciones = {} } = {}) {
  if (!checkRuns.length && !statuses.length) return { estado: 'sin-ci', fallidos: [] };
  const rojos = []; const cuota = []; let pendiente = false;
  for (const c of checkRuns) {
    if (c.status !== 'completed') { pendiente = true; continue; }
    if (!FALLO_GH.has(c.conclusion)) continue;
    const notas = anotaciones[c.id] || [];
    (notas.some((n) => RE_FACTURACION.test(String(n.message || ''))) ? cuota : rojos).push(c.name);
  }
  for (const s of statuses) {
    if (s.state === 'pending') pendiente = true;
    else if (s.state === 'failure' || s.state === 'error') rojos.push(s.context);
  }
  if (rojos.length) return { estado: 'rojo', fallidos: rojos };
  if (pendiente) return { estado: 'pendiente', fallidos: [] };
  if (cuota.length) return { estado: 'sin-cuota', fallidos: cuota };
  return { estado: 'verde', fallidos: [] };
}

// Los check-runs fallidos cuyas anotaciones hay que leer para distinguir cuota de codigo.
const fallidosGithub = (checkRuns = []) => checkRuns.filter((c) => c.status === 'completed' && FALLO_GH.has(c.conclusion));

const EN_CURSO_GL = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled', 'manual']);

function normalizarGitlab({ pipeline = null, jobsFallidos = [] } = {}) {
  if (!pipeline || pipeline.status === 'skipped') return { estado: 'sin-ci', fallidos: [] };
  if (pipeline.status === 'success') return { estado: 'verde', fallidos: [] };
  if (EN_CURSO_GL.has(pipeline.status)) return { estado: 'pendiente', fallidos: [] };
  const nombres = jobsFallidos.map((j) => j.name);
  if (jobsFallidos.length && jobsFallidos.every((j) => j.failure_reason === 'ci_quota_exceeded')) return { estado: 'sin-cuota', fallidos: nombres };
  return { estado: 'rojo', fallidos: nombres };
}

// ---- Decision del ciclo (#289): .faro.json > validacion = ci | local | ambos (sin clave: local) ----
const MODOS = new Set(['ci', 'local', 'ambos']);
const modoValidacion = (meta) => (meta && MODOS.has(meta.validacion) ? meta.validacion : 'local');
const consultaCi = (modo) => modo === 'ci' || modo === 'ambos';
const lista = (f) => (f && f.length ? ` (${f.join(', ')})` : '');

// ramas: [{rama, estado, fallidos}] con el estado del CI de su PR/MR (null si no se consulto).
// argsLocal: los args de validate local, o una funcion (ramasQueEntran) => args para medirlos solo
// sobre lo que de verdad se integra.
// -> { integrar, excluidas, args (null si no entra nada), avisos }
function decidirConsolidar({ modo, ramas = [], argsLocal: al }) {
  const argsDe = (integrar) => (typeof al === 'function' ? al(integrar) : al);
  if (!consultaCi(modo)) { const integrar = ramas.map((x) => x.rama); return { integrar, excluidas: [], args: argsDe(integrar), avisos: [] }; }
  const avisos = []; const integrar = []; const excluidas = []; let respaldo = false;
  for (const x of ramas) {
    if (x.estado === 'rojo') { excluidas.push(x); avisos.push(`✖ ${x.rama}: CI en rojo${lista(x.fallidos)}. No entra hasta que pase.`); continue; }
    if (x.estado === 'pendiente') { excluidas.push(x); avisos.push(`⏳ ${x.rama}: CI en curso. No entra hasta que termine.`); continue; }
    integrar.push(x.rama);
    if (x.estado === 'sin-cuota') { respaldo = true; avisos.push(`⚠ ${x.rama}: la forja no tiene minutos de CI (cuota agotada, no es un fallo del código). Valido en local la suite completa.`); }
    else if (x.estado !== 'verde') { respaldo = true; avisos.push(`ⓘ ${x.rama}: sin CI en la forja. Valido en local la suite completa.`); }
  }
  if (!integrar.length) return { integrar, excluidas, args: null, avisos };
  if (respaldo) return { integrar, excluidas, args: ['validate', '--todas'], avisos };
  if (modo === 'ci') { avisos.push('✅ CI verde en la forja: no repito la suite en local (solo el ciclo).'); return { integrar, excluidas, args: ['validate'], avisos }; }
  return { integrar, excluidas, args: argsDe(integrar), avisos };
}

// publicar: la suite completa local se mantiene (lleva el commit de archivado que el CI no ha visto);
// en ci/ambos, ademas, el CI de develop en rojo bloquea.
function decidirPublicar({ modo, estado, fallidos = [] }) {
  if (!consultaCi(modo) || !estado) return { bloquear: false, aviso: null };
  if (estado === 'rojo') return { bloquear: true, aviso: `El CI de develop está en rojo${lista(fallidos)}. No publico hasta que pase.` };
  if (estado === 'sin-cuota') return { bloquear: false, aviso: 'La forja no tiene minutos de CI (cuota agotada). Publico con la validación local completa.' };
  if (estado === 'pendiente') return { bloquear: false, aviso: 'El CI de develop sigue en curso. Publico con la validación local completa.' };
  if (estado === 'sin-ci') return { bloquear: false, aviso: 'develop no tiene CI en la forja. Publico con la validación local completa.' };
  return { bloquear: false, aviso: null };
}

module.exports = { ESTADOS, normalizarGithub, normalizarGitlab, fallidosGithub, RE_FACTURACION, modoValidacion, consultaCi, decidirConsolidar, decidirPublicar };
