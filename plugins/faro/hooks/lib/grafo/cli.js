// lib/grafo/cli.js — comando `harness.js grafo` (#298, T4): construir y estado del grafo FARO.
//
//   grafo construir           construye (incremental) y guarda el indice; imprime una linea de resumen.
//   grafo construir --fondo   igual, pero en silencio y coordinado: pide turno al gobernador (etiqueta
//                             `grafo`), toma un lock exclusivo `<indice>.lock` y no hace nada si el indice
//                             ya esta fresco o si otro proceso construye. Nunca falla ni imprime.
//   grafo estado              describe el indice guardado.
//
// Variable de entorno (solo para tests): FARO_GRAFO_TRAZA=<fichero>. Cada construccion que llega a
// ejecutarse anade una linea a ese fichero, para contar construcciones sin que `--fondo` hable.
'use strict';

const fs = require('fs');
const path = require('path');
const I = require('./indice.js');
const { extraer } = require('./extraer.js');
const { detectarLayout } = require('../paths.js');

const LINEA_IGNORE = 'faro/.cache/';
const LOCK_OBSOLETO_MS = 120 * 1000;

/** Anade `faro/.cache/` al .gitignore (solo layout faro) sin duplicarlo. */
function asegurarGitignore(root) {
  if (detectarLayout(root) === 'legado') return false;
  const f = path.join(root, '.gitignore');
  let txt = '';
  try {
    if (!fs.lstatSync(f).isFile()) return false; // enlace u otra cosa: no se escribe a traves de el
    txt = fs.readFileSync(f, 'utf8');
  } catch (e) { if (!e || e.code !== 'ENOENT') return false; }
  if (txt.split(/\r?\n/).some((l) => ['faro/.cache/', 'faro/.cache', '/faro/.cache/', '/faro/.cache'].includes(l.trim()))) return false;
  try { fs.writeFileSync(f, `${txt}${txt && !txt.endsWith('\n') ? '\n' : ''}${LINEA_IGNORE}\n`); return true; } catch { return false; }
}

const { dirSinEnlaces } = I;

const FALLO_MS = 24 * 3600 * 1000;
const rutaFallo = (root) => I.rutaIndice(root) + '.fallo';
function marcarFallo(root, ahora) {
  try {
    const f = rutaFallo(root);
    if (!dirSinEnlaces(root, path.dirname(f))) return;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    try { if (fs.lstatSync(f).isSymbolicLink()) return; } catch { /* no existe */ }
    fs.writeFileSync(f, new Date(ahora()).toISOString());
  } catch { /* la marca es un freno opcional */ }
}
function fallo24h(root) {
  try { return Date.now() - fs.lstatSync(rutaFallo(root)).mtimeMs < FALLO_MS; } catch { return false; }
}

/** Construye, guarda y devuelve { idx, reextraidos, ms, guardado }. */
function construirYGuardar(root, ahora, { explicito = false } = {}) {
  const t0 = ahora();
  const previo = I.cargar(root);
  let n = 0;
  const idx = I.construir(root, { previo, _extraer: (rel, txt) => { n++; return extraer(rel, txt); } });
  const guardado = I.guardar(root, idx);
  if (guardado) { asegurarGitignore(root); if (explicito) { try { fs.unlinkSync(rutaFallo(root)); } catch { /* sin marca */ } } }
  else marcarFallo(root, ahora);
  const traza = process.env.FARO_GRAFO_TRAZA;
  if (traza) { try { fs.appendFileSync(traza, `${process.pid} ${Date.now()}\n`); } catch { /* solo test */ } }
  return { idx, reextraidos: n, ms: Math.max(0, ahora() - t0), guardado };
}

function aristasN(idx) { let m = 0; for (const s of I.aristas(idx).aristas.values()) m += s.size; return m; }

/** Toma el lock exclusivo; uno de mas de 120 s se borra y se reintenta una vez. null si lo tiene otro. */
function tomarLock(root, ruta, ahora) {
  for (let intento = 0; intento < 2; intento++) {
    try {
      if (!dirSinEnlaces(root, path.dirname(ruta))) return null;
      fs.mkdirSync(path.dirname(ruta), { recursive: true });
      const fd = fs.openSync(ruta, 'wx');
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, fecha: new Date(ahora()).toISOString() })); } finally { fs.closeSync(fd); }
      return () => { try { fs.unlinkSync(ruta); } catch { /* ya no esta */ } };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return null;
      try {
        if (Date.now() - fs.statSync(ruta).mtimeMs > LOCK_OBSOLETO_MS) { fs.unlinkSync(ruta); continue; }
      } catch { /* desaparecio: se reintenta */ }
      if (intento === 1) return null;
    }
  }
  return null;
}

function fondo(root, ahora) {
  try {
    if (fallo24h(root)) return 0;
    const previo = I.cargar(root);
    if (previo && I.fresco(root, previo)) return 0;
    const g = require('../gobernador.js').intentar({ etiqueta: 'grafo', duracionS: 120 });
    if (g.estado === 'espera') return 0;
    try {
      const liberar = tomarLock(root, I.rutaIndice(root) + '.lock', ahora);
      if (!liberar) return 0;
      try {
        const de_nuevo = I.cargar(root); // otro proceso pudo terminar mientras esperabamos el lock
        if (!(de_nuevo && I.fresco(root, de_nuevo))) construirYGuardar(root, ahora);
      } finally { liberar(); }
    } finally { if (g.liberar) g.liberar(); }
  } catch { /* el segundo plano nunca estorba */ }
  return 0;
}

function hace(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

function cli(argv, { root, out = console.log, ahora = Date.now } = {}) {
  const [sub, ...resto] = argv;
  if (sub === 'construir') {
    if (resto.includes('--fondo')) return fondo(root, ahora);
    const r = construirYGuardar(root, ahora, { explicito: true });
    out(`grafo: ${Object.keys(r.idx.ficheros).length} ficheros, ${aristasN(r.idx)} aristas, ${r.reextraidos} reextraídos, ${r.ms} ms`);
    if (!r.guardado) out('grafo: no se pudo guardar el índice (supera 20 MB o la ruta no es segura)');
    return 0;
  }
  if (sub === 'estado') {
    const idx = I.cargar(root);
    if (!idx) { out('grafo: sin índice — harness.js grafo construir'); return 0; }
    const fresco = I.fresco(root, idx);
    let cambiados = 0;
    if (!fresco) {
      const nuevo = I.construir(root, { previo: idx, _extraer: () => { cambiados++; return { imports: [], exporta: [], es: [], tablas: { define: [], usa: [] } }; } });
      const viejos = new Set(Object.keys(idx.ficheros));
      for (const k of Object.keys(nuevo.ficheros)) viejos.delete(k);
      cambiados += viejos.size;
    }
    const gen = Date.parse(idx.generado);
    out(`grafo: ${Object.keys(idx.ficheros).length} ficheros · ${aristasN(idx)} aristas · generado hace ${Number.isFinite(gen) ? hace(ahora() - gen) : '?'} · ${fresco ? 'fresco' : `desactualizado (${cambiados} cambiados)`}`);
    return 0;
  }
  out('Uso: harness.js grafo construir [--fondo] | estado');
  return sub ? 2 : 0;
}

module.exports = { cli, asegurarGitignore, LINEA_IGNORE };
