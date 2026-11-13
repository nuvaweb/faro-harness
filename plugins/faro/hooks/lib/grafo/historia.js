// lib/grafo/historia.js — consultas con historia de git sobre el indice del grafo FARO (#301, T8).
//
// Solo LEEN. git se invoca sin shell, con argumentos fijos; el rel del usuario va tras `--`.
// Cada consulta devuelve { lineas, ficheros } sin recortar (el presupuesto lo aplica cli.js).
'use strict';

const { spawnSync } = require('child_process');
const { aristas, dirSinEnlaces } = require('./indice.js');
const fs = require('fs');
const path = require('path');

const MAX_SALTOS = 3;
const MAX_CITAS = 5;
const MAX_DOCS = 2000;
const TOPE_DOC = 1.5 * 1024 * 1024;
const limpia = (s) => String(s).replace(/[\r\n\t\0]+/g, ' ').trim();
const porRel = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function git(root, args) {
  try {
    const r = spawnSync('git', ['-c', 'core.quotepath=false', '--literal-pathspecs', ...args], { cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return r.status === 0 ? String(r.stdout) : null;
  } catch { return null; }
}
const lineasDe = (s) => (s ? s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []);
const rev = (root, r) => { const o = git(root, ['rev-parse', '--verify', '--quiet', `${r}^{commit}`]); return o ? o.trim() : null; };
const seguro = (r) => typeof r === 'string' && r && !r.startsWith('-') && !/[\s\0]/.test(r) && !r.split('/').includes('');

/** { rels, base }: cambios de la rama frente a su base, mas el arbol de trabajo y los no rastreados. */
function cambiados(root, base) {
  const set = new Set();
  let usada = null;
  let ausente = false;
  const invalida = base !== undefined && base !== null && !seguro(base);
  if (rev(root, 'HEAD')) {
    const candidatas = invalida ? [] : seguro(base) ? [base] : ['develop', 'main', 'master'];
    const cabeza = rev(root, 'HEAD');
    for (const c of candidatas) {
      if (!rev(root, c)) continue;
      const mb = git(root, ['merge-base', c, 'HEAD']);
      const desde = seguro(base) ? c : (mb ? mb.trim() : null);
      if (!desde) continue;
      const out = git(root, ['diff', '--name-only', `${desde}...HEAD`]);
      if (out === null) continue;
      lineasDe(out).forEach((l) => set.add(l));
      usada = !seguro(base) && desde === cabeza ? null : c; // sin rango (estas en la base): no hay base que citar
      break;
    }
    if (seguro(base) && !usada && !rev(root, base)) ausente = true;
    lineasDe(git(root, ['diff', '--name-only', 'HEAD'])).forEach((l) => set.add(l));
  } else {
    lineasDe(git(root, ['diff', '--name-only'])).forEach((l) => set.add(l));
    lineasDe(git(root, ['diff', '--name-only', '--cached'])).forEach((l) => set.add(l));
  }
  lineasDe(git(root, ['ls-files', '--others', '--exclude-standard'])).forEach((l) => set.add(l));
  return { rels: [...set].sort(porRel), base: usada, invalida, ausente, pedida: base };
}

const cab = (c) => (c.invalida ? 'base no válida (se ignora): solo árbol de trabajo' : c.ausente ? `base ${limpia(c.pedida)} no encontrada: solo árbol de trabajo` : c.base ? `base ${c.base}` : 'solo árbol de trabajo');
const esTest = (idx, rel) => !!(idx && idx.ficheros && idx.ficheros[rel] && idx.ficheros[rel].tipo === 'test');

/** Alcance: cambiados en el indice + BFS por inversas hasta 3 saltos. */
function alcance(idx, rels) {
  const { inversas: inv } = aristas(idx);
  const f = (idx && idx.ficheros) || {};
  const cam = rels.filter((r) => Object.prototype.hasOwnProperty.call(f, r));
  const salto = new Map(cam.map((r) => [r, 0]));
  let frontera = cam;
  for (let s = 1; s <= MAX_SALTOS; s++) {
    const sig = [];
    for (const r of frontera) for (const d of [...(inv.get(r) || [])].sort()) if (!salto.has(d)) { salto.set(d, s); sig.push(d); }
    frontera = sig;
  }
  const de = (pred) => [...salto].filter(([, s]) => pred(s)).map(([r]) => r).sort(porRel);
  return { cam, directos: de((s) => s === 1), transitivos: de((s) => s > 1), todos: [...salto.keys()] };
}

function impacto(root, idx, { base } = {}) {
  const c = cambiados(root, base);
  const a = alcance(idx, c.rels);
  const tests = a.todos.filter((r) => esTest(idx, r)).sort(porRel);
  const lineas = [`grafo impacto: ${a.cam.length} cambiados · ${cab(c)}`];
  const bloque = (t, xs, motivo) => { if (xs.length) lineas.push(`${t}:`, ...xs.map((r) => `${r} — ${motivo}`)); };
  bloque('cambiados', a.cam, 'cambiado');
  bloque('directos', a.directos, 'importa un cambiado');
  bloque('transitivos', a.transitivos, 'alcanzado por imports');
  bloque('tests', tests, 'test alcanzado');
  return { lineas, ficheros: [...new Set([...a.cam, ...a.directos, ...a.transitivos])] };
}

function tests(root, idx, { base } = {}) {
  const c = cambiados(root, base);
  const a = alcance(idx, c.rels);
  const alcanzados = a.todos.filter((r) => esTest(idx, r));
  const cam = new Set(a.cam);
  const cuenta = new Map(alcanzados.map((r) => [r, 0]));
  const log = git(root, ['log', '-n', '200', '--name-only', '--format=%H']);
  if (log && alcanzados.length) {
    let actual = null;
    const flush = () => {
      if (!actual) return;
      if ([...actual].some((r) => cam.has(r))) for (const t of alcanzados) if (actual.has(t) && [...actual].some((r) => r !== t && cam.has(r))) cuenta.set(t, cuenta.get(t) + 1);
    };
    for (const l of log.split(/\r?\n/)) {
      if (/^[0-9a-f]{40,64}$/.test(l)) { flush(); actual = new Set(); } else if (l && actual) actual.add(l.trim());
    }
    flush();
  }
  const orden = alcanzados.sort((x, y) => cuenta.get(y) - cuenta.get(x) || porRel(x, y));
  return {
    lineas: [`grafo tests: ${orden.length} alcanzados · ${cab(c)}`, ...orden.map((r) => `${r} — cambió junto a lo cambiado en ${cuenta.get(r)} commit${cuenta.get(r) === 1 ? '' : 's'}`)],
    ficheros: orden,
  };
}

/** true si txt contiene rel con limite de ruta a ambos lados (ni letra, digito, _ . / - pegados). */
function cita(txt, rel) {
  const sep = /[A-Za-z0-9_./-]/;
  for (let i = txt.indexOf(rel); i !== -1; i = txt.indexOf(rel, i + 1)) {
    const antes = i > 0 ? txt[i - 1] : '';
    const despues = txt[i + rel.length] || '';
    if (!(antes && sep.test(antes)) && !(despues && sep.test(despues))) return true;
  }
  return false;
}

/** Documentos .md de gestion que contienen el rel literal (lstat, sin enlaces, tope de ficheros y tamano). */
function docsQueCitan(root, rel) {
  const out = [];
  let vistos = 0;
  const leerDoc = (abs, r) => {
    if (out.length >= MAX_CITAS || vistos >= MAX_DOCS) return;
    vistos++;
    try {
      if (!dirSinEnlaces(root, path.dirname(abs))) return;
      const st = fs.lstatSync(abs);
      if (!st.isFile() || st.size > TOPE_DOC) return;
      if (cita(fs.readFileSync(abs, 'utf8'), rel)) out.push(r);
    } catch { /* ilegible: se ignora */ }
  };
  const recorrer = (abs, r) => {
    if (out.length >= MAX_CITAS || vistos >= MAX_DOCS) return;
    let ents;
    try { if (!dirSinEnlaces(root, abs) || !fs.lstatSync(abs).isDirectory()) return; ents = fs.readdirSync(abs); } catch { return; }
    for (const e of ents.sort()) {
      const a = path.join(abs, e);
      let st;
      try { st = fs.lstatSync(a); } catch { continue; }
      if (st.isDirectory()) recorrer(a, `${r}/${e}`);
      else if (st.isFile() && /\.md$/i.test(e)) leerDoc(a, `${r}/${e}`);
    }
  };
  leerDoc(path.join(root, 'faro', 'ESTADO.md'), 'faro/ESTADO.md');
  recorrer(path.join(root, 'faro', 'gestion'), 'faro/gestion');
  recorrer(path.join(root, 'gestion'), 'gestion');
  return out;
}

function porque(root, idx, rel) {
  const r = typeof rel === 'string' ? rel.trim().split(String.fromCharCode(92)).join('/') : '';
  const ok = r && !r.startsWith('-') && !r.startsWith('/') && !/^[a-zA-Z]:/.test(r) && !r.includes('\0') && !r.split('/').includes('..');
  const enIdx = ok && idx && idx.ficheros && Object.prototype.hasOwnProperty.call(idx.ficheros, r);
  let enDisco = false;
  if (ok && !enIdx) { try { enDisco = dirSinEnlaces(root, path.dirname(path.join(root, r))) && fs.lstatSync(path.join(root, r)).isFile(); } catch { /* no existe */ } }
  let esDir = false;
  if (ok && !enIdx) { try { esDir = fs.lstatSync(path.join(root, r)).isDirectory(); } catch { /* no existe */ } }
  // borrado: ni en indice ni en disco, pero con historia en git (los pathspecs son literales)
  const log = ok && !esDir ? lineasDe(git(root, ['log', '-n', '8', '--format=%h%x09%as%x09%s', '--', r])) : [];
  if (!ok || esDir || (!enIdx && !enDisco && !log.length)) return { lineas: [`grafo: ${limpia(rel)} no existe`], ficheros: [] };
  const lineas = [r];
  for (const l of log) {
    const [h, f, ...s] = l.split('\t');
    const asunto = limpia(s.join(' '));
    lineas.push(`  ${h} ${f} ${asunto}`);
  }
  if (!log.length) lineas.push('  (sin historia en git)');
  const rutas = docsQueCitan(root, r);
  if (rutas.length) lineas.push('citado en:', ...rutas.map((x) => `  ${x}`));
  return { lineas, ficheros: [r] };
}

module.exports = { cambiados, impacto, tests, porque };
