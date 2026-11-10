#!/usr/bin/env node
/**
 * FARO · ramas — normalizador INTELIGENTE de ramas git: analiza y limpia con criterio.
 *
 * Por defecto SOLO informa (no borra nada). Clasifica cada rama local frente a la BASE
 * (develop si existe; si no, main/master):
 *   ☠ MUERTA : integrada en la base (merge normal) O su contenido ya esta en la base
 *              (squash/rebase: sin diff efectivo) -> es basura, borrable.
 *   ● VIVA   : tiene trabajo NO integrado -> se MANTIENE. Avisa si lleva mucho sin tocar
 *              (posible abandono) para que decidas tu — NO la borra.
 * Protege SIEMPRE: la rama actual, main/master y la base.
 *
 * Uso:
 *   node .claude/hooks/ramas.js                 # informe (read-only)
 *   node .claude/hooks/ramas.js --purge         # borra SOLO las MUERTAS (locales)
 *   node .claude/hooks/ramas.js --purge --remotes  # ademas: git remote prune origin
 *   node .claude/hooks/ramas.js --stale 45      # umbral "posible abandono" en dias (def. 60)
 */
const { execFileSync } = require('child_process');
const git = (a) => execFileSync('git', a, { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }).trim();
const ok = (a) => { try { git(a); return true; } catch { return false; } };

const args = process.argv.slice(2);
const PURGE = args.includes('--purge');
const REMOTES = args.includes('--remotes');
const JSON_OUT = args.includes('--json'); // solo conteo, para el resumen agregado de sesion (nunca purga)
const STALE = (() => { const i = args.indexOf('--stale'); return i >= 0 && /^\d+$/.test(args[i + 1] || '') ? +args[i + 1] : 60; })();

if (!ok(['rev-parse', '--is-inside-work-tree'])) { console.error('✗ No es un repositorio git.'); process.exit(1); }
const base = ['develop', 'main', 'master'].find((b) => ok(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]));
if (!base) { console.error('✗ No hay rama base (develop/main/master).'); process.exit(1); }
const current = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const PROTECT = new Set([base, 'main', 'master', current]);

const merged = new Set(git(['branch', '--merged', base]).split('\n').map((s) => s.replace(/^\*?\s*/, '').trim()).filter(Boolean));
const all = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/']).split('\n').map((s) => s.trim()).filter(Boolean).filter((b) => !PROTECT.has(b));

// squash/rebase merge: ningun commit de la rama es ancestro de 'base' (--merged no la ve), pero su
// CONTENIDO ya esta alli. 'diff --quiet base...rama' (usado antes) compara el diff ACUMULADO desde
// el merge-base y falla si 'base' avanzo DESPUES con commits ajenos a la rama (el diff de base ya
// no es solo el squash, asi que deja de coincidir). 'merge-tree' fusiona en PRUEBA (sin tocar nada):
// si el arbol resultante es IDENTICO al arbol ACTUAL de 'base', mergear no cambiaria nada -> ya esta.
function arbolTrasFusionCoincide(baseRef, rama) {
  const arbolBase = (() => { try { return git(['rev-parse', `${baseRef}^{tree}`]); } catch { return null; } })();
  if (!arbolBase) return false;
  try { return git(['merge-tree', baseRef, rama]) === arbolBase; } catch { return false; }
}

const now = Date.now();
const info = (b) => ({ b, date: git(['log', '-1', '--format=%cs', b]), days: Math.floor((now - +git(['log', '-1', '--format=%ct', b]) * 1000) / 86400000) });

const dead = [], squash = [], alive = [], broken = [];
for (const b of all) {
  // Una rama con ref corrupto/inaccesible (gc agresivo, encoding raro) no debe tumbar el informe
  // completo (herramienta "solo informa" por defecto) -> se reporta aparte, sigue con el resto.
  let o;
  try { o = info(b); } catch { broken.push(b); continue; }
  if (merged.has(b)) dead.push(o);
  else if (arbolTrasFusionCoincide(base, b)) squash.push(o); // contenido ya en base (squash/rebase)
  else alive.push(o);
}

if (JSON_OUT) {
  // Solo conteo (sin listar nombres): lo consume el resumen agregado de sesion, nunca purga.
  process.stdout.write(JSON.stringify({ base, muertas: dead.length + squash.length, vivas: alive.length, no_inspeccionables: broken.length }) + '\n');
  process.exit(0);
}

console.log(`\nbase: ${base}  ·  actual: ${current}  ·  protegidas: ${[...PROTECT].join(', ')}`);
console.log(`\n☠  MUERTAS (integradas en ${base}) — borrables (${dead.length + squash.length}):`);
dead.forEach((o) => console.log(`   ${o.b}  · ult ${o.date} (${o.days}d)  [merge]`));
squash.forEach((o) => console.log(`   ${o.b}  · ult ${o.date} (${o.days}d)  [squash/rebase: contenido ya en ${base}]`));
if (!dead.length && !squash.length) console.log('   (ninguna)');

console.log(`\n●  VIVAS (trabajo NO integrado) — se MANTIENEN (${alive.length}):`);
alive.forEach((o) => console.log(`   ${o.b}  · ult ${o.date} (${o.days}d)${o.days > STALE ? `  ⚠ posible abandono (>${STALE}d) — revisa tu` : ''}`));

if (broken.length) {
  console.log(`\n⚠  NO INSPECCIONABLES (ref roto o log inaccesible) — revisa a mano (${broken.length}):`);
  broken.forEach((b) => console.log(`   ${b}`));
}
if (!alive.length) console.log('   (ninguna)');

if (!PURGE) {
  console.log(`\n(informe · no se ha borrado nada)  →  limpiar muertas: node .claude/hooks/ramas.js --purge${REMOTES ? '' : '  [--remotes para podar origin]'}`);
  process.exit(0);
}

console.log(`\n… --purge: borrando ${dead.length + squash.length} rama(s) MUERTA(s) (las VIVAS NO se tocan):`);
for (const o of dead) { try { git(['branch', '-d', o.b]); console.log(`   ✓ ${o.b}`); } catch { console.log(`   ✗ ${o.b} (git -d lo rechazo; revisar a mano)`); } }
for (const o of squash) { try { git(['branch', '-D', o.b]); console.log(`   ✓ ${o.b} (forzada; su contenido ya esta en ${base})`); } catch { console.log(`   ✗ ${o.b}`); } }
if (REMOTES) { try { const r = git(['remote', 'prune', 'origin']); console.log(`\nremote prune origin:\n${r || '   (nada que podar)'}`); } catch { console.log('\n(no se pudo podar origin — sin acceso)'); } }
