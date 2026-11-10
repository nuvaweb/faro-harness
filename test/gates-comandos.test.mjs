// #182 — COMO se lanza cada gate: vitest/jest siempre en `run` y con workers limitados, tsc incremental,
// SOLO con las formas reconocidas; un comando desconocido no se modifica nunca.
import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const { comandoGate, formaEstable } = createRequire(import.meta.url)(path.join(HOOKS, 'lib', 'gates-comandos.js'));

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-gcmd-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const env = () => ({ ...process.env, FARO_PROC_DIR: tmp() });
const g = (nombre, script, extra = {}) => comandoGate({ pm: 'pnpm', nombre, script, cwd: tmp(), env: env(), ...extra });
const linea = (r) => [r.cmd, ...r.args].join(' ');

test('vitest sin modo run o en watch pasa a run, pool de forks y 2 workers', () => {
  assert.strictEqual(linea(g('test', 'vitest')), 'pnpm exec vitest run --pool=forks --maxWorkers=2');
  assert.strictEqual(linea(g('test', 'vitest --watch')), 'pnpm exec vitest run --pool=forks --maxWorkers=2');
  assert.strictEqual(linea(g('test', 'vitest watch')), 'pnpm exec vitest run --pool=forks --maxWorkers=2');
  assert.strictEqual(linea(g('test', 'vitest run src/foo')), 'pnpm exec vitest run src/foo --pool=forks --maxWorkers=2');
  assert.strictEqual(linea(g('test', 'vitest --run')), 'pnpm exec vitest --run --pool=forks --maxWorkers=2');
  const r = g('test', 'vitest'); assert.strictEqual(r.reconocido, 'vitest'); assert.strictEqual(r.env.CI, 'true');
});

test('lo que el script ya fija (pool, workers) se respeta', () => {
  assert.strictEqual(linea(g('test', 'vitest run --pool=threads --maxWorkers=1')), 'pnpm exec vitest run --pool=threads --maxWorkers=1');
  assert.strictEqual(linea(g('test', 'vitest run --no-file-parallelism')), 'pnpm exec vitest run --no-file-parallelism --pool=forks');
  assert.strictEqual(linea(g('test', 'vitest', { maxWorkers: 3 })), 'pnpm exec vitest run --pool=forks --maxWorkers=3');
});

test('npm y yarn usan su forma de exec; otro gestor no se reconoce', () => {
  assert.strictEqual(linea(g('test', 'vitest', { pm: 'npm' })), 'npm exec --no -- vitest run --pool=forks --maxWorkers=2');
  assert.strictEqual(linea(g('test', 'vitest', { pm: 'yarn' })), 'yarn run vitest run --pool=forks --maxWorkers=2');
  assert.strictEqual(linea(g('test', 'vitest', { pm: 'bun' })), 'bun run test');
});

test('jest: sin watch, en --ci y con workers limitados; -w de jest es maxWorkers', () => {
  assert.strictEqual(linea(g('test', 'jest')), 'pnpm exec jest --ci --maxWorkers=2');
  assert.strictEqual(linea(g('test', 'jest --watchAll')), 'pnpm exec jest --ci --maxWorkers=2');
  assert.strictEqual(linea(g('test', 'jest -w 4 src')), 'pnpm exec jest -w 4 src --ci');
  assert.strictEqual(linea(g('test', 'jest --runInBand')), 'pnpm exec jest --runInBand --ci');
});

