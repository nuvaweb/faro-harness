// lib/grafo/consultas.js — consultas por intencion sobre el indice del grafo FARO (#301, T7).
//
// Solo LEEN: no reconstruyen ni guardan el indice. Cada funcion devuelve { lineas, ficheros } sin
// recortar (el presupuesto lo aplica cli.js). Forma de una linea de resultado: `<rel> — <motivo>`.
// Nunca se lee fuera de root: las rutas se normalizan y se rechazan `..` y absolutas.
'use strict';

const fs = require('fs');
const path = require('path');
const { aristas, dirSinEnlaces } = require('./indice.js');

const TOPE_LECTURA = 1.5 * 1024 * 1024;
const MAX_TOKENS = 12;
const FACTOR = { codigo: 1, migracion: 0.8, test: 0.5 };
const STOP = new Set(('el la los las un una unos unas de del al en y o u a con por para que se su sus es son ser fue como mas pero sin sobre entre ' +
  'este esta estos estas ese esa eso lo le les mi tu me te nos hay ya muy tambien cuando donde ' +
  'the and for with from that this these those are was were been have has had not but you your our their its into out all any can will ' +
  'una uno cual quien cuyo todo toda todos todas otro otra ver hacer').split(/\s+/));
const RE_REF = /^(?:#\d+|REQ-\d+|R-\d+|cambio:[\w-]+)$/i;
const IA_PAQUETES = ['@anthropic-ai/sdk', 'openai', '@google/generative-ai', '@google/genai', 'ai', 'langchain', 'cohere-ai', 'anthropic'];
const IA_PREFIJOS = ['@langchain/', '@mistralai/'];
const RE_IA_URL = /api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com/;
const NOMBRES_ENTRADA = new Set(['main', 'index', 'cli', 'server', 'app', '__main__', 'manage']);

const unico = (a) => [...new Set(a)];
const limpiaLinea = (s) => String(s).replace(/[\r\n\t\0]+/g, ' ').trim();
const partirCamel = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
const porRel = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Minusculas, camelCase/snake/kebab/rutas partidos, >= 3 caracteres, sin stopwords, unicos, max 12. */
function tokens(texto) {
  const out = [];
  for (const crudo of String(texto || '').split(/[^\p{L}\p{N}]+/u)) {
    if (!crudo) continue;
    const trozos = partirCamel(crudo).split(' ');
    const cand = trozos.length > 1 ? [...trozos, crudo] : trozos;
    for (const t of cand) {
      const m = t.toLowerCase();
      if (m.length >= 3 && !STOP.has(m)) out.push(m);
    }
  }
  return unico(out).slice(0, MAX_TOKENS);
}

const nodos = (idx) => (idx && idx.ficheros) || {};
const tiene = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** [{ rel, puntos, motivo }] por puntos y luego rel. Pesos: ruta x3, exportacion x2, tabla x2. */
function buscar(idx, texto, { max = 10 } = {}) {
  const toks = tokens(texto);
  if (!toks.length) return [];
  const out = [];
  for (const [rel, n] of Object.entries(nodos(idx))) {
    if (n.omitido) continue;
    const segs = partirCamel(rel.replace(/\.[^./]+$/, '')).toLowerCase().split(/[/._\-\s]+/).filter(Boolean);
    const exps = (n.exporta || []).map((e) => ({ nombre: e.nombre, l: partirCamel(e.nombre).toLowerCase().replace(/\s+/g, '') }));
    const tabs = [...((n.tablas && n.tablas.define) || []), ...((n.tablas && n.tablas.usa) || [])].map((t) => t.nombre);
    let puntos = 0;
    const motivos = [];
    for (const t of toks) {
      if (segs.some((s) => s.includes(t))) { puntos += 3; if (!motivos.includes('ruta')) motivos.push('ruta'); }
      const e = exps.find((x) => x.l.includes(t));
      if (e) { puntos += 2; motivos.push(`exporta ${e.nombre}`); }
      const tb = tabs.find((x) => x.toLowerCase().includes(t));
      if (tb) { puntos += 2; motivos.push(`tabla ${tb}`); }
    }
    puntos *= FACTOR[n.tipo] === undefined ? 1 : FACTOR[n.tipo];
    if (puntos > 0) out.push({ rel, puntos, motivo: unico(motivos).slice(0, 3).join(', ') });
  }
  out.sort((a, b) => b.puntos - a.puntos || porRel(a.rel, b.rel));
  return out.slice(0, max);
}

/** Ruta relativa POSIX segura dentro de root, o null (vacia, absoluta, con `..`, NUL). */
function relSegura(arg) {
  if (typeof arg !== 'string' || !arg || arg.includes('\0')) return null;
  const p = arg.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (!p || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  if (p.split('/').some((s) => s === '..' || s === '')) return null;
  return p;
}

/** Texto de un fichero del indice (nunca fuera de root, sin enlaces, con tope), o null. */
function leer(root, rel) {
  try {
    if (!relSegura(rel)) return null;
    const abs = path.join(root, rel);
    if (!dirSinEnlaces(root, path.dirname(abs))) return null;
    const st = fs.lstatSync(abs);
    if (!st.isFile() || st.size > TOPE_LECTURA) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch { return null; }
}

const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function contexto(root, idx, arg) {
  const crudo = typeof arg === 'string' ? arg : '';
  const cabecera = (n) => `grafo contexto «${limpiaLinea(crudo).slice(0, 60)}»: ${n} ficheros`;
  const f = nodos(idx);
  const semillas = []; // { rel, motivo }
  const ref = crudo.trim();
  const rel = relSegura(ref);
  if (rel && tiene(f, rel)) {
    semillas.push({ rel, motivo: 'fichero pedido' });
  } else if (RE_REF.test(ref)) {
    const re = new RegExp(`(?<![\\w#-])${escapar(ref)}(?![\\w-])`, 'i');
    for (const [r, n] of Object.entries(f)) {
      if (n.omitido || n.tipo === 'migracion') continue;
      const txt = leer(root, r);
      if (txt && re.test(txt)) semillas.push({ rel: r, motivo: `cita ${ref}` });
    }
    semillas.sort((a, b) => porRel(a.rel, b.rel));
  } else {
    for (const b of buscar(idx, crudo)) semillas.push({ rel: b.rel, motivo: b.motivo });
  }
  if (!semillas.length) return { lineas: [cabecera(0)], ficheros: [] };

  const { aristas: a, inversas: inv } = aristas(idx);
  const vistos = new Set(semillas.map((s) => s.rel));
  const vecinos = [];
  for (const s of semillas) {
    for (const d of [...(a.get(s.rel) || [])].sort()) if (!vistos.has(d)) { vistos.add(d); vecinos.push({ rel: d, motivo: `lo importa ${s.rel}` }); }
    for (const d of [...(inv.get(s.rel) || [])].sort()) if (!vistos.has(d)) { vistos.add(d); vecinos.push({ rel: d, motivo: `importa ${s.rel}` }); }
  }
  const todos = [...semillas, ...vecinos];
  return { lineas: [cabecera(todos.length), ...todos.map((x) => `${x.rel} — ${x.motivo}`)], ficheros: todos.map((x) => x.rel) };
}

const DECL = {
  js: [/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class)\s+[\w$]+/, /^(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\s*)?(?:\(|function\b)/, /^export\s+(?:default|const|let|var|interface|type|enum)\b/],
  py: [/^(?:async\s+)?def\s+\w+/, /^class\s+\w+/],
  go: [/^func\s/, /^type\s+\w+/],
  rb: [/^\s{0,2}(?:def|class|module)\s+\S+/],
};
const EXT_LENG = { '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.ts': 'js', '.tsx': 'js', '.jsx': 'js', '.mts': 'js', '.cts': 'js', '.py': 'py', '.go': 'go', '.rb': 'rb' };

function esqueleto(root, idx, rel) {
  if (typeof rel !== 'string' || !rel.trim()) return { lineas: ['grafo: indica un fichero'], ficheros: [] };
  const r = relSegura(typeof rel === 'string' ? rel.trim() : '');
  const noExiste = { lineas: [`grafo: ${limpiaLinea(rel)} no existe`], ficheros: [] };
  const n = r && tiene(nodos(idx), r) ? nodos(idx)[r] : null;
  if (!n) return noExiste;
  const txt = n.omitido ? null : leer(root, r);
  if (txt === null && !n.omitido) return noExiste;
  const lineas = [r];
  if (txt !== null) {
    const res = DECL[EXT_LENG[path.extname(r).toLowerCase()]] || [];
    txt.replace(/\r\n?/g, '\n').split('\n').forEach((t, i) => {
      if (res.some((re) => re.test(t))) lineas.push(`  ${i + 1}: ${limpiaLinea(t).slice(0, 100)}`);
    });
  } else lineas.push(`  (omitido: ${n.omitido})`);
  const { aristas: a, inversas: inv } = aristas(idx);
  const imp = [...(a.get(r) || [])].sort();
  const lo = [...(inv.get(r) || [])].sort();
  if (imp.length) lineas.push(`importa: ${imp.join(', ')}`);
  if (lo.length) lineas.push(`lo importan: ${lo.join(', ')}`);
  return { lineas, ficheros: [r, ...imp, ...lo] };
}

const esIA = (spec) => IA_PAQUETES.some((p) => spec === p || spec.startsWith(p + '/') || spec.startsWith(p + '.')) || IA_PREFIJOS.some((p) => spec.startsWith(p));

function entradasPackage(root, f) {
  const out = new Map();
  try {
    const p = path.join(root, 'package.json');
    if (!fs.lstatSync(p).isFile()) return out;
    const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
    const cand = [];
    for (const k of ['main', 'module']) if (typeof pkg[k] === 'string') cand.push([pkg[k], `package.json ${k}`]);
    if (typeof pkg.bin === 'string') cand.push([pkg.bin, 'package.json bin']);
    else if (pkg.bin && typeof pkg.bin === 'object') for (const v of Object.values(pkg.bin)) if (typeof v === 'string') cand.push([v, 'package.json bin']);
    for (const [v, m] of cand) {
      const r = relSegura(String(v).replace(/\\/g, '/').replace(/^(\.\/)+/, ''));
      if (r && tiene(f, r) && !out.has(r)) out.set(r, m);
    }
  } catch { /* sin package.json legible */ }
  return out;
}

function entradasDe(root, f) {
  const e = entradasPackage(root, f);
  for (const rel of Object.keys(f)) {
    const partes = rel.split('/');
    if (partes.length > 3 || e.has(rel) || f[rel].tipo !== 'codigo') continue;
    if (NOMBRES_ENTRADA.has(partes[partes.length - 1].replace(/\.[^.]+$/, '').toLowerCase())) e.set(rel, 'entrada por nombre');
  }
  return e;
}

function superficie(root, idx) {
  const f = nodos(idx);
  const codigo = Object.entries(f).filter(([, n]) => n.tipo === 'codigo' && !n.omitido).sort((a, b) => porRel(a[0], b[0]));
  const entradas = entradasDe(root, f);
  const entorno = [];
  const ia = [];
  for (const [rel, n] of codigo) {
    const usos = unico((n.es || []).map((x) => x.uso));
    if (usos.length) entorno.push([rel, `usa ${usos.join(', ')}`]);
    const specs = unico((n.imports || []).map((i) => i.spec).filter((s) => typeof s === 'string' && esIA(s)));
    if (specs.length) ia.push([rel, `importa ${specs.join(', ')}`]);
    else {
      const txt = leer(root, rel);
      if (txt && RE_IA_URL.test(txt)) ia.push([rel, 'llama a una API de IA']);
    }
  }
  const bloque = (titulo, filas) => [`${titulo}:`, ...(filas.length ? filas.map(([r, m]) => `  ${r} — ${m}`) : ['  (ninguno)'])];
  const lineas = [...bloque('entradas', [...entradas]), ...bloque('entorno', entorno), ...bloque('ia', ia)];
  return { lineas, ficheros: unico([...entradas.keys(), ...entorno.map((x) => x[0]), ...ia.map((x) => x[0])]) };
}

function legado(root, idx) {
  const f = nodos(idx);
  const { inversas } = aristas(idx);
  const entradas = entradasDe(root, f);
  const orden = Object.entries(f).sort((a, b) => porRel(a[0], b[0]));
  const lineas = [];
  const ficheros = [];
  for (const [rel, n] of orden) {
    for (const i of n.imports || []) {
      if (i.clase !== 'no-resuelto') continue;
      lineas.push(`${rel} — import sin resolver ${limpiaLinea(i.spec)} (línea ${i.linea})`);
      ficheros.push(rel);
    }
  }
  for (const [rel, n] of orden) {
    if (n.tipo !== 'codigo' || n.omitido || entradas.has(rel) || inversas.has(rel)) continue;
    lineas.push(`${rel} — huérfano: nadie lo importa y no es entrada`);
    ficheros.push(rel);
  }
  if (!lineas.length) lineas.push('grafo legado: nada que señalar');
  return { lineas, ficheros: unico(ficheros) };
}

module.exports = { tokens, buscar, contexto, esqueleto, superficie, legado };
