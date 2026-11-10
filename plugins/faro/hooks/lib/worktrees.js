// lib/worktrees.js — LIMPIEZA DE WORKTREES DE AGENTES (#251): que los worktrees que crean los agentes
// aislados (.claude/worktrees/<x>) no queden olvidados en disco, sin perder nunca trabajo.
//
// REGLA. Solo se borra un worktree que cumple las TRES: (1) vive en <repo>/.claude/worktrees/, (2) no tiene
// cambios sin guardar (ni ficheros sin seguimiento) y (3) su HEAD ya esta integrado en la base (develop; si
// no existe, main/master), por merge normal o por squash/rebase. Cualquier otro se CITA por nombre y se deja.
// Nunca se borra el worktree en el que se esta trabajando, ni uno fuera de .claude/worktrees/.
//
// SEGURIDAD: git con argumentos fijos (execFile, sin shell); `git worktree remove` SIN --force, asi que git
// mismo se niega si hubiera algo sin guardar; los mensajes llevan solo el nombre de la carpeta del worktree.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CARPETA = path.join('.claude', 'worktrees');
const LINEA_IGNORE = '.claude/worktrees/';

const git = (cwd, args) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 }).trim();
const ok = (cwd, args) => { try { git(cwd, args); return true; } catch { return false; } };
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const igual = (a, b) => (process.platform === 'win32' ? real(a).toLowerCase() === real(b).toLowerCase() : real(a) === real(b));

/** Entradas de `git worktree list --porcelain`: [{ ruta, head, rama|null, prunable }]. La primera es el checkout principal. */
function entradas(root) {
  let txt;
  try { txt = git(root, ['worktree', 'list', '--porcelain']); } catch { return []; }
  return txt.split(/\r?\n\r?\n/).map((bloque) => {
    const e = { ruta: null, head: null, rama: null, prunable: false };
    for (const l of bloque.split(/\r?\n/)) {
      if (l.startsWith('worktree ')) e.ruta = l.slice(9).trim();
      else if (l.startsWith('HEAD ')) e.head = l.slice(5).trim();
      else if (l.startsWith('branch ')) e.rama = l.slice(7).trim().replace(/^refs\/heads\//, '');
      else if (l.startsWith('prunable')) e.prunable = true;
    }
    return e;
  }).filter((e) => e.ruta);
}

function baseDe(cwd) {
  return ['develop', 'main', 'master'].find((b) => ok(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])) || null;
}

/** ¿El HEAD ya esta en la base? Merge normal (ancestro) o squash/rebase (fusionar no cambiaria el arbol de la base). */
function integrado(cwd, base, head) {
  if (ok(cwd, ['merge-base', '--is-ancestor', head, base])) return true;
  try {
    const arbolBase = git(cwd, ['rev-parse', `${base}^{tree}`]);
    return git(cwd, ['merge-tree', '--write-tree', base, head]).split(/\r?\n/)[0].trim() === arbolBase;
  } catch { return false; }          // conflicto o git antiguo: ante la duda, NO esta integrado
}

