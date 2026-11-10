import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inventarioRamas, asegurarDevelopLocal } from '../bin/lib/repo.mjs';

// Crea un repo git temporal con un commit inicial en 'main'.
function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-git-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1'); g('add', '-A'); g('commit', '-m', 'c1');
  const gitLocal = (a) => { try { return execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  return { dir, g, gitLocal };
}

test('inventarioRamas: detecta rama actual, principal y ramas con commits extra', () => {
  const { dir, g, gitLocal } = tmpRepo();
  // feature-x parte de main y añade un commit que main no tiene.
  g('switch', '-c', 'feature-x');
  fs.writeFileSync(path.join(dir, 'b.txt'), '2'); g('add', '-A'); g('commit', '-m', 'c2');
  g('switch', 'main');
  const inv = inventarioRamas(gitLocal);
  assert.equal(inv.ramaActual, 'main');
  assert.equal(inv.principalExistente, 'main');
  assert.deepEqual(inv.otrasRamas, ['feature-x']);
  assert.deepEqual(inv.ramasConMasCommits, ['feature-x']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('inventarioRamas: rama al día no cuenta como "con commits extra"', () => {
  const { dir, g, gitLocal } = tmpRepo();
  g('switch', '-c', 'develop');   // develop == main (sin commits extra)
  const inv = inventarioRamas(gitLocal);
  assert.equal(inv.ramaActual, 'develop');
  assert.deepEqual(inv.ramasConMasCommits, []);   // main no está por delante de develop
  fs.rmSync(dir, { recursive: true, force: true });
});

test('asegurarDevelopLocal: crea develop desde la fuente y deja HEAD en develop', () => {
  const { dir, gitLocal } = tmpRepo();   // en 'main'
  asegurarDevelopLocal(dir, 'main');
  assert.equal(gitLocal(['rev-parse', '--abbrev-ref', 'HEAD']), 'develop');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('asegurarDevelopLocal: si develop ya existe, hace switch y termina en develop', () => {
  const { dir, g, gitLocal } = tmpRepo();
  g('branch', 'develop');   // develop existe pero estamos en main
  asegurarDevelopLocal(dir, 'main');
  assert.equal(gitLocal(['rev-parse', '--abbrev-ref', 'HEAD']), 'develop');
  fs.rmSync(dir, { recursive: true, force: true });
});
