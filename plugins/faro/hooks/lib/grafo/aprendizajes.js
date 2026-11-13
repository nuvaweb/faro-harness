// lib/grafo/aprendizajes.js — aprendizajes versionados del grafo FARO (#302, T11).
//
// Un aprendizaje es un fichero `<gestion>/aprendizajes/AP-NNN-<slug>.md` (layout faro:
// faro/gestion/aprendizajes/) con frontmatter simple:
//
//   ---
//   id: AP-001
//   titulo: "..."
//   tipo: decidido | descartado | cuidado
//   toca:
//     - src/a.js
//   fuente: manual
//   sustituye: AP-000-slug   (opcional; el nombre del fichero sin .md, o el id si es unico)
//   ---
//   cuerpo en llano
//
// Solo se AÑADEN: nunca se reescribe uno existente (escritura con 'wx'). Corregir = guardar otro con
// `sustituye:`; el sustituido deja de ser vigente. Dos ramas pueden dar el mismo numero (AP-003-foo y
// AP-003-bar): la vigencia se resuelve por FICHERO (clave = nombre sin .md) y `guardar` escribe siempre la
// clave. Leer es barato y no lanza: sin carpeta, [].
'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('../paths.js');
const { spawnSync } = require('child_process');
const { dirSinEnlaces } = require('./indice.js');

const TIPOS = ['decidido', 'descartado', 'cuidado'];
const RE_FICHERO = /^AP-(\d{3,})-[^/\\]*\.md$/;
const RE_ID = /^AP-\d{3,}$/;
const RE_CLAVE = /^AP-\d{3,}-[A-Za-z0-9._-]+$/;
const RAMAS_NUMERACION = ['develop', 'main', 'origin/develop', 'origin/main'];
const MAX_FICHEROS = 2000;
const TOPE_FICHERO = 64 * 1024;

const dirRel = (root) => `${paths(root).dir('gestion')}/aprendizajes`;
const dirAbs = (root) => path.join(root, dirRel(root));
const norm = (r) => String(r || '').trim().split('\\').join('/').replace(/^\.\//, '');

/** Escalar YAML de una linea: comillas dobles (JSON), simples ('' escapa) o plano. */
function escalar(v) {
  const t = String(v || '').trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) { try { return String(JSON.parse(t)); } catch { return t.slice(1, -1); } }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/** Frontmatter a mano: `clave: valor`, listas `- x` bajo la clave o `[a, b]` en linea. */
function parsear(txt) {
  const m = String(txt).replace(/\r\n?/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const datos = {};
  let lista = null;
  for (const linea of m[1].split('\n')) {
    const item = linea.match(/^\s+-\s+(.*)$/) || (lista && linea.match(/^-\s+(.*)$/));
    if (item && lista) { const v = escalar(item[1]); if (v) lista.push(v); continue; }
    const k = linea.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!k) { lista = null; continue; }
    const v = k[2].trim();
    if (!v) { lista = []; datos[k[1]] = lista; continue; }
    lista = null;
    if (v.startsWith('[') && v.endsWith(']')) datos[k[1]] = v.slice(1, -1).split(',').map(escalar).filter(Boolean);
    else datos[k[1]] = escalar(v);
  }
  return { datos, cuerpo: m[2] };
}

/** Todos los aprendizajes legibles, ordenados por numero, con `vigente` resuelto. */
function leer(root) {
  const dir = dirAbs(root);
  let ents;
  try {
    if (!dirSinEnlaces(root, dir) || !fs.lstatSync(dir).isDirectory()) return [];
    ents = fs.readdirSync(dir).filter((f) => RE_FICHERO.test(f)).sort().slice(0, MAX_FICHEROS);
  } catch { return []; }
  const out = [];
  for (const f of ents) {
    try {
      const abs = path.join(dir, f);
      const st = fs.lstatSync(abs);
      if (!st.isFile() || st.size > TOPE_FICHERO) continue;
      const p = parsear(fs.readFileSync(abs, 'utf8'));
      if (!p) continue;
      const num = Number(f.match(RE_FICHERO)[1]);
      const id = RE_ID.test(p.datos.id || '') ? p.datos.id : `AP-${String(num).padStart(3, '0')}`;
      const tipo = String(p.datos.tipo || '').toLowerCase();
      if (!TIPOS.includes(tipo)) continue;
      const toca = (Array.isArray(p.datos.toca) ? p.datos.toca : p.datos.toca ? [p.datos.toca] : []).map(norm).filter(Boolean);
      const s0 = String(p.datos.sustituye || '');
      const sus = RE_ID.test(s0) || RE_CLAVE.test(s0) ? s0 : null;
      out.push({ id, clave: f.slice(0, -3), num, titulo: String(p.datos.titulo || '').replace(/[\r\n\t]+/g, ' ').trim(), tipo, toca, fuente: String(p.datos.fuente || ''), sustituye: sus, vigente: true, rel: `${dirRel(root)}/${f}`, cuerpo: p.cuerpo.trim() });
    } catch { /* ilegible: se ignora */ }
  }
  out.sort((a, b) => a.num - b.num);
  // Por fichero: `sustituye` con clave marca ese fichero; con id (AP escritos antes de las claves), los de ese id.
  const fuera = new Set();
  for (const a of out) {
    if (!a.sustituye) continue;
    const xs = out.filter((b) => b !== a && (b.clave === a.sustituye || (RE_ID.test(a.sustituye) && b.id === a.sustituye)));
    for (const b of xs) fuera.add(b.clave);
  }
  for (const a of out) a.vigente = !fuera.has(a.clave);
  return out;
}

const vigentes = (root) => leer(root).filter((a) => a.vigente);

/** true si la entrada `toca` cubre el fichero (igual, o carpeta terminada en /). */
function cubre(entrada, rel) {
  const e = norm(entrada); const r = norm(rel);
  return !!e && (e === r || (e.endsWith('/') && r.startsWith(e)));
}

/** Vigentes cuyo `toca` incluye `rel`. Barato: si no hay carpeta de aprendizajes, [] sin mas. */
function quetocan(root, rel) {
  try { if (!fs.existsSync(dirAbs(root))) return []; } catch { return []; }
  return vigentes(root).filter((a) => a.toca.some((t) => cubre(t, rel)));
}

/** `AP-NNN [tipo] titulo` (titulo recortado). */
const linea = (a) => `${a.id} [${a.tipo}] ${a.titulo.slice(0, 100)}`;

/** Nombres de AP en develop/main (y sus origin/) sin checkout: otra rama pudo usar ya un numero. */
function nombresEnRamas(root) {
  const out = [];
  for (const ref of RAMAS_NUMERACION) {
    try {
      const r = spawnSync('git', ['-c', 'core.quotepath=false', 'ls-tree', '--name-only', ref, '--', `${dirRel(root)}/`], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 5000 });
      if (r.status === 0) out.push(...String(r.stdout).split(/\r?\n/).map((l) => l.split('/').pop()).filter(Boolean));
    } catch { /* sin git */ }
  }
  return out;
}

