// lib/grafo/indice.js — indice incremental persistido del grafo FARO (#298, T3).
//
// El indice guarda, por fichero de codigo, lo que extrae `extraer` y lo que resuelve `crearResolver`.
// Solo se relee y reextrae lo que cambio (mtimeMs/tam distintos y, ademas, hash distinto); la
// resolucion de imports se rehace entera si cambia la lista de ficheros o un tsconfig*/package.json/
// pnpm-workspace.yaml. `construir` no escribe a disco; `guardar` si, de forma atomica.
// Los enlaces simbolicos nunca se recorren, ni se leen, ni se escribe a traves de ellos (mismo criterio que #295).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { extraer, lenguajeDe } = require('./extraer.js');
const { crearResolver } = require('./resolver.js');
const { depurar, excluidoPorRuta } = require('../generados.js');
const { detectarLayout } = require('../paths.js');

const VERSION = 1;
const TOPE_FICHERO = 1.5 * 1024 * 1024;
const TOPE_INDICE = 20 * 1024 * 1024;
const RE_TEST = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$/;
const RE_CONFIG = /(^|\/)(tsconfig[^/]*\.json|package\.json|pnpm-workspace\.yaml)$/;

const sha1 = (x) => crypto.createHash('sha1').update(x).digest('hex');
const posix = (p) => p.split(path.sep).join('/');

/** Ruta absoluta del indice: faro/.cache/grafo.json (layout faro) o .git/faro-grafo.json (legado). */
function rutaIndice(root) {
  if (detectarLayout(root) !== 'legado') return path.join(root, 'faro', '.cache', 'grafo.json');
  return path.join(gitDir(root), 'faro-grafo.json');
}

// .git es un directorio, o (worktree/submodulo) un fichero 'gitdir: <ruta>', absoluta o relativa a root.
function gitDir(root) {
  const g = path.join(root, '.git');
  try {
    if (fs.lstatSync(g).isFile()) {
      const m = fs.readFileSync(g, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
      if (m) return path.resolve(root, m[1]);
    }
  } catch { /* sin .git: se usa la ruta por defecto */ }
  return g;
}

/** Indice guardado, o null si falta, esta truncado, es ilegible, es un enlace o es de otra version. */
function cargar(root) {
  try {
    const p = rutaIndice(root);
    if (!fs.lstatSync(p).isFile()) return null;
    const ind = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!ind || ind.version !== VERSION || !ind.ficheros || typeof ind.ficheros !== 'object' || Array.isArray(ind.ficheros)) return null;
    return ind;
  } catch { return null; }
}

