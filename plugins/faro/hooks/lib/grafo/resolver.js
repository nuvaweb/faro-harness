'use strict';
// Resolucion de specs de import del grafo FARO (#298, T2).
// crearResolver(root, lista, {leer}) -> (desde, spec, lenguaje) -> {destino, clase}.
// Puro salvo la lectura de tsconfig, package.json y pnpm-workspace.yaml (opts.leer, inyectable).
// Alias, workspaces y lista se precalculan una vez por resolver.

const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const P = path.posix;
const EXTS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.jsx', '.json'];
const STDLIB_PY = new Set(['os', 'sys', 'json', 're', 'pathlib', 'typing', 'datetime', 'collections', 'logging', 'subprocess']);
const SISTEMA = new Set(builtinModules);

// Salta una cadena JSON que empieza en i (comilla) y devuelve el indice de la comilla de cierre.
function finCadena(txt, i) {
  let j = i + 1;
  while (j < txt.length && txt[j] !== '"') j += txt[j] === '\\' ? 2 : 1;
  return j;
}

/** Quita comentarios (linea y bloque) y comas finales de un JSON sin tocar las cadenas. */
function limpiarJson(txt) {
  let out = '';
  let i = 0;
  const n = txt.length;
  while (i < n) {
    const c = txt[i];
    if (c === '"') {
      const j = finCadena(txt, i);
      out += txt.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && txt[i + 1] === '/') {
      while (i < n && txt[i] !== '\n') i++;
    } else if (c === '/' && txt[i + 1] === '*') {
      const f = txt.indexOf('*/', i + 2);
      i = f < 0 ? n : f + 2;
    } else {
      out += c;
      i++;
    }
  }
  let res = '';
  for (let k = 0; k < out.length; k++) {
    const c = out[k];
    if (c === '"') {
      const j = finCadena(out, k);
      res += out.slice(k, j + 1);
      k = j;
    } else if (c === ',' && /^\s*[}\]]/.test(out.slice(k + 1))) {
      // coma final: se omite
    } else res += c;
  }
  return res;
}

