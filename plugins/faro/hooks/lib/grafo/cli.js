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

const INTENCIONES = ['contexto', 'esqueleto', 'impacto', 'tests', 'porque', 'superficie', 'legado'];
const PRESUPUESTO_DEFECTO = 40;

/** Recorta a n lineas; si no caben, n-1 mas `… +K más (--presupuesto 2n)`. */
function recortar(lineas, n) {
  if (lineas.length <= n) return lineas;
  if (n < 2) return [`… +${lineas.length} más (--presupuesto ${Math.max(2, n * 2)})`];
  return [...lineas.slice(0, n - 1), `… +${lineas.length - (n - 1)} más (--presupuesto ${n * 2})`];
}

function presupuestoPor(root, pedido) {
  const ent = (v) => (typeof v === 'string' ? /^\d+$/.test(v) : Number.isInteger(v)) && Number(v) >= 1 && Number(v) <= 1000;
  if (pedido !== undefined && ent(pedido)) return Number(pedido);
  try {
    const c = require('../config-repo.js').leer(root).grafo;
    const p = c && c.presupuesto;
    if (Number.isInteger(p) && p > 0) return p;
  } catch { /* configuracion ilegible: defecto */ }
  return PRESUPUESTO_DEFECTO;
}

function intencion(sub, resto, { root, out }) {
  const args = []; let pres; let base;
  for (let i = 0; i < resto.length; i++) {
    if (resto[i] === '--presupuesto') pres = resto[++i];
    else if (resto[i] === '--base') base = resto[++i];
    else args.push(resto[i]);
  }
  if (base !== undefined && (typeof base !== 'string' || !base || base.startsWith('-') || !['impacto', 'tests'].includes(sub))) {
    out('Uso: --base <ref> solo para impacto y tests (la ref no puede empezar por «-»)');
    return 2;
  }
  const idx = I.cargar(root);
  if (!idx) { out('grafo: sin índice — harness.js grafo construir'); return 0; }
  const C = require('./consultas.js'); const H = require('./historia.js');
  const arg = args.join(' ');
  let r;
  try {
    if (sub === 'contexto') r = C.contexto(root, idx, arg);
    else if (sub === 'esqueleto') r = C.esqueleto(root, idx, arg);
    else if (sub === 'superficie') r = C.superficie(root, idx);
    else if (sub === 'legado') r = C.legado(root, idx);
    else if (sub === 'impacto') r = H.impacto(root, idx, { base });
    else if (sub === 'tests') r = H.tests(root, idx, { base });
    else r = H.porque(root, idx, arg);
  } catch { out(`grafo: sin resultados (${sub})`); return 0; }
  let fresco = true;
  try { fresco = I.fresco(root, idx); } catch { /* sin aviso de desactualizado */ }
  const cab = fresco ? [] : ['· índice desactualizado'];
  let lineas = r.lineas.slice();
  if (cab.length && lineas.length) lineas[0] += ` ${cab[0]}`;
  const usado = presupuestoPor(root, pres);
  lineas = recortar(lineas, usado);
  const invalido = pres !== undefined && !((typeof pres === 'string' ? /^\d+$/.test(pres) : Number.isInteger(pres)) && Number(pres) >= 1 && Number(pres) <= 1000);
  for (const l of lineas) out(l);
  if (invalido) out(`(presupuesto inválido: se usa ${usado})`);
  require('./uso.js').registrar(root, { intencion: sub, lineas: lineas.length, ficheros: r.ficheros, idx });
  return 0;
}

function cli(argv, { root, out = console.log, ahora = Date.now } = {}) {
  const [sub, ...resto] = argv;
  if (INTENCIONES.includes(sub)) return intencion(sub, resto, { root, out });
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
    try {
      const u = require('./uso.js').leer(root);
      if (u) {
        let n = 0; let l = 0; let e = 0;
        for (const v of Object.values(u.intenciones)) { n += v.n || 0; l += v.lineas || 0; e += v.evitadas || 0; }
        if (n) out(`uso: ${n} consultas · ${l} líneas devueltas · ≈${e} líneas evitadas`);
      }
    } catch { /* la medicion es opcional */ }
    return 0;
  }
  out('Uso: harness.js grafo construir [--fondo] | estado | contexto <texto|ref> | esqueleto <fichero> | impacto [--base ref] | tests [--base ref] | porque <fichero> | superficie | legado  [--presupuesto N]');
  return sub ? 2 : 0;
}

module.exports = { cli, recortar, asegurarGitignore, LINEA_IGNORE };
