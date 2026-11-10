// #124 — Un aviso INFORMATIVO no bloquea ni despierta al agente.
//
// "5 rama(s) en el remoto con trabajo que aun no esta en develop" salia con exit 2 y la plataforma lo
// presentaba como "Stop hook blocking error": el agente se veia obligado a seguir por algo que no le
// tocaba resolver. Criterio: exit 2 solo para lo que el agente DEBE atender; lo informativo va al
// humano por systemMessage, con exit 0.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { clasificarAvisos } = require(path.join(HOOKS, 'lib', 'remoto-arranque.js'));

const sh = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const harness = (sub, dir, input = '{}') => spawnSync(process.execPath, [path.join(HOOKS, 'harness.js'), sub], {
  cwd: dir, encoding: 'utf8', timeout: 120000, input,
  env: { ...process.env, CLAUDE_PROJECT_DIR: dir, FARO_GITHUB_TOKEN: '', GITHUB_TOKEN: '' },
});

// ---------- la clasificacion (pura) ----------

test('las ramas remotas pendientes son INFORMATIVAS; ir por detras exige accion', () => {
  const c = clasificarAvisos({
    pendientes: { base: 'origin/develop', ramas: [{ ref: 'origin/feat/x', fecha: '2026-10-01', autor: 'A' }] },
    trabajo: { rama: 'feat/mia', situacion: 'detras', detras: 2, delante: 0 },
  });
  assert.strictEqual(c.info.length, 1, JSON.stringify(c));
  assert.match(c.info[0], /rama\(s\) en el remoto/);
  assert.strictEqual(c.accion.length, 1);
  assert.match(c.accion[0], /por detras/);
});

test('sin red sigue siendo accion: "no lo se" no es "esta bien"', () => {
  assert.strictEqual(clasificarAvisos({ fetchFallido: true }).accion.length, 1);
});

// ---------- end to end ----------

function escenario() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-info-'));
  const remoto = path.join(base, 'remoto.git');
  sh(base, 'init', '-q', '--bare', remoto);
  const clon = (n) => {
    const d = path.join(base, n);
    sh(base, 'clone', '-q', remoto, d);
    sh(d, 'config', 'user.email', `${n}@t`); sh(d, 'config', 'user.name', n); sh(d, 'config', 'commit.gpgsign', 'false');
    return d;
  };
  const commit = (d, f) => { fs.writeFileSync(path.join(d, f), f); sh(d, 'add', '-A'); sh(d, 'commit', '-q', '-m', f); };
  const local = clon('local');
  commit(local, 'a.txt');
  sh(local, 'branch', '-m', 'develop'); sh(local, 'push', '-q', '-u', 'origin', 'develop');
  sh(remoto, 'symbolic-ref', 'HEAD', 'refs/heads/develop');
  sh(local, 'switch', '-q', '-c', 'feat/mia');
  commit(local, 'mia.txt'); sh(local, 'push', '-q', '-u', 'origin', 'feat/mia');
  const otro = clon('otro');
  sh(otro, 'switch', '-q', '-c', 'feat/de-otro', 'origin/develop');
  commit(otro, 'otro.txt'); sh(otro, 'push', '-q', 'origin', 'feat/de-otro');
  return local;
}

test('vigilar: solo ramas remotas pendientes -> exit 0 y systemMessage, nada por stderr', () => {
  const local = escenario();
  const r = harness('vigilar', local);
  assert.strictEqual(r.status, 0, `un aviso informativo no despierta al agente:\n${r.stderr}`);
  assert.strictEqual(r.stderr.trim(), '');
  const j = JSON.parse(r.stdout.trim());
  assert.match(j.systemMessage, /feat\/de-otro/, r.stdout);
});

test('stop-check: con ramas remotas sin integrar y nada pendiente, sale con 0', () => {
  const local = escenario();
  sh(local, 'fetch', '-q', 'origin');
  const r = harness('stop-check', local, '{"session_id":"x"}');
  assert.strictEqual(r.status, 0, r.stderr);
});

test('stop-check: el bloqueo legitimo se mantiene (artefacto generado sin commitear)', () => {
  const local = escenario();
  fs.writeFileSync(path.join(local, 'ESTADO.md'), '# Estado\n');
  const r = harness('stop-check', local, '{"session_id":"x"}');
  assert.strictEqual(r.status, 2, `ESTADO.md suelto sigue bloqueando:\n${r.stdout}`);
});
