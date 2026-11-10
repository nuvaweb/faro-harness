// Forja declarada (#254): un GitLab o GitHub autoalojado con un nombre de servidor neutro
// (git.cliente.com) no se reconoce por el host. Se declara con git config y manda sobre la deteccion.
// Funciona igual con remoto https y ssh. Sin red.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const FORGE = require(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'forge.js'));
const CRED = require(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'credenciales.js'));

function repo(remote, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-decl-'));
  const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  g('remote', 'add', 'origin', remote);
  for (const [k, v] of Object.entries(config)) g('config', k, v);
  return (...a) => { const r = g(...a); return r.status === 0 ? r.stdout.trim() : ''; };
}

test('un host neutro sin declarar sigue siendo desconocido', () => {
  assert.equal(FORGE.detect(repo('https://git.cliente.com/equipo/app.git')).forge, 'desconocida');
});

test('faro.forja declara la forja del repo y conserva la ruta con subgrupos', () => {
  const f = FORGE.detect(repo('https://git.cliente.com/equipo/plataforma/app.git', { 'faro.forja': 'gitlab' }));
  assert.equal(f.forge, 'gitlab');
  assert.equal(f.selfHosted, true);
  assert.equal(f.declarada, true);
  assert.equal(f.path, 'equipo/plataforma/app');
});

test('faro.<host>.forja declara todo un servidor y vale con ssh', () => {
  const f = FORGE.detect(repo('git@git.cliente.com:equipo/app.git', { 'faro.git.cliente.com.forja': 'gitlab' }));
  assert.equal(f.forge, 'gitlab');
  assert.equal(f.host, 'git.cliente.com');
  const s = FORGE.detect(repo('ssh://git@git.cliente.com:2222/equipo/app.git', { 'faro.git.cliente.com.forja': 'gitlab' }));
  assert.equal(s.forge, 'gitlab');
  assert.equal(s.path, 'equipo/app');
});

test('GitHub Enterprise con host neutro se declara igual', () => {
  const f = FORGE.detect(repo('https://code.empresa.com/org/app.git', { 'faro.forja': 'github' }));
  assert.equal(f.forge, 'github');
  assert.equal(f.owner, 'org');
});

test('un valor de forja que no existe no se acepta', () => {
  assert.equal(FORGE.detect(repo('https://git.cliente.com/equipo/app.git', { 'faro.forja': 'bitbucket' })).forge, 'desconocida');
});

test('FARO_TOKEN solo se entrega al host que nombra FARO_TOKEN_HOST', () => {
  const antes = { ...process.env };
  process.env.FARO_CONFIG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'faro-cfg-')), '.faro.json');
  process.env.FARO_TOKEN = 'tok-generico';
  process.env.FARO_TOKEN_HOST = 'git.cliente.com';
  for (const k of ['GITHUB_TOKEN', 'FARO_GITHUB_TOKEN', 'GITLAB_TOKEN', 'FARO_GITLAB_TOKEN']) process.env[k] = '';
  try {
    const c = CRED();
    assert.equal(c.tokenPara('git.cliente.com'), 'tok-generico');
    assert.equal(c.tokenPara('git.ajeno.com'), null);
    assert.equal(c.tokenPara('gitlab.ajeno.com'), null);
  } finally { process.env = antes; }
});

test('el diagnostico de forja explica como declararla cuando no la reconoce', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-decl-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['remote', 'add', 'origin', 'https://git.cliente.com/equipo/app.git'], { cwd: dir });
  const r = spawnSync(process.execPath, [path.join(RAIZ, 'plugins', 'faro', 'hooks', 'harness.js'), 'forge'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir, FARO_CONFIG_PATH: path.join(dir, '.faro.json') },
  });
  assert.match(r.stdout, /git config faro\.forja gitlab/);
});
