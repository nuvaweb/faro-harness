// #125 — Abrir una sesion no modifica el repo de trabajo.
//
// 'ensureWeeklyReport' escribia gestion/reporting/informes/<fecha>-semanal-informe.md en CADA
// arranque sin que nadie lo pidiera, y esa modificacion sin commitear contaminaba despues los avisos
// de git y de Stop. Ahora el arranque solo ANUNCIA que toca, y el informe se genera a peticion.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks', 'harness.js');
const DATOS = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-plugin-data-'));

const correr = (sub, dir, payload) => spawnSync(process.execPath, [HARNESS, sub], {
  cwd: dir, encoding: 'utf8', timeout: 120000, input: payload ? JSON.stringify(payload) : '',
  env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_DATA: DATOS, FARO_GITHUB_TOKEN: '', GITHUB_TOKEN: '' },
});
const estadoGit = (dir) => spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' }).stdout;
const semanales = (dir) => fs.readdirSync(path.join(dir, 'gestion', 'reporting', 'informes')).filter((f) => /-semanal-informe\.md$/.test(f));

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-semanal-'));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  const w = (rel, txt) => { fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), txt); };
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'T'); git('config', 'commit.gpgsign', 'false');
  w('ESTADO.md', `---
iniciativa: Semanal
fases_total: 1
fase_actual: 1
owner: T
funcional: documentos/funcional/f.md
---

### Fase 1 · Uno — in_progress
Lo que trae.
Objetivo: 2026-12-01
- [ ] #1 · Algo — @t
`);
  w('documentos/funcional/f.md', '# F\n');
  w('gestion/reporting/informes/.gitkeep', '');
  git('add', '-A'); git('commit', '-q', '-m', 'init'); git('switch', '-q', '-c', 'feat/1-algo');
  return dir;
}

test('tras harness.js session el arbol de trabajo no cambia, y el semanal pendiente se anuncia', () => {
  const dir = repo();
  const antes = estadoGit(dir);
  const r = correr('session', dir, { session_id: 's1', source: 'startup' });
  assert.strictEqual(estadoGit(dir), antes, `el arranque modifico el repo:\n${estadoGit(dir)}`);
  assert.deepStrictEqual(semanales(dir), [], 'el arranque no escribe el informe');
  assert.match(r.stdout, /Informe semanal pendiente/, 'pero si avisa de que toca');
});

test('el informe semanal se genera con un comando explicito, y no se duplica en la semana', () => {
  const dir = repo();
  const r = correr('informe-semanal', dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(semanales(dir).length, 1, r.stdout);
  const otra = correr('informe-semanal', dir);
  assert.match(otra.stdout, /Ya hay un informe semanal/);
  assert.strictEqual(semanales(dir).length, 1);
  assert.ok(!/Informe semanal pendiente/.test(correr('session', dir, { session_id: 's2', source: 'startup' }).stdout),
    'con el informe hecho ya no se anuncia');
});
