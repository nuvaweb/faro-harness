// #106 — Al arrancar sesion: fetch --all --prune y VALIDAR que local y remoto coinciden.
//
// Antes el vigilante hacia 'git fetch origin' sin --prune y solo miraba main/develop: tu rama de
// trabajo podia ir por detras de su remoto, las ramas borradas seguian "vivas" y el trabajo de otros
// esperando en el remoto no lo contaba nadie. Ahora, ademas, pone al dia main/develop cuando es seguro.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(RAIZ, 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { avisosArranque } = require(path.join(HOOKS, 'lib', 'remoto-arranque.js'));

// ---------- la decision (pura) ----------

test('sin red lo DICE: no da por bueno lo que no pudo comprobar', () => {
  const a = avisosArranque({ fetchFallido: true });
  assert.strictEqual(a.length, 1);
  assert.match(a[0], /no se si local y remoto coinciden/i);
});

test('todo coincide: silencio', () => {
  assert.deepStrictEqual(avisosArranque({ avanzadas: [], detras: [], divergidas: [], sinRemota: [], trabajo: null, pendientes: { base: 'origin/develop', ramas: [] } }), []);
});

test('las ramas pendientes se resumen: maximo 5 y el resto contado', () => {
  const ramas = Array.from({ length: 8 }, (_, i) => ({ ref: `origin/feat/r${i}`, fecha: '2026-10-0' + (i % 9), autor: 'A' }));
  const [txt] = avisosArranque({ pendientes: { base: 'origin/develop', ramas } });
  assert.match(txt, /^8 rama\(s\) en el remoto/);
  assert.match(txt, /\(\+3 mas\)/);
  assert.match(txt, /consolidar/);
});

// ---------- end to end, con un remoto de verdad ----------

const sh = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
function clon(base, remoto, nombre) {
  const dir = path.join(base, nombre);
  sh(base, 'clone', '-q', remoto, dir);
  sh(dir, 'config', 'user.email', `${nombre}@t`); sh(dir, 'config', 'user.name', nombre);
  sh(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}
function commit(dir, fichero, texto = fichero) {
  fs.writeFileSync(path.join(dir, fichero), texto);
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', fichero);
}

// Remoto con develop; 'local' trabaja en feat/mia (arbol LIMPIO) y 'otro' es el companero.
function escenario() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-arranque-'));
  const remoto = path.join(base, 'remoto.git');
  sh(base, 'init', '-q', '--bare', remoto);
  const local = clon(base, remoto, 'local');
  commit(local, 'a.txt');
  sh(local, 'branch', '-m', 'develop'); sh(local, 'push', '-q', '-u', 'origin', 'develop');
  sh(remoto, 'symbolic-ref', 'HEAD', 'refs/heads/develop');
  sh(local, 'switch', '-q', '-c', 'feat/mia');
  commit(local, 'mia.txt'); sh(local, 'push', '-q', '-u', 'origin', 'feat/mia');
  const otro = clon(base, remoto, 'otro');
  return { local, otro };
}
const vigilar = (dir) => spawnSync(process.execPath, [path.join(HOOKS, 'harness.js'), 'vigilar'], {
  cwd: dir, encoding: 'utf8', timeout: 120000,
  env: { ...process.env, CLAUDE_PROJECT_DIR: dir, FARO_GITHUB_TOKEN: '', GITHUB_TOKEN: '' },
});

test('develop por detras del remoto: la PONE AL DIA (sin fusionar) y lo cuenta', () => {
  const { local, otro } = escenario();
  sh(otro, 'switch', '-q', 'develop');
  commit(otro, 'b.txt'); commit(otro, 'c.txt');
  sh(otro, 'push', '-q', 'origin', 'develop');

  const r = vigilar(local);
  assert.match(r.stderr, /'develop' puesta al dia con el remoto \(\+2 commit/, r.stderr);
  assert.strictEqual(r.status, 2, 'debe despertar al agente con lo que hizo');
  assert.strictEqual(sh(local, 'rev-parse', 'develop').stdout, sh(local, 'rev-parse', 'origin/develop').stdout);
  assert.strictEqual(sh(local, 'branch', '--show-current').stdout.trim(), 'feat/mia', 'no te cambia de rama');
});

test('tu rama de trabajo por DETRAS de su remoto se avisa (y no se toca)', () => {
  const { local, otro } = escenario();
  sh(otro, 'switch', '-q', 'feat/mia');
  commit(otro, 'de-otro.txt'); sh(otro, 'push', '-q', 'origin', 'feat/mia');
  const antes = sh(local, 'rev-parse', 'HEAD').stdout;

  const r = vigilar(local);
  assert.match(r.stderr, /Tu rama 'feat\/mia' va 1 commit\(s\) por detras de origin\/feat\/mia/, r.stderr);
  assert.strictEqual(sh(local, 'rev-parse', 'HEAD').stdout, antes, 'tu rama no se mueve sola');
});

test('ramas remotas pendientes de validar se listan; las integradas por squash NO', () => {
  const { local, otro } = escenario();
  sh(otro, 'switch', '-q', '-c', 'feat/pendiente', 'origin/develop');
  commit(otro, 'nuevo.txt'); sh(otro, 'push', '-q', 'origin', 'feat/pendiente');
  // Integrada por squash: su contenido ya esta en develop aunque ningun commit sea ancestro.
  sh(otro, 'switch', '-q', '-c', 'feat/hecha', 'origin/develop');
  commit(otro, 'hecho.txt'); sh(otro, 'push', '-q', 'origin', 'feat/hecha');
  sh(otro, 'switch', '-q', 'develop');
  sh(otro, 'merge', '-q', '--squash', 'feat/hecha'); sh(otro, 'commit', '-q', '-m', 'squash hecha');
  sh(otro, 'push', '-q', 'origin', 'develop');

  // #124: es INFORMATIVO (trabajo de otros esperando), asi que va al humano por systemMessage y no
  // despierta al agente.
  const r = vigilar(local);
  const salida = `${r.stdout}${r.stderr}`;
  assert.match(salida, /1 rama\(s\) en el remoto con trabajo que aun no esta en develop: feat\/pendiente/, salida);
  assert.ok(!/feat\/hecha/.test(salida), `la integrada por squash no esta pendiente:\n${salida}`);
  assert.ok(!/feat\/mia \(/.test(salida), 'tu propia rama no se lista como pendiente');
});

test('--prune: una rama borrada en el servidor desaparece tambien de las refs locales', () => {
  const { local, otro } = escenario();
  sh(otro, 'switch', '-q', '-c', 'feat/efimera', 'origin/develop');
  commit(otro, 'e.txt'); sh(otro, 'push', '-q', 'origin', 'feat/efimera');
  sh(local, 'fetch', '-q', 'origin');
  assert.strictEqual(sh(local, 'rev-parse', '--verify', '--quiet', 'origin/feat/efimera').status, 0);
  sh(otro, 'push', '-q', 'origin', '--delete', 'feat/efimera');

  vigilar(local);
  assert.notStrictEqual(sh(local, 'rev-parse', '--verify', '--quiet', 'origin/feat/efimera').status, 0, 'la ref borrada debia podarse');
});
