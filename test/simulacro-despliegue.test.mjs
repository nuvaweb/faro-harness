// SIMULACRO DE DESPLIEGUE (#89): en proyectos que compilan con Vite antes de desplegar (TanStack Start,
// React Router, Astro... con @cloudflare/vite-plugin), 'wrangler deploy --dry-run' sin compilar falla
// aunque el proyecto este bien. Orden: el simulacro PROPIO del proyecto (deploy:dry) -> si hay 'build',
// compilar y luego --dry-run -> si no, como antes. Igual en 'gates' y en el pipeline de CI.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const codeModule = require(path.join(HOOKS, 'lib', 'code.js'));

function repoWorker(scripts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-sim-'));
  fs.writeFileSync(path.join(dir, 'wrangler.jsonc'), JSON.stringify({ name: 'app-web', main: '@tanstack/react-start/server-entry', compatibility_date: '2026-09-01' }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app-web', scripts }));
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
  return codeModule(dir);
}
const pasoCi = (c) => c.ciPlan().gates.find((g) => g.name === 'deploy-dry-run');

test('con BUILD (Vite/TanStack Start): compila antes del --dry-run', () => {
  const c = repoWorker({ build: 'vite build', test: 'vitest run' });
  assert.deepStrictEqual(c.simulacroDespliegue().run, 'pnpm run build && npx wrangler deploy --dry-run');
  assert.strictEqual(pasoCi(c).run, 'pnpm run build && npx wrangler deploy --dry-run', 'el pipeline de CI hace lo mismo');
});

test('con simulacro PROPIO (deploy:dry): manda el del proyecto', () => {
  const c = repoWorker({ build: 'vite build', 'deploy:dry': 'vite build && wrangler deploy --dry-run --outdir dist' });
  assert.strictEqual(c.simulacroDespliegue().run, 'pnpm run deploy:dry');
  assert.strictEqual(pasoCi(c).run, 'pnpm run deploy:dry');
});

test('sin build ni simulacro propio: como antes', () => {
  const c = repoWorker({ test: 'vitest run' });
  assert.strictEqual(c.simulacroDespliegue().run, 'npx wrangler deploy --dry-run');
});

// #182: los gates gobernados escriben turnos y cache en el directorio privado del usuario: en los tests, a un temporal.
process.env.FARO_PROC_DIR = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "faro-proc-t-"));
process.env.FARO_MEM_MIN_MB = "0";   // estos tests prueban la logica de los gates, no la memoria de la maquina
