import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectarForja } from '../bin/lib/forja.mjs';

test('github https y ssh: owner/repo, sin .git', () => {
  for (const r of ['https://github.com/acme/faro-cli.git', 'git@github.com:acme/faro-cli.git', 'https://github.com/acme/faro-cli']) {
    const f = detectarForja(r);
    assert.equal(f.forja, 'github'); assert.equal(f.host, 'github.com'); assert.equal(f.owner, 'acme'); assert.equal(f.project, 'faro-cli'); assert.equal(f.path, 'acme/faro-cli'); assert.equal(f.selfHosted, false);
  }
});

test('gitlab con subgrupos: path completo, owner = grupo raiz', () => {
  const f = detectarForja('https://gitlab.com/Empresa/area/equipo/faro/plugin.git');
  assert.equal(f.forja, 'gitlab'); assert.equal(f.owner, 'Empresa'); assert.equal(f.project, 'plugin'); assert.equal(f.path, 'Empresa/area/equipo/faro/plugin');
});

test('un host con «gitlab» o «github» en el nombre no se adivina: queda desconocido', () => {
  for (const r of ['git@gitlab.cliente.com:grupo/proyecto.git', 'https://github.evil.com/org/repo.git']) {
    const f = detectarForja(r);
    assert.equal(f.forja, 'desconocida', r); assert.equal(f.selfHosted, false);
  }
});

test('la forja declarada reconoce un servidor propio y lo marca como declarado', () => {
  const f = detectarForja('git@gitlab.cliente.com:grupo/sub/proyecto.git', [], 'gitlab');
  assert.equal(f.forja, 'gitlab'); assert.equal(f.selfHosted, true); assert.equal(f.declarada, true); assert.equal(f.path, 'grupo/sub/proyecto');
  const gh = detectarForja('https://git.empresa.com/org/repo.git', [], 'github');
  assert.equal(gh.forja, 'github'); assert.equal(gh.declarada, true);
  assert.equal(detectarForja('https://github.com/a/b.git', [], 'gitlab').forja, 'github', 'un host público no se redeclara');
});

test('ruta local o vacio -> desconocida sin adivinar', () => {
  assert.equal(detectarForja('C:/tmp/repo/faro-x').forja, 'desconocida');
  assert.equal(detectarForja('/tmp/faro-x').forja, 'desconocida');
  assert.equal(detectarForja('').forja, 'desconocida');
  assert.equal(detectarForja(null).host, null);
});

test('host desconocido con dos segmentos NO es github aunque la ruta lo parezca', () => {
  const f = detectarForja('https://git.empresa.com/org/repo.git');
  assert.equal(f.forja, 'desconocida'); assert.equal(f.host, 'git.empresa.com'); assert.equal(f.path, 'org/repo');
});

test('url con usuario y token embebidos: el host se extrae limpio', () => {
  const f = detectarForja('https://x-access-token:ghp_abc@github.com/acme/faro-cli.git');
  assert.equal(f.forja, 'github'); assert.equal(f.host, 'github.com'); assert.equal(f.path, 'acme/faro-cli');
});