function crearResolver(root, lista, { leer = fs.readFileSync } = {}) {
  const set = new Set(lista);

  const leerRel = (rel) => {
    try { const t = leer(path.join(root, rel), 'utf8'); return t == null ? null : String(t); } catch { return null; }
  };
  const json = (rel) => {
    const t = leerRel(rel);
    if (t == null) return null;
    try { return JSON.parse(limpiarJson(t.replace(/^﻿/, ''))); } catch { return null; }
  };

  // Candidatos de un destino sin extension; preferTs hace ganar a x.ts sobre x.js (import ESM de TS).
  const candidatos = (base, preferTs) => {
    const sinBarra = base.replace(/\/+$/, '');
    const b = sinBarra === '.' ? '' : sinBarra;
    const idx = EXTS.map((e) => (b ? `${b}/index${e}` : `index${e}`));
    const c = b ? [b, ...EXTS.map((e) => b + e), ...idx] : idx;
    const m = b.match(/^(.*)\.(m?js|cjs|jsx)$/);
    if (m) {
      const sin = m[1];
      const ts = m[2] === 'mjs' ? [sin + '.mts'] : m[2] === 'cjs' ? [sin + '.cts'] : [sin + '.ts', sin + '.tsx'];
      if (preferTs) c.unshift(...ts); else c.push(...ts);
    }
    return c;
  };
  const buscar = (base, desde) => candidatos(P.normalize(base), /\.(tsx?|mts|cts)$/.test(desde || '')).find((x) => set.has(x)) || null;

  // ---- tsconfig: alias por tsconfig.json, con extends encadenado ----
  const cacheTs = new Map();
  function opcionesTs(rel, vistos = new Set()) {
    if (cacheTs.has(rel)) return cacheTs.get(rel);
    if (vistos.has(rel)) return {};
    vistos.add(rel);
    const j = json(rel);
    let opts = {};
    if (j) {
      const dir = P.dirname(rel);
      const ext = typeof j.extends === 'string' ? j.extends : null;
      if (ext && ext.startsWith('.')) {
        let p = P.normalize(P.join(dir, ext));
        if (!set.has(p) && set.has(p + '.json')) p += '.json';
        if (set.has(p)) opts = { ...opcionesTs(p, vistos) };
      }
      const co = j.compilerOptions || {};
      if (typeof co.baseUrl === 'string') opts.baseUrl = P.normalize(P.join(dir, co.baseUrl));
      if (co.paths && typeof co.paths === 'object') {
        opts.paths = co.paths;
        opts.pathsDir = opts.baseUrl !== undefined ? opts.baseUrl : dir;
      }
    }
    cacheTs.set(rel, opts);
    return opts;
  }
  const tsconfigs = lista.filter((f) => P.basename(f) === 'tsconfig.json').sort((a, b) => b.length - a.length);
  const tsCfgPara = (desde) => {
    const dir = P.dirname(desde);
    return tsconfigs.find((t) => { const d = P.dirname(t); return d === '.' || dir === d || dir.startsWith(d + '/'); }) || null;
  };
  // undefined: el alias no aplica; null: aplica pero no resuelve; string: destino.
  function viaTsconfig(desde, spec) {
    const t = tsCfgPara(desde);
    if (!t) return undefined;
    const o = opcionesTs(t);
    let tocado = false;
    for (const [patron, destinos] of Object.entries(o.paths || {})) {
      const estrella = patron.indexOf('*');
      let resto = null;
      if (estrella < 0) {
        if (spec === patron) resto = '';
      } else {
        const pre = patron.slice(0, estrella);
        const post = patron.slice(estrella + 1);
        if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length) resto = spec.slice(pre.length, spec.length - post.length);
      }
      if (resto === null) continue;
      tocado = true;
      for (const d of [].concat(destinos)) {
        const hit = buscar(P.join(o.pathsDir || '.', String(d).replace('*', resto)));
        if (hit) return hit;
      }
    }
    if (o.baseUrl !== undefined) {
      const hit = buscar(P.join(o.baseUrl, spec));
      if (hit) return hit;
    }
    return tocado ? null : undefined;
  }

  // ---- workspaces: package.json (workspaces) y pnpm-workspace.yaml (packages) ----
  const patrones = [];
  const pj = json('package.json');
  if (pj && pj.workspaces) patrones.push(...(Array.isArray(pj.workspaces) ? pj.workspaces : pj.workspaces.packages || []));
  const yml = leerRel('pnpm-workspace.yaml');
  if (yml) {
    let dentro = false;
    for (const l of yml.split(/\r?\n/)) {
      if (/^packages\s*:/.test(l)) { dentro = true; continue; }
      if (!dentro) continue;
      const m = l.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/);
      if (m) patrones.push(m[1]);
      else if (/^\S/.test(l)) dentro = false;
    }
  }
  const reGlob = (g) => new RegExp('^' + g.replace(/^\.\//, '').replace(/\/+$/, '')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$');
  const reWs = patrones.filter((p) => !p.startsWith('!')).map(reGlob);
  const paquetes = new Map(); // nombre -> {dir, main}
  if (reWs.length) {
    for (const f of lista) {
      if (P.basename(f) !== 'package.json' || f === 'package.json') continue;
      const dir = P.dirname(f);
      if (!reWs.some((re) => re.test(dir))) continue;
      const j = json(f);
      if (j && typeof j.name === 'string') paquetes.set(j.name, { dir, main: j.main || j.module || j.types || null });
    }
  }
  const nombresWs = [...paquetes.keys()].sort((a, b) => b.length - a.length);
  function viaWorkspace(spec) {
    const nombre = nombresWs.find((n) => spec === n || spec.startsWith(n + '/'));
    if (!nombre) return undefined;
    const { dir, main } = paquetes.get(nombre);
    const sub = spec.slice(nombre.length + 1);
    if (!sub) return (main && buscar(P.join(dir, main))) || buscar(P.join(dir, 'src/index')) || buscar(P.join(dir, 'index')) || null;
    return buscar(P.join(dir, sub)) || buscar(P.join(dir, 'src', sub)) || null;
  }

  // ---- Python ----
  function resolverPy(desde, spec) {
    const m = spec.match(/^(\.*)(.*)$/);
    const puntos = m[1].length;
    const mod = m[2].replace(/\./g, '/');
    const cand = (base) => [base + '.py', P.join(base, '__init__.py')].map((x) => P.normalize(x)).find((x) => set.has(x));
    if (puntos) {
      let dir = P.dirname(desde);
      for (let i = 1; i < puntos; i++) dir = P.dirname(dir);
      const hit = cand(mod ? P.join(dir, mod) : dir);
      return hit ? { destino: hit, clase: 'interno' } : { destino: null, clase: 'no-resuelto' };
    }
    for (const r of ['', 'src']) {
      const hit = cand(r ? P.join(r, mod) : mod);
      if (hit && hit !== desde) return { destino: hit, clase: 'interno' };
    }
    const primero = spec.split('.')[0];
    return { destino: null, clase: STDLIB_PY.has(primero) ? 'sistema' : 'paquete' };
  }

  return function resolver(desde, spec, lenguaje) {
    if (typeof spec !== 'string' || !spec) return { destino: null, clase: 'no-resuelto' };
    if (lenguaje === 'py') return resolverPy(desde, spec);
    if (/^\.{1,2}([\\/]|$)/.test(spec)) {
      const hit = buscar(P.join(P.dirname(desde), spec.replace(/\\/g, '/')), desde);
      return hit ? { destino: hit, clase: 'interno' } : { destino: null, clase: 'no-resuelto' };
    }
    if (spec.startsWith('node:') || SISTEMA.has(spec)) return { destino: null, clase: 'sistema' };
    const a = viaTsconfig(desde, spec);
    if (a) return { destino: a, clase: 'interno' };
    const w = viaWorkspace(spec);
    if (w) return { destino: w, clase: 'interno' };
    if (a === null || w === null) return { destino: null, clase: 'no-resuelto' };
    return { destino: null, clase: 'paquete' };
  };
}

module.exports = { crearResolver, limpiarJson };
