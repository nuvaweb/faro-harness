'use strict';
// Presentación y orquestación de `harness.js despliegue` y `harness.js local`. Sin lógica de proveedor:
// todo lo propio de Cloudflare/Terraform vive en su adaptador. FARO solo diagnostica; el despliegue,
// los secretos y los entornos los prepara devops en la forja.
const fs = require('node:fs');
const path = require('node:path');
const D = require('./despliegue.js');

const ETIQUETA = { error: 'ERROR', aviso: 'AVISO', info: 'info' };

/** Contexto de disco con la config del repo (faro/config.json o .faro.json); sin config usa los defectos. */
function contexto(root, configFile) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(root, configFile), 'utf8')); } catch { /* sin config */ }
  return D.ctxDesdeDisco(root, cfg);
}

/** Líneas del informe humano de `despliegue`. */
function pintar(diag) {
  const out = [];
  if (!diag.detectados.length) out.push('Despliegue: sin destino detectado en este repo (nada que validar).');
  else out.push(`Despliegue detectado: ${diag.detectados.map((d) => d.id).join(', ')}`);
  for (const h of diag.hallazgos) {
    out.push(`  [${ETIQUETA[h.nivel] || h.nivel}] ${h.codigo}: ${h.mensaje}`);
    if (h.arreglo) out.push(`      arreglo: ${h.arreglo}`);
  }
  if (diag.detectados.length) {
    out.push('', 'Siguientes pasos:',
      '  - Corrige los errores de arriba; los avisos son recomendaciones.',
      '  - Los gates de IaC sin credenciales van en el CI de tests (harness.js ci); en local: harness.js despliegue --gates.',
      '  - El despliegue, los secretos y los entornos los prepara devops en la forja: FARO no los gestiona.');
  }
  return out;
}

const hayErrores = (diag) => diag.hallazgos.some((h) => h.nivel === 'error');

/** Adaptadores con destino detectado: [{ ad, det }]. */
function activos(ctx, lista) {
  return (lista || D.adaptadores()).map((ad) => ({ ad, det: ad.detectar(ctx) })).filter((x) => x.det);
}

/** Ejecuta los gates de cada adaptador (sin shell, por ejecutar-pesado). → { ok, lineas } */
function correrGates(ctx, root, ejecutar, lista) {
  const lineas = [];
  let ok = true;
  const gates = activos(ctx, lista).flatMap(({ ad, det }) => ad.gates(ctx, det));
  if (!gates.length) return { ok: true, lineas: ['Sin gates de IaC que ejecutar en este repo.'] };
  for (const g of gates) {
    let res = { status: 'pass', out: '' };
    for (const [cmd, args] of g.pasos) {
      res = ejecutar({ cmd, args, cwd: root, timeoutMs: 600000, etiqueta: `despliegue:${g.gate}`, root });
      if (res.status !== 'pass') break;
    }
    lineas.push(`${res.status === 'pass' ? 'OK   ' : 'FALLA'} ${g.gate}`);
    if (res.status !== 'pass') {
      ok = false;
      String(res.out || '').split('\n').slice(-8).forEach((l) => lineas.push(`    ${l}`));
    }
  }
  return { ok, lineas };
}

/** Primer comando local que ofrece algún adaptador activo → { cmd, args, nota } | null. */
function comandoLocal(ctx, lista) {
  for (const { ad } of activos(ctx, lista)) {
    const c = typeof ad.comandoLocal === 'function' ? ad.comandoLocal(ctx) : null;
    if (c) return c;
  }
  return null;
}

/**
 * ¿Falta declarar la hexagonal en un repo que despliega? `bases`: [{ donde, declarada, conCodigo }].
 * Devuelve los mensajes de error (uno por base con código y sin la sección '## Hexagonal').
 */
function hexagonalExigida(diag, bases) {
  if (!diag.detectados.length) return [];
  return bases.filter((b) => b.conCodigo && !b.declarada).map((b) =>
    `[despliegue] repo que despliega sin hexagonal declarada (${b.donde}): declara la sección '## Hexagonal' en ARCHITECTURE.md; propuesta y pasos con harness.js hexagonal --plan${b.id ? ` ${b.id}` : ''}`);
}

/** Los errores de despliegue se muestran en validate como avisos (bloquean solo en `harness.js despliegue`). */
function avisosDeValidate(diag) {
  return diag.hallazgos.filter((h) => h.nivel === 'error').map((h) => `[despliegue] ${h.codigo}: ${h.mensaje} (detalle: harness.js despliegue)`);
}

/**
 * Cableado de validate con los fallos aislados: si el diagnóstico falla, aviso y nada más; si falla la lectura
 * de la hexagonal, aviso explícito (la exigencia no se salta en silencio). → { errs, warns }
 */
function enValidate({ diagnosticar, bases }) {
  const errs = [];
  const warns = [];
  let diag;
  try { diag = diagnosticar(); } catch (e) { return { errs, warns: [`[despliegue] diagnóstico de despliegue no disponible: ${e && e.message}`] }; }
  if (!diag.detectados.length) return { errs, warns };
  warns.push(...avisosDeValidate(diag));
  try { errs.push(...hexagonalExigida(diag, bases())); } catch (e) { warns.push(`[despliegue] no se pudo comprobar la hexagonal exigida a un repo que despliega: ${e && e.message}`); }
  return { errs, warns };
}

module.exports = { enValidate, contexto, pintar, hayErrores, correrGates, comandoLocal, hexagonalExigida, avisosDeValidate };
