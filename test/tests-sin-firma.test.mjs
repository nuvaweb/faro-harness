// #169: los tests nunca dependen de la identidad ni de la firma del usuario. El lanzador (test/run.js)
// y el helper test/aislar-git.cjs fijan una config git propia para TODOS los procesos hijos.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const TEST = path.dirname(fileURLToPath(import.meta.url));
const { aislarGit } = require('./aislar-git.cjs');
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${n}-`));

// Entorno hostil: simula un usuario con firma obligatoria y un agente de firma que falla
// (equivale a `-c commit.gpgsign=true -c gpg.program=false`), via variables que PESAN MAS que cualquier fichero.
const hostil = () => ({
  ...process.env,
  GIT_CONFIG_COUNT: '4',
  GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'true',
  GIT_CONFIG_KEY_1: 'gpg.program', GIT_CONFIG_VALUE_1: 'false',
  GIT_CONFIG_KEY_2: 'user.name', GIT_CONFIG_VALUE_2: 'Usuario Real',
  GIT_CONFIG_KEY_3: 'gpg.format', GIT_CONFIG_VALUE_3: 'openpgp',
});
const git = (cwd, env, ...a) => spawnSync('git', a, { cwd, env, encoding: 'utf8', timeout: 60000 });

test('control: con el entorno hostil, un commit sin aislar falla por la firma', () => {
  const d = tmp('ctl');
  git(d, hostil(), 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(d, 'a'), 'x');
  git(d, hostil(), 'add', '-A');
  const r = git(d, hostil(), 'commit', '-q', '-m', 'x');
  assert.notStrictEqual(r.status, 0);
});

test('aislarGit: el commit funciona con identidad fija y sin firma aunque el usuario firme', () => {
  const env = aislarGit(hostil());
  assert.ok(!('GIT_CONFIG_COUNT' in env) && !('GIT_CONFIG_PARAMETERS' in env));
  assert.strictEqual(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.ok(fs.existsSync(env.GIT_CONFIG_GLOBAL));
  const d = tmp('aislado');
  git(d, env, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(d, 'a'), 'x');
  git(d, env, 'add', '-A');
  const r = git(d, env, 'commit', '-q', '-m', 'x');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(git(d, env, 'log', '-1', '--format=%an <%ae>').stdout.trim(), 'FARO Test <test@faro.invalid>');
  assert.strictEqual(git(d, env, 'config', '--get', 'commit.gpgsign').stdout.trim(), 'false');
});

test('run.js: los hijos de la suite no heredan la firma del usuario', () => {
  const d = tmp('probe');
  const probe = path.join(d, 'sonda.test.mjs');
  fs.writeFileSync(probe, `import { test } from 'node:test'; import assert from 'node:assert'; import { spawnSync } from 'node:child_process';
test('sonda', () => {
  const g = (...a) => spawnSync('git', a, { encoding: 'utf8' }).stdout.trim();
  assert.strictEqual(g('config', '--get', 'commit.gpgsign'), 'false');
  assert.strictEqual(g('config', '--get', 'user.email'), 'test@faro.invalid');
  assert.strictEqual(process.env.GIT_CONFIG_NOSYSTEM, '1');
});`);
  const r = spawnSync(process.execPath, [path.join(TEST, 'run.js'), probe], { env: hostil(), encoding: 'utf8', timeout: 120000 });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});