function dentroDe(carpeta, ruta) {
  const rel = path.relative(real(carpeta), real(ruta));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Los worktrees de agentes del repo con el motivo por el que NO se pueden borrar (null = se pueden).
 * Solo lee: no modifica nada.
 * @param {string} root cualquier ruta dentro del repo (checkout principal o un worktree)
 * @param {{actual?: string}} [o] worktree en uso (por defecto, el del proceso)
 * @returns {{nombre: string, ruta: string, rama: string|null, motivo: string|null}[]}
 */
function clasificar(root, { actual } = {}) {
  const todas = entradas(root);
  if (!todas.length) return [];
  const principal = todas[0].ruta;
  const carpeta = path.join(principal, CARPETA);
  const base = baseDe(principal);
  let enUso = actual;
  if (enUso === undefined) { try { enUso = git(process.cwd(), ['rev-parse', '--show-toplevel']); } catch { enUso = null; } }
  return todas.slice(1).filter((e) => !e.prunable && dentroDe(carpeta, e.ruta)).map((e) => {
    const nombre = path.basename(e.ruta);
    let motivo = null;
    if (enUso && igual(enUso, e.ruta)) motivo = 'en uso (es el worktree de esta sesion)';
    else if (!fs.existsSync(e.ruta)) motivo = 'carpeta ausente';
    else {
      let sucio = true;
      try { sucio = git(e.ruta, ['status', '--porcelain']) !== ''; } catch {}
      if (sucio) motivo = 'cambios sin guardar';
      else if (!base || !e.head || !integrado(principal, base, e.head)) motivo = base ? `rama sin integrar en ${base}` : 'sin rama base con la que comparar';
    }
    return { nombre, ruta: e.ruta, rama: e.rama, motivo };
  });
}

/** Borra los worktrees que se pueden borrar y limpia registros huerfanos. Devuelve lo hecho y lo que queda. */
function barrer(root, opts = {}) {
  const principal = (entradas(root)[0] || {}).ruta;
  if (!principal) return { borrados: [], pendientes: [] };
  ok(principal, ['worktree', 'prune']);                              // registros de carpetas ya borradas a mano
  const borrados = []; const pendientes = [];
  for (const w of clasificar(principal, opts)) {
    if (w.motivo) { pendientes.push(w); continue; }
    try { git(principal, ['worktree', 'remove', w.ruta]); borrados.push(w.nombre); }   // sin --force: git se niega si hubiera algo
    catch { pendientes.push({ ...w, motivo: 'git no pudo borrarlo (en uso por otro proceso?)' }); }
  }
  ok(principal, ['worktree', 'prune']);
  return { borrados, pendientes };
}

/** Barrido de arranque de sesion: borra lo seguro y devuelve el aviso de lo que queda ('' si nada). Nunca lanza. */
function avisoCorto(root, opts) {
  try {
    const { borrados, pendientes } = barrer(root, opts);
    const partes = [];
    if (borrados.length) partes.push(`FARO: ${borrados.length === 1 ? 'borrado 1 worktree de agente' : `borrados ${borrados.length} worktrees de agentes`} ya integrado${borrados.length === 1 ? '' : 's'} (${borrados.join(', ')}).`);
    if (pendientes.length) partes.push(`FARO: ${pendientes.length === 1 ? '1 worktree de agente sin limpiar' : `${pendientes.length} worktrees de agentes sin limpiar`}: ${pendientes.map((p) => `${p.nombre} (${p.motivo})`).join(', ')}. Revisalos con: node harness.js worktrees.`);
    return partes.join(' ');
  } catch { return ''; }
}

// ───────────────────────── .gitignore versionado ─────────────────────────
const RE_IGNORE = /^\/?\.claude\/(worktrees\/?(\*+)?)?$/;
function gitignoreFalta(root) {
  try { return !fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/).some((l) => RE_IGNORE.test(l.trim())); }
  catch { return true; }
}
/** Anade `.claude/worktrees/` al .gitignore si falta. true = lo anadio. */
function asegurarGitignore(root) {
  if (!gitignoreFalta(root)) return false;
  const f = path.join(root, '.gitignore');
  let txt = ''; try { txt = fs.readFileSync(f, 'utf8'); } catch {}
  fs.writeFileSync(f, `${txt}${txt && !txt.endsWith('\n') ? '\n' : ''}${LINEA_IGNORE}\n`);
  return true;
}

// ───────────────────────── comando `harness.js worktrees` ─────────────────────────
function cli(argv, { root, out = (t) => console.log(t) } = {}) {
  if (argv.includes('--al-terminar')) { barrer(root); return 0; }     // hook SubagentStop: en silencio, nunca estorba
  if (argv.includes('--ignorar')) {
    out(asegurarGitignore(root) ? `Añadido ${LINEA_IGNORE} al .gitignore.` : `${LINEA_IGNORE} ya estaba en el .gitignore.`);
    return 0;
  }
  const limpiar = argv.includes('--limpiar');
  const lineas = [];
  if (limpiar) {
    const r = barrer(root);
    lineas.push(r.borrados.length ? `Borrados ${r.borrados.length}: ${r.borrados.join(', ')}.` : 'Nada que borrar: ningún worktree limpio e integrado.');
  }
  const ws = clasificar(root);
  lineas.push(`Worktrees de agentes (.claude/worktrees): ${ws.length}`);
  for (const w of ws) lineas.push(`  ${w.nombre}${w.rama ? ` · ${w.rama}` : ''} · ${w.motivo ? `se queda: ${w.motivo}` : 'borrable (limpio e integrado)'}`);
  if (!limpiar && ws.some((w) => !w.motivo)) lineas.push('Borra los marcados como borrables con: node harness.js worktrees --limpiar');
  if (gitignoreFalta(root)) lineas.push(`Falta ${LINEA_IGNORE} en el .gitignore: node harness.js worktrees --ignorar`);
  out(lineas.join('\n'));
  return 0;
}

module.exports = { CARPETA, LINEA_IGNORE, entradas, clasificar, barrer, avisoCorto, gitignoreFalta, asegurarGitignore, cli };
