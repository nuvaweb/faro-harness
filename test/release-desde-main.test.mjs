// #116 — 'release' contaba como pendiente lo YA publicado. Buscaba el ultimo tag con 'git describe'
// desde HEAD (develop), pero los tags de version se crean en el merge de MAIN, que no es antecesor de
// develop: desde develop el ultimo tag alcanzable era uno antiguo. Caso real (2026-10-05): justo despues
// de publicar v0.59.1, 'release' decia "15 cambios sin publicar desde v0.55.2".
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks', 'harness.js');
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', timeout: 60000 });
const release = (cwd) => spawnSync(process.execPath, [HARNESS, 'release'], { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: cwd } }).stdout;

// main con un release antiguo (v0.1.0) y un segundo release publicado como lo hace 'publicar':
// merge --no-ff develop -> main y tag EN EL MERGE de main. Develop queda sin ese commit de merge.
function repoPublicado() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-release-'));
  git(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 'T'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) git(dir, 'config', k, v);
  fs.mkdirSync(path.join(dir, 'plugins', 'faro', '.claude-plugin'), { recursive: true });
  const version = (v) => fs.writeFileSync(path.join(dir, 'plugins', 'faro', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'faro', version: v }));
  version('0.1.0');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'feat: base');
  git(dir, 'tag', 'v0.1.0');
  git(dir, 'switch', '-q', '-c', 'develop');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a'); version('0.2.0');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'feat: algo nuevo');
  git(dir, 'switch', '-q', 'main');
  git(dir, 'merge', '-q', '--no-ff', 'develop', '-m', 'merge develop -> main');
  git(dir, 'tag', 'v0.2.0');
  git(dir, 'switch', '-q', 'develop');
  return dir;
}

test('recien publicado, desde develop: NADA que publicar (no cuenta lo ya publicado)', () => {
  const out = release(repoPublicado());
  assert.match(out, /Nada que publicar/, out);
  assert.doesNotMatch(out, /desde v0\.1\.0/, out);
});

test('con trabajo nuevo en develop: cuenta SOLO eso, desde el ultimo release de main', () => {
  const dir = repoPublicado();
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'fix: corrige algo');
  const out = release(dir);
  assert.match(out, /Acumulado desde v0\.2\.0: 1 cambio/, out);
  assert.match(out, /fix: corrige algo/, out);
  assert.doesNotMatch(out, /feat: algo nuevo/, 'lo publicado en v0.2.0 no vuelve a contarse');
});
