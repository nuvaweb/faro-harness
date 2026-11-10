// #182 — GATES GOBERNADOS, de extremo a extremo con un monorepo sintetico y pnpm/npx FALSOS en el PATH:
// los gates pasan por el ejecutor (semaforo, cache, vitest en run con workers limitados), el simulacro de
// wrangler solo corre cuando importa, y dos validaciones simultaneas no ejecutan mas de N pesados a la vez.
//
// pnpm/npx falsos: registran cada invocacion (cwd + argumentos + inicio/fin) en un fichero y duermen un tiempo
// acotado. Todo termina solo: ningun fixture queda vivo.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { rastrear, guardaHuerfanos } from './lib-fixtures.mjs';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'harness.js');
const require = createRequire(import.meta.url);
const { generar } = require('./monorepo-sintetico.cjs');
const G = require(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'gobernador.js'));
guardaHuerfanos();

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-gg-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// ── pnpm/npx falsos ──
function shims() {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'fake.cjs'), `
    const fs = require('fs');
    const [nombre, ...args] = process.argv.slice(2);
    const log = (t) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ nombre, cwd: process.cwd(), args, t, ts: Date.now() }) + '\\n');
    log('ini');
    const ms = Math.min(Number(process.env.FAKE_MS || 0), 3000);
    if (ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    log('fin');
    process.exit(process.env.FAKE_FAIL && args.join(' ').includes(process.env.FAKE_FAIL) ? 1 : 0);
  `);
  for (const n of ['pnpm', 'npx']) {
    fs.writeFileSync(path.join(dir, `${n}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0fake.cjs" ${n} %*\r\n`);
    fs.writeFileSync(path.join(dir, n), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake.cjs" ${n} "$@"\n`, { mode: 0o755 });
  }
  return dir;
}
const SHIMS = shims();
const entorno = (extra = {}) => ({
  ...process.env, PATH: `${SHIMS}${path.delimiter}${process.env.PATH}`, FAKE_LOG: path.join(tmp(), 'fake.jsonl'),
  FARO_PROC_DIR: tmp(), FARO_CACHE_DIR: '', FARO_PESADOS: '', FARO_PESADOS_ESPERA_S: '', FARO_MEM_MIN_MB: '0', FARO_SIN_CACHE: '', FAKE_MS: '0', FAKE_FAIL: '', ...extra,
});
const harness = (dir, env, ...args) => {
  const r = spawnSync(process.execPath, [HARNESS, ...args], { cwd: dir, encoding: 'utf8', timeout: 400000, env: { ...env, CLAUDE_PROJECT_DIR: dir } });
  return { out: r.stdout + r.stderr, status: r.status };
};
const llamadas = (env) => {
  try { return fs.readFileSync(env.FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.t === 'ini').map((x) => ({ ...x, linea: `${x.nombre} ${x.args.join(' ')}`, app: path.basename(x.cwd) })); } catch { return []; }
};

test('los gates pasan por el ejecutor: vitest en run con 2 workers, el resto tal cual, el simulacro al publicar', () => {
  const dir = generar({ apps: 2, ficheros: 3, cambios: 1 }); const env = entorno();
  const r = harness(dir, env, 'gates', '--todas');
  assert.strictEqual(r.status, 0, r.out);
  const l = llamadas(env);
  for (const app of ['app0', 'app1']) {
    const de = l.filter((x) => x.app === app).map((x) => x.linea);
    assert.ok(de.includes('pnpm run typecheck'), `${app}: ${de}`);
    assert.ok(de.includes('pnpm run lint'));
    assert.ok(de.includes('pnpm exec vitest run --pool=forks --maxWorkers=2'), `vitest acotado: ${de}`);
    assert.ok(de.includes('pnpm run build'));
    assert.ok(de.includes('npx wrangler deploy --dry-run'), 'al publicar (--todas) el simulacro corre');
  }
  assert.strictEqual(l.length, 10);
  assert.deepStrictEqual(G.leerSlots(env), [], 'turnos liberados');
  harness(dir, env, 'gates', '--todas');
  assert.strictEqual(llamadas(env).length, 20, 'publicar/consolidar (--todas) NO reutilizan la cache: verifican de verdad, dry-run incluido');
});

test('cache: un gate que ya salio verde no se repite si el arbol no cambio; --sin-cache lo fuerza; el cambio invalida solo lo suyo', () => {
  const dir = generar({ apps: 2, ficheros: 3, cambios: 1 }); const env = entorno();
  harness(dir, env, 'gates', '--app', 'app0,app1');
  assert.strictEqual(llamadas(env).length, 8);
  const r2 = harness(dir, env, 'gates', '--app', 'app0,app1');
  assert.strictEqual(llamadas(env).length, 8, `no se repite nada:\n${r2.out}`);
  assert.match(r2.out, /gate typecheck reutilizado/);
  const r3 = harness(dir, env, 'gates', '--app', 'app0,app1', '--sin-cache');
  assert.strictEqual(llamadas(env).length, 16, '--sin-cache ejecuta todo de nuevo');
  assert.doesNotMatch(r3.out, /reutilizado/);
  fs.appendFileSync(path.join(dir, 'apps/app0/src/m0.ts'), '// cambio\n');
  const r4 = harness(dir, env, 'gates', '--app', 'app0,app1');
  const nuevas = llamadas(env).slice(16);
  assert.strictEqual(nuevas.length, 4, r4.out);
  assert.ok(nuevas.every((x) => x.app === 'app0'), 'solo se repite la app tocada');
  assert.match(r4.out, /app1 · typecheck: OK · gate typecheck reutilizado/);
});

test('un gate en rojo NO se cachea: se vuelve a ejecutar; los verdes de al lado si se reutilizan', () => {
  const dir = generar({ apps: 1, ficheros: 2, cambios: 1 });
  const env = entorno({ FAKE_FAIL: 'run lint' });
  const r1 = harness(dir, env, 'gates', '--app', 'app0');
  assert.strictEqual(r1.status, 1); assert.match(r1.out, /app0 · lint: FALLA/);
  const antes = llamadas(env).length;
  const r2 = harness(dir, { ...env, FAKE_FAIL: '' }, 'gates', '--app', 'app0');
  assert.strictEqual(r2.status, 0, r2.out);
  const nuevas = llamadas(env).slice(antes);
  assert.deepStrictEqual(nuevas.map((x) => x.linea), ['pnpm run lint'], 'solo el rojo se repite');
});

test('simulacro de wrangler: no corre si el cambio es logica interior; si cambia wrangler.* o las dependencias, si', () => {
  const dir = generar({ apps: 2, ficheros: 3, cambios: 1 }); const env = entorno();
  fs.appendFileSync(path.join(dir, 'apps/app0/src/m0.ts'), '// logica interior\n');
  const r1 = harness(dir, env, 'gates');
  assert.strictEqual(r1.status, 0, r1.out);
  assert.ok(llamadas(env).length > 0 && llamadas(env).every((x) => x.app === 'app0'), 'solo la app afectada');
  assert.ok(!llamadas(env).some((x) => x.nombre === 'npx'), 'sin simulacro');
  assert.match(r1.out, /app0 · deploy --dry-run: omitido — ningún cambio afecta al despliegue/);
  fs.appendFileSync(path.join(dir, 'apps/app0/wrangler.jsonc'), '// binding nuevo\n');
  const r2 = harness(dir, env, 'gates');
  assert.strictEqual(r2.status, 0, r2.out);
  assert.ok(llamadas(env).some((x) => x.nombre === 'npx' && x.app === 'app0'), 'cambia wrangler.*: el simulacro corre');
  const env3 = entorno();
  const dir3 = generar({ apps: 2, ficheros: 3, cambios: 1 });
  fs.appendFileSync(path.join(dir3, 'apps/app1/src/m0.ts'), '// x\n');
  harness(dir3, env3, 'gates', '--simulacro');
  assert.ok(llamadas(env3).some((x) => x.nombre === 'npx'), '--simulacro lo fuerza');
  const dir4 = generar({ apps: 2, ficheros: 3, cambios: 1 }); const env4 = entorno();
  const pk = path.join(dir4, 'apps/app1/package.json');
  const j = JSON.parse(fs.readFileSync(pk, 'utf8')); j.dependencies = { zod: '^3.0.0' }; fs.writeFileSync(pk, JSON.stringify(j));
  harness(dir4, env4, 'gates');
  assert.ok(llamadas(env4).some((x) => x.nombre === 'npx' && x.app === 'app1'), 'cambian las dependencias de la app: el simulacro corre');
});

test('sistema saturado: el gate no se da por bueno ni se cuelga; sale NO EVALUADO y sin ejecutar nada', () => {
  const dir = generar({ apps: 1, ficheros: 2, cambios: 1 });
  const env = entorno({ FARO_PESADOS: '1', FARO_PESADOS_ESPERA_S: '1' });
  const otro = G.adquirir({ env, max: 1, esperaS: 0, etiqueta: 'otra sesion' });
  assert.ok(otro.ok);
  try {
    const t0 = Date.now();
    const r = harness(dir, env, 'gates', '--todas');
    assert.strictEqual(r.status, 1, r.out);
    assert.match(r.out, /NO EVALUADO — sistema saturado/);
    assert.match(r.out, /1 trabajo pesado en curso/);
    assert.strictEqual(llamadas(env).length, 0);
    assert.ok(Date.now() - t0 < 120000);
  } finally { otro.liberar(); }
});

test('dos validaciones simultaneas en repos distintos no ejecutan mas de N pesados a la vez (N=1)', async () => {
  const d1 = generar({ apps: 1, ficheros: 2, cambios: 1 }); const d2 = generar({ apps: 1, ficheros: 2, cambios: 1 });
  const env = entorno({ FARO_PESADOS: '1', FARO_PESADOS_ESPERA_S: '240', FAKE_MS: '700' });
  const lanzar = (dir) => {
    const h = spawn(process.execPath, [HARNESS, 'gates', '--todas'], { cwd: dir, env: { ...env, CLAUDE_PROJECT_DIR: dir }, stdio: 'ignore', windowsHide: true });
    rastrear(h); h.ref();   // idem: la promesa que espera su salida necesita el bucle vivo
    return new Promise((res) => h.on('exit', res));
  };
  const codigos = await Promise.all([lanzar(d1), lanzar(d2)]);
  assert.deepStrictEqual(codigos, [0, 0]);
  const ev = fs.readFileSync(env.FAKE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((x) => [x.ts, x.t === 'ini' ? 1 : -1]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let dentro = 0; let max = 0; for (const [, d] of ev) { dentro += d; max = Math.max(max, dentro); }
  assert.strictEqual(ev.length, 20);
  assert.strictEqual(max, 1, 'nunca dos trabajos pesados a la vez');
});

test('harness.js recursos refleja la cache tras ejecutar gates', () => {
  const dir = generar({ apps: 1, ficheros: 2, cambios: 1 }); const env = entorno();
  harness(dir, env, 'gates', '--app', 'app0');
  const r = harness(dir, env, 'recursos');
  assert.match(r.out, /Pesados en curso: 0/);
  assert.match(r.out, /Caché de gates: 4 resultado\(s\)/);
  const l = harness(dir, env, 'recursos', '--limpiar', '--confirmo', '--cache');
  assert.match(l.out, /4 resultado\(s\) de caché/);
  assert.match(harness(dir, env, 'recursos').out, /Caché de gates: 0 resultado\(s\)/);
});

test('el cierre de dependencias sigue tambien las de version "*" o rango (npm/yarn), no solo workspace:', () => {
  const dir = generar({ apps: 2, ficheros: 3, cambios: 1 }); const env = entorno();
  const pk = path.join(dir, 'apps/app1/package.json');
  const j = JSON.parse(fs.readFileSync(pk, 'utf8')); j.dependencies = { 'mono-app0': '*' }; fs.writeFileSync(pk, JSON.stringify(j));
  harness(dir, env, 'gates', '--app', 'app1');
  const pn = () => llamadas(env).filter((x) => x.linea === 'pnpm run typecheck').length; const n0 = pn(); assert.strictEqual(n0, 1);
  harness(dir, env, 'gates', '--app', 'app1');
  assert.strictEqual(pn(), n0, 'sin cambios: cache');
  fs.appendFileSync(path.join(dir, 'apps/app0/src/m0.ts'), '// cambia la dependencia\n');
  harness(dir, env, 'gates', '--app', 'app1');
  assert.strictEqual(pn(), n0 + 1, 'cambia app0, de la que depende app1: se repite');
});

test('el dry-run no se cachea nunca', () => {
  const dir = generar({ apps: 1, ficheros: 2, cambios: 1 }); const env = entorno();
  harness(dir, env, 'gates', '--app', 'app0', '--simulacro');
  const n = llamadas(env).filter((x) => x.nombre === 'npx').length;
  harness(dir, env, 'gates', '--app', 'app0', '--simulacro');
  assert.strictEqual(llamadas(env).filter((x) => x.nombre === 'npx').length, n + 1);
});