/** Siguiente numero libre: mayor de los ficheros AP-NNN-* (legibles o no, aqui y en develop/main) + 1. */
function siguienteId(root) {
  let max = 0;
  const ver = (f) => { const m = String(f).match(/^AP-(\d{3,})-/); if (m) max = Math.max(max, Number(m[1])); };
  try { fs.readdirSync(dirAbs(root)).forEach(ver); } catch { /* sin carpeta */ }
  nombresEnRamas(root).forEach(ver);
  return `AP-${String(max + 1).padStart(3, '0')}`;
}

/** Clave del AP que se sustituye: la clave tal cual, o el id si solo hay un fichero con el. Lanza si no. */
function resolverSustituye(root, s) {
  const todos = leer(root);
  if (RE_CLAVE.test(s) && todos.some((a) => a.clave === s)) return s;
  if (RE_ID.test(s)) {
    const xs = todos.filter((a) => a.id === s);
    if (xs.length === 1) return xs[0].clave;
    if (xs.length > 1) throw new Error(`sustituye: ${s} es ambiguo (${xs.map((a) => a.clave).join(', ')}); usa el nombre completo, p. ej. --sustituye ${xs[0].clave}`);
  }
  throw new Error(`sustituye: ${String(s).slice(0, 80)} no existe`);
}

function slug(titulo) {
  const s = String(titulo || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');
  return s || 'aprendizaje';
}

let _guardas = null;
function secretosEn(texto) {
  if (!_guardas) _guardas = require('../guardas.js')({ fs, path, ROOT: process.cwd(), git: () => '', faroSchema: () => null });
  return _guardas.secretosEn(texto);
}

/** Valida y compone sin escribir: { id, nombre, rel, abs, texto }. Lanza con un motivo en llano. */
function preparar(root, { tipo, titulo, toca = [], fuente = 'manual', sustituye, cuerpo = '' } = {}) {
  if (!TIPOS.includes(tipo)) throw new Error(`tipo no válido: ${tipo} (decidido | descartado | cuidado)`);
  const t0 = String(titulo || '').replace(/[\r\n\t]+/g, ' ').trim();
  if (!t0) throw new Error('falta el título');
  const lista = (Array.isArray(toca) ? toca : String(toca).split(',')).map(norm).filter(Boolean);
  const sus = sustituye !== undefined && sustituye !== null && sustituye !== '' ? resolverSustituye(root, String(sustituye)) : null;
  const f = String(fuente || 'manual').replace(/[\r\n]+/g, ' ').trim();
  const c0 = String(cuerpo || '').trim();
  if (secretosEn([t0, f, c0, ...lista].join('\n')).length) throw new Error('contiene un secreto: no se guarda');
  // misma mascara que el minado (email, telefono, token): un aprendizaje se versiona y se comparte
  const { enmascarar } = require('./minado.js');
  const t = enmascarar(t0);
  const c = enmascarar(c0);
  const id = siguienteId(root);
  const nombre = `${id}-${slug(t)}.md`;
  const texto = [
    '---', `id: ${id}`, `titulo: ${JSON.stringify(t)}`, `tipo: ${tipo}`,
    ...(lista.length ? ['toca:', ...lista.map((x) => `  - ${JSON.stringify(x)}`)] : ['toca: []']),
    `fuente: ${JSON.stringify(f)}`, ...(sus ? [`sustituye: ${sus}`] : []), '---', '', c, '',
  ].join('\n');
  return { id, nombre, rel: `${dirRel(root)}/${nombre}`, abs: path.join(dirAbs(root), nombre), texto };
}

/** Escribe un aprendizaje nuevo (nunca sobrescribe). Devuelve { id, rel }. */
function guardar(root, datos) {
  const p = preparar(root, datos);
  const dir = path.dirname(p.abs);
  if (!dirSinEnlaces(root, dir)) throw new Error('la carpeta de aprendizajes no es segura (enlace)');
  fs.mkdirSync(dir, { recursive: true });
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('la carpeta de aprendizajes no es segura (enlace)');
  fs.writeFileSync(p.abs, p.texto, { flag: 'wx' });
  return { id: p.id, rel: p.rel };
}

module.exports = { TIPOS, leer, vigentes, quetocan, siguienteId, preparar, guardar, linea, parsear, dirRel, cubre };
