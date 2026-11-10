// #182 — politica del simulacro de despliegue (funcion pura): solo al publicar, forzado, o si el cambio afecta al despliegue.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const D = createRequire(import.meta.url)(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks', 'lib', 'dry-run.js'));
const app = { rutaApp: 'apps/api', entrypoint: 'src/index.ts', depsRutas: ['packages/shared'] };

test('al publicar o con --simulacro siempre; sin rama base, por prudencia', () => {
  assert.strictEqual(D.debeSimular({ ...app, publicar: true, ficheros: [] }).si, true);
  assert.strictEqual(D.debeSimular({ ...app, forzar: true, ficheros: [] }).si, true);
  assert.strictEqual(D.debeSimular({ ...app, ficheros: null }).si, true);
});

test('logica interior no dispara el simulacro; wrangler.*, entrypoint y dependencias, si', () => {
  const si = (ficheros) => D.debeSimular({ ...app, ficheros });
  assert.strictEqual(si(['apps/api/src/util.ts', 'apps/web/wrangler.jsonc', 'README.md']).si, false, 'otra app y logica interior');
  assert.match(si([]).motivo, /ningún cambio afecta al despliegue/);
  for (const f of ['apps/api/wrangler.jsonc', 'apps/api/wrangler.toml', 'apps/api/wrangler.staging.jsonc', 'apps/api/src/index.ts', 'apps/api/package.json', 'packages/shared/package.json', 'pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml']) {
    assert.strictEqual(si(['apps/api/src/util.ts', f]).si, true, f);
  }
  assert.strictEqual(si(['apps/api/src/sub/package.json']).si, false, 'solo el package.json de la app');
  assert.strictEqual(si(['apps/web/package.json']).si, false, 'el de otra app no cuenta');
});

test('repo simple (app en la raiz)', () => {
  const r = (ficheros) => D.debeSimular({ rutaApp: '', entrypoint: 'src/index.ts', depsRutas: [], ficheros });
  assert.strictEqual(r(['src/util.ts']).si, false);
  assert.strictEqual(r(['wrangler.jsonc']).si, true);
  assert.strictEqual(r(['src/index.ts']).si, true);
  assert.strictEqual(r(['package.json']).si, true);
});

test('entrypoint: main de wrangler.jsonc o wrangler.toml', () => {
  assert.strictEqual(D.entrypoint({ main: './src/worker.ts' }, null), 'src/worker.ts');
  assert.strictEqual(D.entrypoint(null, 'name = "x"\nmain = "src/w.ts"\n'), 'src/w.ts');
  assert.strictEqual(D.entrypoint({}, null), null);
  assert.strictEqual(D.entrypoint(null, null), null);
});
