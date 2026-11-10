// #167: 'validate' tardaba mas de 2 minutos en un monorepo real. Perfilado sobre un monorepo sintetico
// (test/monorepo-sintetico.cjs): el JS del harness gasta ~0,7 s; el 98 % del tiempo eran los GATES
// (pnpm run typecheck/lint/test/build + simulacro de despliegue de cada app afectada, ~10 s cada uno
// sin node_modules). Un gate lento es trabajo de CI/consolidar/publicar, no de la validacion de ciclo.
// Contrato nuevo: validate a secas NO ejecuta gates; los pide --gates (apps afectadas), --todas o --app.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'harness.js');
const { generar } = require('./monorepo-sintetico.cjs');
const WIN = process.platform === 'win32';

// pnpm/npx FALSOS en el PATH: registran en que carpeta se les invoca y devuelven 0. Asi el test es
// determinista, no necesita pnpm ni red, y detecta cualquier gate lanzado.
function conShims() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-shims-'));
  const marca = path.join(bin, 'marca.txt');
  for (const n of ['pnpm', 'npx']) {
    if (WIN) fs.writeFileSync(path.join(bin, `${n}.cmd`), `@echo off\r\necho %CD% ${n} %* >> "${marca}"\r\nexit /b 0\r\n`);
    else { fs.writeFileSync(path.join(bin, n), `#!/bin/sh\necho "$PWD ${n} $*" >> "${marca}"\n`); fs.chmodSync(path.join(bin, n), 0o755); }
  }
  const lanzados = () => (fs.existsSync(marca) ? fs.readFileSync(marca, 'utf8').split('\n').filter(Boolean) : []);
  return { env: { PATH: bin + path.delimiter + process.env.PATH }, lanzados };
}

// Repo sintetico en una rama de trabajo que toca solo app0 (develop = base).
function repoDeTrabajo(opts) {
  const dir = generar(opts);
  const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('switch', '-q', '-c', 'feat/x', 'develop');
  fs.appendFileSync(path.join(dir, 'apps/app0/src/m1.ts'), '// x\n');
  g('commit', '-q', '-am', 'x');
  return dir;
}

const validate = (dir, env, ...args) => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [HARNESS, 'validate', ...args], { cwd: dir, encoding: 'utf8', timeout: 120000, env: { ...process.env, ...env, CLAUDE_PROJECT_DIR: dir } });
  return { out: r.stdout + r.stderr, status: r.status, ms: Date.now() - t0 };
};

test('validate a secas NO ejecuta gates y avisa de como pedirlos', () => {
  const sh = conShims();
  const dir = repoDeTrabajo({ apps: 4, ficheros: 40, cambios: 5 });
  const r = validate(dir, sh.env);
  assert.strictEqual(r.status, 0, r.out);
  assert.deepStrictEqual(sh.lanzados(), [], 'ningun gate debia lanzarse');
  assert.match(r.out, /Gates: no ejecutados/, r.out);
  assert.match(r.out, /--gates/, r.out);
});

test('validate --gates ejecuta los de las apps afectadas, y solo esas', () => {
  const sh = conShims();
  const dir = repoDeTrabajo({ apps: 4, ficheros: 40, cambios: 5 });
  const r = validate(dir, sh.env, '--gates');
  assert.strictEqual(r.status, 0, r.out);
  const l = sh.lanzados();
  assert.ok(l.length >= 4, `faltan gates de app0:\n${l.join('\n')}`);
  assert.ok(l.every((x) => /app0/.test(x)), `solo app0:\n${l.join('\n')}`);
  assert.match(r.out, /Gates por app: app0/, r.out);
});

test('validate --todas ejecuta los gates de todas las apps (lo que pasan consolidar y publicar)', () => {
  const sh = conShims();
  const dir = repoDeTrabajo({ apps: 3, ficheros: 20, cambios: 3 });
  const r = validate(dir, sh.env, '--todas');
  assert.strictEqual(r.status, 0, r.out);
  const l = sh.lanzados().join('\n');
  for (const a of ['app0', 'app1', 'app2']) assert.match(l, new RegExp(a), `falta ${a}`);
});

test('validate --app ejecuta solo la app pedida', () => {
  const sh = conShims();
  const dir = repoDeTrabajo({ apps: 3, ficheros: 20, cambios: 3 });
  const r = validate(dir, sh.env, '--app', 'app2');
  assert.strictEqual(r.status, 0, r.out);
  const l = sh.lanzados();
  assert.ok(l.length > 0 && l.every((x) => /app2/.test(x)), l.join('\n'));
});

test('regresion de rendimiento: validate en un monorepo grande responde en segundos', () => {
  const sh = conShims();
  const dir = repoDeTrabajo({ apps: 8, ficheros: 150, cambios: 30 });
  const r = validate(dir, sh.env);
  assert.strictEqual(r.status, 0, r.out);
  // Umbral MUY holgado (3,4 s en reposo; ~38 s medidos con la maquina saturada por la bateria completa).
  // El contrato duro es el de arriba (ningun gate lanzado); esto solo caza un recorrido que se dispare.
  assert.ok(r.ms < 90000, `validate tardo ${r.ms} ms`);
});
