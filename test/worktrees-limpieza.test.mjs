// LIMPIEZA DE WORKTREES DE AGENTES (#251): los agentes aislados crean worktrees en .claude/worktrees/<x>
// y nada garantizaba que se borraran. lib/worktrees.js borra SOLO los limpios con su rama ya integrada en
// la base, avisa por nombre del resto (cambios sin guardar / rama sin integrar) y nunca toca uno en uso.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'harness.js');
const WT = require(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'worktrees.js'));

let TMP, MAIN;
const git = (cwd, ...a) => execFileSync('git', a, { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const dir = (n) => path.join(MAIN, '.claude', 'worktrees', n);
const existe = (n) => fs.existsSync(dir(n));

before(() => {
  TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'faro-wtl-')));
  MAIN = path.join(TMP, 'repo');
  fs.mkdirSync(MAIN);
  git(MAIN, 'init', '-q', '-b', 'develop');
  git(MAIN, 'config', 'user.email', 't@example.com');
  git(MAIN, 'config', 'user.name', 'Prueba');
  fs.writeFileSync(path.join(MAIN, 'README.md'), '# prueba\n');
  git(MAIN, 'add', '.');
  git(MAIN, 'commit', '-q', '-m', 'inicial');
  // limpio: rama recien creada, sin commits propios -> integrada y sin cambios
  git(MAIN, 'worktree', 'add', '-q', '-b', 'worktree-limpio', dir('limpio'));
  // sucio: fichero sin guardar
  git(MAIN, 'worktree', 'add', '-q', '-b', 'worktree-sucio', dir('sucio'));
  fs.writeFileSync(path.join(dir('sucio'), 'wip.txt'), 'trabajo a medias\n');
  // sin integrar: commit propio que develop no tiene
  git(MAIN, 'worktree', 'add', '-q', '-b', 'worktree-vivo', dir('vivo'));
  fs.writeFileSync(path.join(dir('vivo'), 'nuevo.txt'), 'x\n');
  git(dir('vivo'), 'add', '.');
  git(dir('vivo'), 'commit', '-q', '-m', 'trabajo');
  // integrado: commit propio YA mergeado en develop
  git(MAIN, 'worktree', 'add', '-q', '-b', 'worktree-hecho', dir('hecho'));
  fs.writeFileSync(path.join(dir('hecho'), 'hecho.txt'), 'y\n');
  git(dir('hecho'), 'add', '.');
  git(dir('hecho'), 'commit', '-q', '-m', 'hecho');
  git(MAIN, 'merge', '-q', '--no-ff', 'worktree-hecho', '-m', 'merge hecho');
  // integrado por SQUASH: sus commits no son ancestros de develop, pero el contenido ya esta
  git(MAIN, 'worktree', 'add', '-q', '-b', 'worktree-squash', dir('squash'));
  fs.writeFileSync(path.join(dir('squash'), 'sq.txt'), 'z\n');
  git(dir('squash'), 'add', '.');
  git(dir('squash'), 'commit', '-q', '-m', 'sq');
  git(MAIN, 'merge', '-q', '--squash', 'worktree-squash');
  git(MAIN, 'commit', '-q', '-m', 'squash sq');
  // un worktree FUERA de .claude/worktrees no es de los agentes: no se toca
  git(MAIN, 'worktree', 'add', '-q', '-b', 'feat/ajeno', path.join(TMP, 'ajeno'));
});

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

test('clasificar: motivo por worktree (limpio e integrado => sin motivo)', () => {
  const por = Object.fromEntries(WT.clasificar(MAIN).map((w) => [w.nombre, w.motivo]));
  assert.deepStrictEqual(Object.keys(por).sort(), ['hecho', 'limpio', 'sucio', 'squash', 'vivo'].sort());
  assert.strictEqual(por.limpio, null);
  assert.strictEqual(por.hecho, null);
  assert.strictEqual(por.squash, null);
  assert.match(por.sucio, /cambios sin guardar/);
  assert.match(por.vivo, /sin integrar/);
});

test('clasificar: sin modificar nada (solo lee)', () => {
  WT.clasificar(MAIN);
  for (const n of ['limpio', 'sucio', 'vivo', 'hecho', 'squash']) assert.ok(existe(n), n);
});