/** Guarda de forma atomica (.tmp + rename). false si supera 20 MB o no se puede escribir sin seguir enlaces. */
function guardar(root, indice) {
  try {
    const txt = JSON.stringify(indice);
    if (Buffer.byteLength(txt) > TOPE_INDICE) return false;
    const p = rutaIndice(root);
    const dir = path.dirname(p);
    // Sin seguir enlaces: ni el destino ni los directorios que creamos pueden serlo.
    for (let d = dir; d.length > root.length && d.startsWith(root); d = path.dirname(d)) {
      try { if (fs.lstatSync(d).isSymbolicLink()) return false; } catch { /* aun no existe */ }
    }
    fs.mkdirSync(dir, { recursive: true });
    if (fs.lstatSync(dir).isSymbolicLink()) return false;
    try { if (fs.lstatSync(p).isSymbolicLink()) return false; } catch { /* no existe: bien */ }
    const tmp = `${p}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    try {
      fs.writeFileSync(tmp, txt, { flag: 'wx' });
      fs.renameSync(tmp, p);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nada */ }
      throw e;
    }
    return true;
  } catch { return false; }
}

/** true si `dir` y sus padres dentro de root no son enlaces (los que no existen aun, bien). */
function dirSinEnlaces(root, dir) {
  for (let d = dir; d.length > root.length && d.startsWith(root); d = path.dirname(d)) {
    try { if (fs.lstatSync(d).isSymbolicLink()) return false; } catch { /* aun no existe */ }
  }
  return true;
}

function recorrer(root, dir, out) {
  let ents;
  try { ents = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isSymbolicLink() || excluidoPorRuta(rel)) continue;
    if (e.isDirectory()) recorrer(root, rel, out);
    else if (e.isFile()) out.push(rel);
  }
}

/** Ficheros del repo (POSIX, relativos): git ls-files -co (fallback: recorrido), depurados y sin enlaces. */
function ficheros(root) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  let rels;
  if (r.status === 0) rels = r.stdout.split('\n').map((s) => s.replace(/\r$/, '').trim()).filter(Boolean);
  else { rels = []; recorrer(root, '', rels); }
  rels = [...new Set(rels)].filter((rel) => !excluidoPorRuta(rel));
  rels = depurar(root, rels, fs, path);
  return rels.filter((rel) => {
    try { return fs.lstatSync(path.join(root, rel)).isFile(); } catch { return false; }
  }).sort();
}

const tipoDe = (rel, lenguaje) => (RE_TEST.test(rel) ? 'test' : lenguaje === 'sql' ? 'migracion' : 'codigo');

/**
 * Construye el indice. Con `previo` solo reextrae lo que cambio. No escribe a disco.
 * opts: { previo, lista, _extraer } (`_extraer` es un gancho para tests).
 */
function construir(root, opts = {}) {
  const previo = opts.previo && opts.previo.version === VERSION && opts.previo.ficheros ? opts.previo : null;
  const ext = opts._extraer || extraer;
  const lista = (opts.lista ? [...new Set(opts.lista.map(posix))].sort() : ficheros(root));
  const prev = previo ? previo.ficheros : {};

  const stats = new Map();
  const cfg = [];
  for (const rel of lista) {
    let st;
    try { st = fs.lstatSync(path.join(root, rel)); } catch { continue; }
    if (!st.isFile()) continue; // enlaces y directorios: no son nodos
    stats.set(rel, st);
    if (RE_CONFIG.test(rel)) cfg.push(`${rel}:${st.mtimeMs}:${st.size}`);
  }
  const vivos = [...stats.keys()];
  const meta = { lista: sha1(vivos.join('\n')), config: sha1(cfg.join('\n')) };
  const global = !previo || !previo.meta || previo.meta.lista !== meta.lista || previo.meta.config !== meta.config;

  const ficherosOut = {};
  const rehacer = []; // reextraidos (o todos, si global)
  for (const rel of vivos) {
    const lenguaje = lenguajeDe(rel);
    if (!lenguaje) continue; // no es codigo que FARO entienda: no es nodo
    const st = stats.get(rel);
    const base = { mtimeMs: st.mtimeMs, tam: st.size };
    const p = prev[rel];
    if (p && p.mtimeMs === st.mtimeMs && p.tam === st.size) { ficherosOut[rel] = { ...p, tipo: tipoDe(rel, lenguaje) }; continue; }
    if (st.size > TOPE_FICHERO) {
      ficherosOut[rel] = { hash: null, ...base, tipo: tipoDe(rel, lenguaje), lenguaje, imports: [], exporta: [], es: [], tablas: { define: [], usa: [] }, omitido: 'tamaño' };
      continue;
    }
    let buf;
    try { buf = fs.readFileSync(path.join(root, rel)); } catch { continue; }
    if (buf.includes(0)) {
      ficherosOut[rel] = { hash: sha1(buf), ...base, tipo: tipoDe(rel, lenguaje), lenguaje, imports: [], exporta: [], es: [], tablas: { define: [], usa: [] }, omitido: 'tamaño' };
      continue;
    }
    const hash = sha1(buf);
    if (p && p.hash === hash && !p.omitido) { ficherosOut[rel] = { ...p, ...base, tipo: tipoDe(rel, lenguaje) }; continue; }
    const x = ext(rel, buf.toString('utf8'));
    ficherosOut[rel] = {
      hash, ...base, tipo: tipoDe(rel, lenguaje), lenguaje: x.lenguaje || lenguaje,
      imports: (x.imports || []).map((i) => ({ spec: i.spec, linea: i.linea, destino: null, clase: 'no-resuelto' })),
      exporta: x.exporta || [], es: x.es || [], tablas: x.tablas || { define: [], usa: [] },
    };
    rehacer.push(rel);
  }

  const aResolver = global ? Object.keys(ficherosOut) : rehacer;
  if (aResolver.length) {
    // El resolver ve la lista COMPLETA (tsconfig, package.json, workspaces...), no solo el codigo.
    const resolver = crearResolver(root, vivos, {});
    for (const rel of aResolver) {
      const n = ficherosOut[rel];
      if (n.omitido) continue;
      n.imports = n.imports.map((i) => {
        const r = resolver(rel, i.spec, n.lenguaje);
        return { spec: i.spec, linea: i.linea, destino: r.destino, clase: r.clase };
      });
    }
  }
  return { version: VERSION, generado: new Date().toISOString(), meta, ficheros: ficherosOut };
}

/** { aristas, inversas }: Map<rel, Set<rel>> entre ficheros del indice (misma forma que dominios.grafo). */
function aristas(indice) {
  const a = new Map();
  const inv = new Map();
  const f = (indice && indice.ficheros) || {};
  for (const [rel, n] of Object.entries(f)) {
    for (const i of n.imports || []) {
      if (i.clase !== 'interno' || !i.destino || i.destino === rel || !(i.destino in f)) continue;
      if (!a.has(rel)) a.set(rel, new Set());
      a.get(rel).add(i.destino);
      if (!inv.has(i.destino)) inv.set(i.destino, new Set());
      inv.get(i.destino).add(rel);
    }
  }
  return { aristas: a, inversas: inv };
}

/** true si ningun fichero de codigo de la lista tiene mtimeMs o tamano distintos de los guardados. */
function fresco(root, indice) {
  if (!indice || !indice.ficheros) return false;
  const vistos = new Set();
  for (const rel of ficheros(root)) {
    if (!lenguajeDe(rel)) continue;
    const n = indice.ficheros[rel];
    if (!n) return false;
    let st;
    try { st = fs.lstatSync(path.join(root, rel)); } catch { return false; }
    if (st.mtimeMs !== n.mtimeMs || st.size !== n.tam) return false;
    vistos.add(rel);
  }
  return Object.keys(indice.ficheros).every((rel) => vistos.has(rel));
}

module.exports = { rutaIndice, cargar, guardar, construir, aristas, fresco, ficheros, dirSinEnlaces, VERSION };
