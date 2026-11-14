// lib/grafo/comprobar.js — la rama frente a los aprendizajes vigentes (#310).
//
// Dos conflictos, sin modelo y sin analisis semantico:
//   - descartado: el diff toca uno de sus ficheros y las lineas anadidas traen sus palabras clave
//     (las del titulo: al menos dos, o todas si tiene menos) — se esta reintroduciendo lo descartado;
//   - cuidado: el diff toca uno de sus ficheros y ningun commit de la rama cita su id (AP-NNN).
// Es un aviso: `aprender comprobar` sale 1 con conflictos, y validate/terminar lo muestran sin fallar.
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const A = require('./aprendizajes.js');
const H = require('./historia.js');
const { palabras } = require('./minado.js');

const TOPE_NO_RASTREADO = 256 * 1024;

function git(root, args) {
  try {
    const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return r.status === 0 ? String(r.stdout) : null;
  } catch { return null; }
}

/** { rel: [lineas anadidas] } de un `git diff -U0`. */
function anadidas(diff, acc = {}) {
  let rel = null;
  for (const l of String(diff || '').split(/\r?\n/)) {
    if (l.startsWith('+++ ')) { rel = l === '+++ /dev/null' ? null : l.slice(4).replace(/^b\//, ''); continue; }
    if (rel && l.startsWith('+')) (acc[rel] = acc[rel] || []).push(l.slice(1));
  }
  return acc;
}

/** Cambios de la rama: ficheros, lineas anadidas y mensajes de sus commits. */
function diffRama(root, base) {
  const c = H.cambiados(root, base);
  const lineas = {};
  let mensajes = '';
  const mb = c.base ? git(root, ['merge-base', c.base, 'HEAD']) : null;
  if (mb) {
    anadidas(git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', `${mb.trim()}..HEAD`]), lineas);
    mensajes = git(root, ['log', '--format=%B', `${mb.trim()}..HEAD`]) || '';
  }
  anadidas(git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', 'HEAD']), lineas);
  for (const rel of (git(root, ['ls-files', '--others', '--exclude-standard']) || '').split(/\r?\n/).filter(Boolean)) {
    try {
      const abs = path.join(root, rel);
      const st = fs.lstatSync(abs);
      if (st.isFile() && st.size <= TOPE_NO_RASTREADO) (lineas[rel] = lineas[rel] || []).push(...fs.readFileSync(abs, 'utf8').split(/\r?\n/));
    } catch { /* ilegible: se ignora */ }
  }
  return { c, rels: c.rels, lineas, mensajes };
}

const citaId = (texto, id) => new RegExp(`(^|[^\\w-])${id}(?!\\w)`, 'i').test(texto);

/** Conflictos de la rama con los aprendizajes vigentes: [{ a, tipo, ficheros, palabras? }]. */
function conflictos(root, { base } = {}) {
  const vig = A.vigentes(root).filter((a) => a.tipo === 'descartado' || a.tipo === 'cuidado');
  if (!vig.length) return { conflictos: [], c: null };
  const d = diffRama(root, base);
  const out = [];
  for (const a of vig) {
    const ficheros = d.rels.filter((r) => a.toca.some((t) => A.cubre(t, r)));
    if (!ficheros.length) continue;
    if (a.tipo === 'cuidado') {
      if (!citaId(d.mensajes, a.id)) out.push({ a, tipo: 'cuidado', ficheros });
      continue;
    }
    const clave = [...palabras(a.titulo)];
    if (!clave.length) continue;
    const vistas = new Set();
    for (const f of ficheros) for (const w of palabras((d.lineas[f] || []).join('\n'))) vistas.add(w);
    const hits = clave.filter((w) => vistas.has(w));
    if (hits.length >= Math.min(2, clave.length)) out.push({ a, tipo: 'descartado', ficheros, palabras: hits });
  }
  return { conflictos: out, c: d.c };
}

const lineaConflicto = (x) => (x.tipo === 'cuidado'
  ? `${A.linea(x.a)} — la rama toca ${x.ficheros.join(', ')} y ningún commit cita ${x.a.id} (${x.a.rel})`
  : `${A.linea(x.a)} — la rama lo reintroduce en ${x.ficheros.join(', ')} (${x.palabras.join(', ')}) (${x.a.rel})`);

/** Lineas de aviso para validate: [] si no hay conflictos o algo falla. */
function avisos(root) {
  try { return conflictos(root).conflictos.map(lineaConflicto); } catch { return []; }
}

module.exports = { conflictos, lineaConflicto, avisos, anadidas };