test('barrer: borra solo los limpios e integrados y deja el resto citado por nombre', () => {
  const r = WT.barrer(MAIN);
  assert.deepStrictEqual(r.borrados.sort(), ['hecho', 'limpio', 'squash']);
  assert.deepStrictEqual(r.pendientes.map((p) => p.nombre).sort(), ['sucio', 'vivo']);
  assert.ok(!existe('limpio') && !existe('hecho') && !existe('squash'));
  assert.ok(existe('sucio') && existe('vivo'));
  assert.ok(fs.existsSync(path.join(dir('sucio'), 'wip.txt')), 'el trabajo sin guardar sigue intacto');
  assert.ok(fs.existsSync(path.join(TMP, 'ajeno')), 'un worktree fuera de .claude/worktrees no se toca');
});

test('barrer: no deja registros colgando (git worktree prune)', () => {
  fs.rmSync(dir('vivo'), { recursive: true, force: true });       // carpeta borrada a mano: registro huerfano
  assert.match(git(MAIN, 'worktree', 'list', '--porcelain'), /worktrees[\\/]vivo/);
  WT.barrer(MAIN);
  assert.doesNotMatch(git(MAIN, 'worktree', 'list', '--porcelain'), /worktrees[\\/]vivo/);
});

test('barrer: nunca borra el worktree en el que se esta trabajando', () => {
  git(MAIN, 'worktree', 'add', '-q', '-b', 'worktree-enuso', dir('enuso'));
  const r = WT.barrer(MAIN, { actual: dir('enuso') });
  assert.ok(existe('enuso'));
  assert.ok(r.pendientes.some((p) => p.nombre === 'enuso' && /en uso/.test(p.motivo)));
});

test('avisoCorto: cita por nombre lo pendiente y calla si no hay nada', () => {
  const a = WT.avisoCorto(MAIN);
  assert.match(a, /sucio/);
  assert.match(a, /sin guardar|sin integrar/);
  fs.rmSync(path.join(dir('sucio'), 'wip.txt'));
  assert.ok(!existe('enuso'), 'el barrido de arranque borro el limpio que ya no esta en uso');
  git(MAIN, 'worktree', 'remove', '--force', dir('sucio'));
  assert.strictEqual(WT.avisoCorto(MAIN), '');
});

test('gitignore: detecta que falta .claude/worktrees/ y lo anade sin duplicar', () => {
  assert.strictEqual(WT.gitignoreFalta(MAIN), true);
  assert.strictEqual(WT.asegurarGitignore(MAIN), true);
  assert.strictEqual(WT.gitignoreFalta(MAIN), false);
  assert.strictEqual(WT.asegurarGitignore(MAIN), false, 'segunda vez: ya estaba');
  const gi = fs.readFileSync(path.join(MAIN, '.gitignore'), 'utf8');
  assert.strictEqual(gi.split('\n').filter((l) => l.trim() === '.claude/worktrees/').length, 1);
});

test('cableado: harness.js worktrees lista y --limpiar borra lo seguro', () => {
  git(MAIN, 'worktree', 'add', '-q', '-b', 'worktree-cli', dir('cli'));
  const env = { ...process.env, CLAUDE_PROJECT_DIR: MAIN };
  const lista = spawnSync(process.execPath, [HARNESS, 'worktrees'], { cwd: MAIN, env, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(lista.status, 0, lista.stderr);
  assert.match(lista.stdout, /cli/);
  assert.ok(existe('cli'), 'listar no borra');
  const limpia = spawnSync(process.execPath, [HARNESS, 'worktrees', '--limpiar'], { cwd: MAIN, env, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(limpia.status, 0, limpia.stderr);
  assert.ok(!existe('cli'));
});

test('cableado: --al-terminar (hook SubagentStop) borra en silencio y sale 0', () => {
  git(MAIN, 'worktree', 'add', '-q', '-b', 'worktree-fin', dir('fin'));
  const env = { ...process.env, CLAUDE_PROJECT_DIR: MAIN };
  const r = spawnSync(process.execPath, [HARNESS, 'worktrees', '--al-terminar'], { cwd: MAIN, env, input: '{}', encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!existe('fin'));
});
