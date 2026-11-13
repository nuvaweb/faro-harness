// Tarea T2 del grafo FARO (#298): resolucion de specs de import. Puro salvo la lectura inyectada.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const R = require(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'grafo', 'resolver.js'));
const ROOT = path.join(RAIZ, 'repo-simulado');

// Crea un resolver con un mapa {rel: texto}; los ficheros sin texto cuentan como vacios.
function mk(mapa, extra = []) {
  const lista = [...new Set([...Object.keys(mapa), ...extra])];
  const leer = (p) => {
    const rel = path.relative(ROOT, p).split(path.sep).join('/');
    if (!(rel in mapa)) throw new Error('ENOENT ' + rel);
    return mapa[rel];
  };
  return R.crearResolver(ROOT, lista, { leer });
}

test('relativo: extensiones, index, .js->.ts y barras de Windows', () => {
  const r = mk({}, ['src/a.ts', 'src/x.ts', 'src/d/index.ts', 'src/e.ts', 'src/w.ts']);
  assert.deepStrictEqual(r('src/a.ts', './x', 'js'), { destino: 'src/x.ts', clase: 'interno' });
  assert.deepStrictEqual(r('src/a.ts', './d', 'js'), { destino: 'src/d/index.ts', clase: 'interno' });
  assert.deepStrictEqual(r('src/a.ts', './e.js', 'js'), { destino: 'src/e.ts', clase: 'interno' });
  assert.deepStrictEqual(r('src/a.ts', '.\\w', 'js'), { destino: 'src/w.ts', clase: 'interno' });
  assert.deepStrictEqual(r('src/a.ts', './nada', 'js'), { destino: null, clase: 'no-resuelto' });
});

test('clases: sistema, paquete', () => {
  const r = mk({}, ['src/a.ts']);
  assert.strictEqual(r('src/a.ts', 'node:fs', 'js').clase, 'sistema');
  assert.strictEqual(r('src/a.ts', 'fs', 'js').clase, 'sistema');
  assert.strictEqual(r('src/a.ts', 'react', 'js').clase, 'paquete');
});

test('tsconfig con comentarios, comas finales, baseUrl y extends', () => {
  const r = mk({
    'tsconfig.base.json': '{\n // alias\n "compilerOptions": { "baseUrl": ".", /* x */ "paths": { "@/*": ["src/*"], }, },\n}',
    'tsconfig.json': '{ "extends": "./tsconfig.base.json", // url "http://x"\n "include": ["src"], }',
  }, ['src/a.ts', 'src/lib/y.ts']);
  assert.deepStrictEqual(r('src/a.ts', '@/lib/y', 'js'), { destino: 'src/lib/y.ts', clase: 'interno' });
  assert.strictEqual(r('src/a.ts', '@/lib/z', 'js').clase, 'no-resuelto');
});

test('workspaces de package.json y pnpm-workspace.yaml', () => {
  const comun = {
    'packages/ui/package.json': '{"name":"@org/ui","main":"src/index.ts"}',
  };
  const ficheros = ['apps/w/a.ts', 'packages/ui/src/index.ts', 'packages/ui/boton.ts', 'packages/ui/src/panel.ts'];
  for (const raiz of [
    { 'package.json': '{"workspaces":["packages/*"]}' },
    { 'package.json': '{"workspaces":{"packages":["packages/*"]}}' },
    { 'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - \"!**/test/**\"\n" },
  ]) {
    const r = mk({ ...raiz, ...comun }, ficheros);
    assert.deepStrictEqual(r('apps/w/a.ts', '@org/ui', 'js'), { destino: 'packages/ui/src/index.ts', clase: 'interno' });
    assert.strictEqual(r('apps/w/a.ts', '@org/ui/boton', 'js').destino, 'packages/ui/boton.ts');
    assert.strictEqual(r('apps/w/a.ts', '@org/ui/panel', 'js').destino, 'packages/ui/src/panel.ts');
  }
});

test('python: relativo con puntos y absoluto desde raiz o src/', () => {
  const r = mk({}, ['app/svc/x.py', 'app/db.py', 'app/pkg/__init__.py', 'src/lib/util.py']);
  assert.deepStrictEqual(r('app/svc/x.py', '..db', 'py'), { destino: 'app/db.py', clase: 'interno' });
  assert.strictEqual(r('app/svc/x.py', '..pkg', 'py').destino, 'app/pkg/__init__.py');
  assert.strictEqual(r('app/svc/x.py', 'app.db', 'py').destino, 'app/db.py');
  assert.strictEqual(r('app/svc/x.py', 'lib.util', 'py').destino, 'src/lib/util.py');
  assert.strictEqual(r('app/svc/x.py', 'os', 'py').clase, 'sistema');
  assert.strictEqual(r('app/svc/x.py', 'requests', 'py').clase, 'paquete');
  assert.strictEqual(r('app/svc/x.py', '.nada', 'py').clase, 'no-resuelto');
});

test('raiz: . y ./ desde un fichero de la raiz resuelven a index', () => {
  const r = mk({}, ['main.ts', 'index.ts']);
  assert.strictEqual(r('main.ts', '.', 'js').destino, 'index.ts');
  assert.strictEqual(r('main.ts', './', 'js').destino, 'index.ts');
  const r2 = mk({}, ['main.js', 'index.js', 'src/a.js', 'src/index.js']);
  assert.strictEqual(r2('main.js', '.', 'js').destino, 'index.js');
  assert.strictEqual(r2('src/a.js', './', 'js').destino, 'src/index.js');
});

test('.mts/.cts y preferencia de .ts sobre .js desde TS', () => {
  const r = mk({}, ['src/a.ts', 'src/b.mts', 'src/c.cts', 'src/x.js', 'src/x.ts', 'src/p.js']);
  assert.strictEqual(r('src/a.ts', './b.mjs', 'js').destino, 'src/b.mts');
  assert.strictEqual(r('src/a.ts', './c.cjs', 'js').destino, 'src/c.cts');
  assert.strictEqual(r('src/a.ts', './b', 'js').destino, 'src/b.mts');
  assert.strictEqual(r('src/a.ts', './x.js', 'js').destino, 'src/x.ts');
  assert.strictEqual(r('src/p.js', './x.js', 'js').destino, 'src/x.js');
});

test('monorepo: cada tsconfig usa sus propios paths', () => {
  const r = mk({
    'apps/web/tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}',
    'apps/api/tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["lib/*"]}}}',
  }, ['apps/web/src/a.ts', 'apps/web/src/u.ts', 'apps/api/src/b.ts', 'apps/api/lib/u.ts']);
  assert.strictEqual(r('apps/web/src/a.ts', '@/u', 'js').destino, 'apps/web/src/u.ts');
  assert.strictEqual(r('apps/api/src/b.ts', '@/u', 'js').destino, 'apps/api/lib/u.ts');
});
