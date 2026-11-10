// lib/contexto.js — CONTEXTO MINIMO de los hooks (#127): presupuesto, agregacion y deltas.
//
// Lo que un hook inyecta entra en el contexto del modelo y se paga en cada sesion. Medido sobre un
// repo de trabajo real: ~26.000 caracteres al arrancar (la plataforma corta a partir de 10.000 y el
// modelo solo ve 2.000 de vista previa) y ~1.500 en CADA prompt, casi todo identico al anterior.
// Tres piezas, todas puras salvo el estado de deltas (un JSON fuera del repo):
//   - presupuesto: el arranque se monta por PRIORIDAD (seguridad > estado > avisos) y, si no cabe,
//     se recortan los avisos con un puntero al detalle — nunca la seguridad de rama ni los bloqueos.
//   - agregacion: un bloque de N lineas casi iguales ("REQ-02 sin cobertura… REQ-14 sin cobertura…")
//     se dice en UNA linea.
//   - deltas: el hook de prompt solo reemite una seccion si cambio desde el ultimo turno de ESA
//     sesion. El estado vive en CLAUDE_PLUGIN_DATA (o <tmp>/faro), con clave repo + session_id: nunca
//     en el repo de trabajo, que no debe ensuciarse por abrir una sesion.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Por debajo del corte de la plataforma (10.000) con margen: lo que pase de aqui no llega entero.
const PRESUPUESTO_SESION = 8000;

const huella = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

/**
 * Une un bloque de lineas en UNA: cabecera + elementos separados por ' · ', con tope de caracteres.
 * Lo que no cabe se cuenta ("+K mas") y se dice donde verlo, en vez de cortarse a media frase.
 */
function unaLinea(lineas, max = 400, donde = '') {
  const filas = (lineas || []).map((l) => String(l).trim().replace(/^-\s+/, '')).filter(Boolean);
  if (!filas.length) return '';
  // Con cabecera ("Titulo:" + elementos) se respeta; si no, son avisos sueltos y van todos seguidos.
  const conCabecera = filas.length > 1 && /:\s*$/.test(filas[0]);
  const cab = conCabecera ? filas[0] : '';
  const items = conCabecera ? filas.slice(1) : filas;
  let out = cab ? `${cab.replace(/:\s*$/, '')}: ` : '';
  let usados = 0;
  for (const it of items) {
    const sep = usados ? ' · ' : '';
    if (out.length + sep.length + it.length > max && usados) break;
    out += sep + it;
    usados++;
  }
  const resto = items.length - usados;
  if (resto > 0) out += ` (+${resto} mas${donde ? `: ${donde}` : ''})`;
  return out;
}

/**
 * Monta el bloque respetando el presupuesto. secciones: [{ prio, lineas }] en el ORDEN de salida.
 * prio 0 = seguridad y bloqueos (nunca se recorta) · 1 = estado del trabajo · 2 = avisos.
 * Recorta empezando por la prioridad mas baja y, dentro de ella, por el final; deja constancia.
 */
function presupuestar(secciones, max = PRESUPUESTO_SESION, puntero = '', medir = (l) => l.length) {
  const vivas = secciones.map((s) => ({ ...s, lineas: (s.lineas || []).filter((l) => l !== '' && l != null) }));
  // 'medir' cuenta lo que de verdad llega (p. ej. con las rutas del plugin ya reescritas); el margen
  // fijo cubre la linea de recorte.
  const largo = () => vivas.reduce((n, s) => n + s.lineas.reduce((m, l) => m + medir(l) + 1, 0), 0) + medir(puntero) + 120;
  let recortadas = 0;
  for (const prio of [2, 1]) {
    for (let i = vivas.length - 1; i >= 0 && largo() > max; i--) {
      const s = vivas[i];
      if (s.prio !== prio) continue;
      while (s.lineas.length && largo() > max) { s.lineas.pop(); recortadas++; }
    }
  }
  const lineas = vivas.flatMap((s) => s.lineas);
  if (recortadas) lineas.push(`(${recortadas} linea(s) de avisos recortadas para no pasar de ${max} caracteres: el detalle esta en harness.js estado.)`);
  if (puntero) lineas.push(puntero);
  return lineas;
}

// ---------- estado de deltas (por repo + sesion) ----------

function dirEstado(env = process.env) {
  return env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'faro');
}

/** Ruta del estado de deltas. Sin session_id no hay deltas: se devuelve null y se emite todo. */
function rutaEstado(root, sessionId, env = process.env) {
  const sid = String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
  if (!sid) return null;
  return path.join(dirEstado(env), 'contexto', `${huella(path.resolve(String(root)).toLowerCase())}-${sid}.json`);
}

function leerEstado(ruta) {
  if (!ruta) return null;
  try { return JSON.parse(fs.readFileSync(ruta, 'utf8')) || {}; } catch { return {}; }
}

function guardarEstado(ruta, estado) {
  if (!ruta) return;
  try { fs.mkdirSync(path.dirname(ruta), { recursive: true }); fs.writeFileSync(ruta, JSON.stringify(estado)); } catch { /* sin estado: se reemite, no se pierde nada */ }
}

/** Al arrancar (o volver de compactar) el contexto anterior ya no esta: todo vuelve a ser nuevo. */
function reiniciarEstado(ruta) {
  if (!ruta) return;
  try { fs.unlinkSync(ruta); } catch { /* no habia estado */ }
}

/**
 * Deltas del hook de prompt. secciones: [{ clave, lineas, siempre }]. 'siempre' = seguridad: sale en
 * cada turno aunque no cambie. Sin estado previo (null) se emite todo y no se guarda nada.
 */
function deltas(secciones, previo) {
  const antes = (previo && previo.secciones) || {};
  const ahora = {};
  const lineas = [];
  for (const s of secciones) {
    const ls = (s.lineas || []).filter(Boolean);
    if (!ls.length) continue;
    const h = huella(ls.join('\n'));
    ahora[s.clave] = h;
    if (s.siempre || previo === null || antes[s.clave] !== h) lineas.push(...ls);
  }
  return { lineas, estado: { ...(previo || {}), secciones: ahora } };
}

/** ¿Este aviso (tipo + texto) ya se dio en esta sesion? Si no, lo apunta. Sin estado: nunca. */
function yaDicho(estado, tipo, texto) {
  if (!estado) return false;
  estado.dichos = estado.dichos || {};
  const h = huella(`${tipo}\n${texto}`);
  if (estado.dichos[h]) return true;
  estado.dichos[h] = 1;
  return false;
}

module.exports = {
  PRESUPUESTO_SESION, huella, unaLinea, presupuestar,
  dirEstado, rutaEstado, leerEstado, guardarEstado, reiniciarEstado, deltas, yaDicho,
};