test('un comando desconocido NO se modifica: se lanza tal cual con <gestor> run <script>', () => {
  for (const s of ['vitest run && echo hecho', 'vitest > salida.txt', 'FOO=1 vitest', 'vitest "src/a b"', 'node test.js', 'vitest $(echo x)', 'mocha', 'vitest run;ls', '', undefined]) {
    const r = g('test', s);
    assert.strictEqual(linea(r), 'pnpm run test', `no se toca: ${s}`);
    assert.strictEqual(r.reconocido, null);
    assert.strictEqual(r.env.CI, 'true', 'aun asi CI=true: un vitest suelto no se queda en watch');
  }
  assert.strictEqual(linea(g('lint', 'eslint .')), 'pnpm run lint');
  assert.deepStrictEqual(g('lint', 'vitest').env, {});
  assert.strictEqual(linea(g('build', 'vite build')), 'pnpm run build');
  assert.strictEqual(comandoGate({ pm: 'pnpm', nombre: 'a b; rm', script: 'x', cwd: tmp() }), null, 'nombre de script no valido');
});

function conTypescript() {
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, 'node_modules', 'typescript', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'node_modules', 'typescript', 'bin', 'tsc'), '// tsc falso\n');
  return cwd;
}

test('tsc --noEmit y tsc -p pasan a incremental con tsbuildinfo en la cache del usuario', () => {
  const cwd = conTypescript(); const e = env();
  const a = comandoGate({ pm: 'pnpm', nombre: 'typecheck', script: 'tsc --noEmit', cwd, env: e });
  assert.strictEqual(a.reconocido, 'tsc'); assert.strictEqual(a.cmd, process.execPath);
  assert.ok(a.args[0].endsWith(path.join('typescript', 'bin', 'tsc')));
  assert.deepStrictEqual(a.args.slice(1, 3), ['--noEmit', '--incremental']);
  assert.ok(a.args.includes('--tsBuildInfoFile'));
  const info = a.args[a.args.indexOf('--tsBuildInfoFile') + 1];
  assert.ok(info.startsWith(e.FARO_PROC_DIR) && info.endsWith('.tsbuildinfo'), info);
  const b = comandoGate({ pm: 'pnpm', nombre: 'typecheck', script: 'tsc -p tsconfig.app.json --noEmit', cwd, env: e });
  assert.ok(b.args.includes('tsconfig.app.json') && b.args.includes('--incremental'));
  assert.notStrictEqual(b.args[b.args.indexOf('--tsBuildInfoFile') + 1], info, 'un tsbuildinfo por proyecto');
  const c = comandoGate({ pm: 'pnpm', nombre: 'typecheck', script: 'tsc --noEmit', cwd, env: e });
  assert.deepStrictEqual(c.args, a.args, 'determinista');
});

test('tsc con opciones no reconocidas, build mode, sin typescript o con ruta rara: se deja como esta', () => {
  const cwd = conTypescript(); const e = env();
  for (const s of ['tsc --watch', 'tsc -b', 'tsc --noEmit --watch', 'tsc --noEmit && echo', 'tsc -p ../fuera --noEmit', 'tsc', 'tsc --outDir dist', 'tsc -p "a b"']) {
    assert.strictEqual(linea(comandoGate({ pm: 'pnpm', nombre: 'typecheck', script: s, cwd, env: e })), 'pnpm run typecheck', s);
  }
  assert.strictEqual(linea(comandoGate({ pm: 'pnpm', nombre: 'typecheck', script: 'tsc --noEmit', cwd: tmp(), env: e })), 'pnpm run typecheck', 'sin typescript resoluble');
  assert.strictEqual(linea(comandoGate({ pm: 'pnpm', nombre: 'build', script: 'tsc --noEmit', cwd, env: e })), 'pnpm run build', 'solo el gate typecheck');
});

test('la forma para la clave de cache no depende de rutas de la maquina', () => {
  const cwd = conTypescript();
  const op = { pm: 'pnpm', nombre: 'typecheck', script: 'tsc --noEmit', cwd, env: env() };
  const f1 = formaEstable(op, comandoGate(op)); const f2 = formaEstable({ ...op, env: env() }, comandoGate({ ...op, env: env() }));
  assert.deepStrictEqual(f1, f2);
  assert.ok(f1.every((x) => !x.includes(os.tmpdir())));
});
