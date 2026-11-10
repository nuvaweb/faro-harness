// 'pr crear' publica la rama ANTES de pedir el PR.
//
// Bug reportado por un usuario, reproducible y NO transitorio: la secuencia rama -> commit ->
// 'pr crear' fallaba SIEMPRE la primera vez, y funcionaba tras un 'git push -u' manual. La causa no
// era la red: la forja no puede abrir una peticion desde una rama que nunca ha visto. El harness
// llamaba a la API sin asegurarse de que la rama estuviera publicada.
//
// Se vivia como "error transitorio, reintento" porque el reintento venia despues del push manual —
// lo que arreglaba no era repetir, era el push que se colaba en medio.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${n}-`));
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000 });

// Repo local con un remoto REAL (bare en disco): asi el push funciona de verdad, sin red ni tokens.
function repoConRemoto(nombre) {
  const bare = tmp(`${nombre}-remoto`);
  git(bare, 'init', '--bare', '-b', 'main');
  const dir = tmp(nombre);
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'base');
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-u', 'origin', 'main');
  git(dir, 'switch', '-c', 'develop');
  git(dir, 'push', '-u', 'origin', 'develop');
  return { dir, bare };
}
const ramasRemotas = (bare) => (git(bare, 'branch', '--format=%(refname:short)').stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);

test('publicarRamaSiHaceFalta: una rama local que NO esta en el remoto se publica', async () => {
  const { dir, bare } = repoConRemoto('pr-sin-publicar');
  git(dir, 'switch', '-c', 'feat/nueva');
  fs.writeFileSync(path.join(dir, 'b.txt'), '1');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'feat: algo');
  assert.ok(!ramasRemotas(bare).includes('feat/nueva'), 'premisa: aun no esta publicada');

  const mod = await import(`file://${path.join(HOOKS, 'lib', 'git.js').replace(/\\/g, '/')}`);
  const g = mod.default({ ROOT: dir, fs, path });
  const r = g.publicarRamaSiHaceFalta('feat/nueva');
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(r.publicada, 'debe informar de que la publico');
  assert.ok(ramasRemotas(bare).includes('feat/nueva'), 'la rama debe existir ya en el remoto');
});

test('publicarRamaSiHaceFalta: si la rama YA esta publicada no vuelve a empujar', async () => {
  const { dir } = repoConRemoto('pr-ya-publicada');
  git(dir, 'switch', '-c', 'feat/publicada');
  fs.writeFileSync(path.join(dir, 'b.txt'), '1');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'feat: algo');
  git(dir, 'push', '-u', 'origin', 'feat/publicada');

  const mod = await import(`file://${path.join(HOOKS, 'lib', 'git.js').replace(/\\/g, '/')}`);
  const g = mod.default({ ROOT: dir, fs, path });
  const r = g.publicarRamaSiHaceFalta('feat/publicada');
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.publicada, false, 'ya estaba: no hacia falta publicarla');
});

test('publicarRamaSiHaceFalta: con commits locales por delante, los empuja (el PR debe ver el trabajo completo)', async () => {
  const { dir, bare } = repoConRemoto('pr-desfasada');
  git(dir, 'switch', '-c', 'feat/desfasada');
  fs.writeFileSync(path.join(dir, 'b.txt'), '1');
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'feat: primero');
  git(dir, 'push', '-u', 'origin', 'feat/desfasada');
  fs.writeFileSync(path.join(dir, 'c.txt'), '1');
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'feat: segundo, sin subir');

  const mod = await import(`file://${path.join(HOOKS, 'lib', 'git.js').replace(/\\/g, '/')}`);
  const g = mod.default({ ROOT: dir, fs, path });
  const r = g.publicarRamaSiHaceFalta('feat/desfasada');
  assert.ok(r.ok, JSON.stringify(r));
  const remotos = (git(bare, 'log', '--format=%s', 'feat/desfasada').stdout || '');
  assert.match(remotos, /segundo, sin subir/, 'el commit local debe haber llegado al remoto');
});

test('publicarRamaSiHaceFalta: sin remoto lo dice claro, y no intenta un push que no puede funcionar', async () => {
  const dir = tmp('pr-sin-remoto');
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1');
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'base');
  git(dir, 'switch', '-c', 'feat/x');

  const mod = await import(`file://${path.join(HOOKS, 'lib', 'git.js').replace(/\\/g, '/')}`);
  const g = mod.default({ ROOT: dir, fs, path });
  const r = g.publicarRamaSiHaceFalta('feat/x');
  assert.strictEqual(r.ok, false);
  assert.match(String(r.msg), /remoto/i, JSON.stringify(r));
});

// Sin remoto, 'pr crear' ni siquiera llega a la publicacion: el selector de forja corta antes
// (no hay adaptador para una forja 'desconocida') con un mensaje que ya orienta bien. Se deja
// constancia de ese orden para que un cambio futuro no lo empeore sin que un test lo note.
test('pr crear: sin remoto corta en el selector de forja, con mensaje util', () => {
  const dir = tmp('pr-sin-remoto-cli');
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1');
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'base');
  git(dir, 'switch', '-c', 'feat/x');
  const r = spawnSync(process.execPath, [HARNESS, 'pr', 'crear', '--base', 'develop', '--titulo', 'X'], {
    cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  const todo = `${r.stdout}${r.stderr}`;
  assert.match(todo, /no hay adaptador|sube la rama/i, todo);
});
