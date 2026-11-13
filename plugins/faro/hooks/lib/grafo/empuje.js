// lib/grafo/empuje.js — empuje minimo del grafo FARO por hooks (#301, T10).
//
// Tres avisos cortos, siempre opcionales: lineas en el prompt (<= 8), una linea tras editar y un aviso
// antes de leer un fichero largo entero. Nunca lanzan: cualquier fallo calla (devuelve null o []).
'use strict';

const fs = require('fs');
const path = require('path');
const I = require('./indice.js');
const { tokens, buscar } = require('./consultas.js');

const TOPE_INDICE = 5 * 1024 * 1024;
const TOPE_LECTURA = 2 * 1024 * 1024;
const LINEAS_LARGO = 300;
const MAX_RESULTADOS = 6;
const PUNTOS_MIN = 3;
const MAX_NOMBRES = 3;
// Respuestas de cortesia o confirmacion: no piden nada que el grafo pueda orientar.
const VACIAS = new Set(['vale', 'ok', 'okay', 'gracias', 'perfecto', 'adelante', 'continua', 'continúa', 'sigue', 'listo', 'hecho', 'bien', 'genial', 'dale', 'claro', 'yes', 'thanks', 'done', 'cool']);

/** true si el empuje esta encendido y hay un indice de hasta 5 MB. Barato: no parsea el indice. */
function hayIndice(root) {
  try {
    try {
      const c = require('../config-repo.js').leer(root).grafo;
      if (c && c.empuje === false) return false;
    } catch { /* configuracion ilegible: se asume encendido */ }
    const st = fs.lstatSync(I.rutaIndice(root));
    return st.isFile() && st.size <= TOPE_INDICE;
  } catch { return false; }
}

/** Indice para un hook, o null: apagado (`grafo.empuje === false`), ausente o de mas de 5 MB. */
function cargarParaHook(root) {
  try {
    if (!hayIndice(root)) return null;
    return I.cargar(root) || null;
  } catch { return null; }
}

/** true si el prompt tiene algun token que el grafo pueda orientar (no solo cortesia). */
function promptUtil(prompt) {
  try {
    const toks = tokens(String(prompt || ''));
    return toks.length > 0 && !toks.every((t) => VACIAS.has(t));
  } catch { return false; }
}

/** true si `rel` es un fichero del indice (sin claves heredadas del prototipo). */
function enIndice(idx, rel) {
  return !!(idx && idx.ficheros && Object.prototype.hasOwnProperty.call(idx.ficheros, rel));
}

/** Hasta 8 lineas con los ficheros del indice relacionados con el prompt; [] si no hay nada claro. */
function lineasPrompt(idx, prompt) {
  try {
    const texto = String(prompt || '');
    if (!promptUtil(texto)) return [];
    const toks = tokens(texto);
    const res = buscar(idx, texto, { max: MAX_RESULTADOS }).filter((r) => r.puntos >= PUNTOS_MIN);
    if (!res.length) return [];
    const tema = toks.slice(0, 4).join(' ');
    return [
      `grafo: relacionado con tu petición (harness.js grafo contexto «${tema}» para más)`,
      ...res.map((r) => `${r.rel} — ${r.motivo || 'relacionado'}`),
    ].slice(0, 8);
  } catch { return []; }
}

/** Sufijo con los aprendizajes vigentes del fichero (#302): `· ojo AP-NNN …` en cuidado, `· AP-NNN …` en el resto. */
function sufijoAprendizajes(root, rel) {
  if (!root) return '';
  try {
    const A = require('./aprendizajes.js');
    const aps = A.quetocan(root, rel).sort((a, b) => (a.tipo === 'cuidado' ? 0 : 1) - (b.tipo === 'cuidado' ? 0 : 1) || a.num - b.num);
    const partes = aps.slice(0, 2).map((a) => `· ${a.tipo === 'cuidado' ? 'ojo ' : ''}${A.linea(a).slice(0, 80)}`);
    if (aps.length > 2) partes.push(`· +${aps.length - 2} AP`);
    return partes.join(' ');
  } catch { return ''; }
}

/** `grafo: <rel> lo importan N (a, b…) · tests: M [· ojo AP-NNN …]`, o null si no hay nada que decir. */
function lineaEdicion(idx, rel, root) {
  try {
    const inv = I.aristas(idx).inversas;
    const imp = inv && inv.get(rel);
    const ap = sufijoAprendizajes(root, rel);
    if (!imp || !imp.size) return ap ? `grafo: ${rel} ${ap}` : null;
    const lista = [...imp].sort();
    const tests = lista.filter((r) => enIndice(idx, r) && idx.ficheros[r].tipo === 'test').length;
    const nombres = lista.slice(0, MAX_NOMBRES).join(', ') + (lista.length > MAX_NOMBRES ? '…' : '');
    return `grafo: ${rel} lo importan ${lista.length} (${nombres}) · tests: ${tests}${ap ? ` ${ap}` : ''}`;
  } catch { return null; }
}

/** Aviso antes de un Read sin rango de un fichero de mas de 300 lineas; null en los demas casos. */
function avisoLectura(root, abs, toolInput) {
  try {
    const ti = toolInput || {};
    if (ti.offset !== undefined || ti.limit !== undefined) return null;
    if (typeof abs !== 'string' || !abs) return null;
    const rel = path.relative(path.resolve(root), path.resolve(abs)).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const st = fs.lstatSync(abs);
    if (!st.isFile()) return null;
    const fd = fs.openSync(abs, 'r');
    let n = 0; let leidos = 0; let ultimo = 10;
    try {
      const buf = Buffer.alloc(64 * 1024);
      while (leidos < TOPE_LECTURA) {
        const k = fs.readSync(fd, buf, 0, Math.min(buf.length, TOPE_LECTURA - leidos), null);
        if (k <= 0) break;
        for (let i = 0; i < k; i++) { if (buf[i] === 0) return null; if (buf[i] === 10) n++; }
        ultimo = buf[k - 1];
        leidos += k;
      }
    } finally { fs.closeSync(fd); }
    if (ultimo !== 10) n++;
    if (n <= LINEAS_LARGO) return null;
    return `grafo: ${rel} tiene ${n} líneas — harness.js grafo esqueleto ${rel} antes de leerlo entero`;
  } catch { return null; }
}

module.exports = { hayIndice, promptUtil, enIndice, cargarParaHook, lineasPrompt, lineaEdicion, avisoLectura };
