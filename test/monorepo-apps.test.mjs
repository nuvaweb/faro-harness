// #129 — MODO MONOREPO: una gestion FARO unica en la raiz con varias apps en el workspace, y un
// motor que sabe QUE es cada app.
//
// Lo declarado (rol, funcional, equipo) vive en .faro.json > monorepo; lo tecnico (ruta, paquete,
// version, worker, front, contrato, changelog, tests) se DEDUCE del workspace. lib/apps.js es el
// modulo UNICO que el resto del motor consulta: gates, release, skills e issues por app se apoyan en
// el. Por eso estos tests fijan su API, no solo el comando.
//
// Y el reverso, igual de importante: un repo SIN la clave 'monorepo' se comporta exactamente como
// antes (modo 'generic', mismos textos, ningun aviso nuevo).
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(RAIZ, 'plugins', 'faro', 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');
const require = createRequire(import.meta.url);
const apps = require(path.join(HOOKS, 'lib', 'apps.js'));
const codeModule = require(path.join(HOOKS, 'lib', 'code.js'));
const { reconocer, retrato } = require(path.join(HOOKS, 'lib', 'reconocer.js'));

const escribir = (dir, rel, txt) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, txt);
};

const ESTADO = `---
iniciativa: T
fases_total: 1
fase_actual: 1
owner: t
funcional: documentos/funcional/f.md
---

### Fase 1 · Una — in_progress
Lo que trae esta fase.
Objetivo: 2026-12-01
- [ ] #1 · Algo — @t
`;

// Fixture: monorepo pnpm de 2 apps (worker API con contrato + front TanStack sobre Workers) y un
// paquete compartido. Gestion FARO unica en la raiz.
function monorepo({ faro } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-mono-'));
  escribir(dir, 'ESTADO.md', ESTADO);
  escribir(dir, 'documentos/funcional/f.md', '# F\n## Fuera de alcance\n- Nada mas\n');
  escribir(dir, 'package.json', JSON.stringify({ name: 'mono', private: true }));
  escribir(dir, 'pnpm-workspace.yaml', '# workspace\npackages:\n  - "apps/*"\n  - \'packages/*\'\n  - "!**/test/**"\n\nallowBuilds:\n  esbuild: true\n');
  // apps/api: Cloudflare Worker API con contrato, changelog, tests/ y CLAUDE.md propio
  escribir(dir, 'apps/api/package.json', JSON.stringify({ name: 'mono-api', version: '1.2.0', devDependencies: { wrangler: '^4.40.0' } }));
  escribir(dir, 'apps/api/wrangler.jsonc', '{\n  // worker\n  "name": "mono-api",\n  "main": "src/index.ts",\n}\n');
  escribir(dir, 'apps/api/ARCHITECTURE.md', '# Arquitectura\n');
  escribir(dir, 'apps/api/CHANGELOG.md', '# Changelog\n');
  escribir(dir, 'apps/api/CLAUDE.md', '# api\n');
  escribir(dir, 'apps/api/src/index.ts', 'export default {};\n');
  escribir(dir, 'apps/api/tests/api.test.ts', '\n');
  // apps/web: front TanStack Start sobre Workers, tests junto al codigo, SIN contrato y SIN CLAUDE.md
  escribir(dir, 'apps/web/package.json', JSON.stringify({ name: 'mono-web', version: '0.3.0', dependencies: { '@tanstack/react-start': '^1.0.0', react: '^19.0.0' }, devDependencies: { vite: '^7.0.0' } }));
  escribir(dir, 'apps/web/wrangler.jsonc', '{ "name": "mono-web" }\n');
  escribir(dir, 'apps/web/vite.config.ts', 'export default {};\n');
  escribir(dir, 'apps/web/CHANGELOG.md', '# Changelog\n');
  escribir(dir, 'apps/web/src/lib/util.test.ts', '\n');
  // packages/shared: codigo compartido, no es una app desplegable
  escribir(dir, 'packages/shared/package.json', JSON.stringify({ name: '@mono/shared', version: '0.0.1' }));
  if (faro !== undefined) escribir(dir, '.faro.json', JSON.stringify(faro, null, 2));
  return dir;
}

const DECLARADO = {
  teams: ['desarrollo'],
  monorepo: {
    apps: {
      api: { rol: 'API de metricas que sirve el panel', funcional: 'MONO-FUN-001', equipo: 'desarrollo' },
      web: { rol: 'Panel de operaciones', funcional: 'MONO-FUN-002', equipo: 'desarrollo' },
    },
    tag: '{app}@{version}',
  },
};

// Repo simple de siempre: un package.json, sin workspace ni clave 'monorepo'.
function simple() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-simple-'));
  escribir(dir, 'ESTADO.md', ESTADO);
  escribir(dir, 'documentos/funcional/f.md', '# F\n## Fuera de alcance\n- Nada mas\n');
  escribir(dir, 'package.json', JSON.stringify({ name: 'simple', version: '1.0.0' }));
  escribir(dir, '.faro.json', JSON.stringify({ teams: ['desarrollo'] }));
  return dir;
}

const harness = (dir, ...args) => {
  const r = spawnSync(process.execPath, [HARNESS, ...args], { cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  return { out: r.stdout + r.stderr, status: r.status, stdout: r.stdout };
};
const porId = (lista, id) => lista.find((a) => a.id === id);

// ---------- lectura del workspace ----------

test('parsePnpmWorkspace lee packages: con comillas o sin ellas, ignora negaciones y lo que viene despues', () => {
  assert.deepStrictEqual(apps.parsePnpmWorkspace('packages:\n  - "apps/*"\n  - packages/*\n  - \'!**/test/**\'\nallowBuilds:\n  x: true\n'), ['apps/*', 'packages/*']);
  assert.deepStrictEqual(apps.parsePnpmWorkspace("packages: ['apps/*', \"libs/*\"]\n"), ['apps/*', 'libs/*']);
  assert.deepStrictEqual(apps.parsePnpmWorkspace('# nada\n'), []);
});

test('workspace() sale de pnpm-workspace.yaml, o de los workspaces de package.json', () => {
  const dir = monorepo();
  assert.deepStrictEqual(apps.workspace(dir), { fuente: 'pnpm-workspace.yaml', globs: ['apps/*', 'packages/*'] });
  const npm = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-npmws-'));
  escribir(npm, 'package.json', JSON.stringify({ name: 'x', workspaces: { packages: ['apps/*'] } }));
  assert.deepStrictEqual(apps.workspace(npm), { fuente: 'package.json', globs: ['apps/*'] });
  assert.deepStrictEqual(apps.workspace(simple()), { fuente: null, globs: [] });
});

// ---------- la API que consumen gates/release/skills/issues ----------

test('esMonorepo: lo ACTIVA la clave monorepo de .faro.json, no la mera existencia de un workspace', () => {
  assert.strictEqual(apps.esMonorepo(monorepo()), false);
  assert.strictEqual(apps.esMonorepo(monorepo({ faro: DECLARADO })), true);
  assert.strictEqual(apps.esMonorepo(simple()), false);
});

test('apps(): declaradas ∪ descubiertas, con origen, rol y los rasgos DEDUCIDOS de cada carpeta', () => {
  const dir = monorepo({ faro: DECLARADO });
  const l = apps.apps(dir);
  const api = porId(l, 'api');
  assert.strictEqual(api.ruta, 'apps/api');
  assert.strictEqual(api.tipo, 'app');
  assert.strictEqual(api.origen, 'ambas');
  assert.strictEqual(api.existe, true);
  assert.strictEqual(api.rol, 'API de metricas que sirve el panel');
  assert.strictEqual(api.funcional, 'MONO-FUN-001');
  assert.strictEqual(api.equipo, 'desarrollo');
  assert.strictEqual(api.paquete, 'mono-api');
  assert.strictEqual(api.version, '1.2.0');
  assert.deepStrictEqual(api.worker, { fichero: 'apps/api/wrangler.jsonc', nombre: 'mono-api' });
  assert.strictEqual(api.front, null);
  assert.strictEqual(api.contrato, 'apps/api/ARCHITECTURE.md');
  assert.strictEqual(api.changelog, 'apps/api/CHANGELOG.md');
  assert.strictEqual(api.claudeMd, true);
  assert.deepStrictEqual(api.tests, { carpeta: 'apps/api/tests', colocados: false });
  assert.strictEqual(api.tag, 'api@1.2.0');

  const web = porId(l, 'web');
  assert.strictEqual(web.front, 'tanstack');
  assert.strictEqual(web.worker.nombre, 'mono-web');
  assert.strictEqual(web.contrato, null);
  assert.strictEqual(web.claudeMd, false);
  assert.deepStrictEqual(web.tests, { carpeta: null, colocados: true });

  const shared = porId(l, 'shared');
  assert.strictEqual(shared.tipo, 'paquete');
  assert.strictEqual(shared.origen, 'descubierta');
  assert.strictEqual(shared.rol, null);
});

test('una app declarada que no existe aparece con existe:false y origen declarada', () => {
  const faro = JSON.parse(JSON.stringify(DECLARADO));
  faro.monorepo.apps.fantasma = { rol: 'No existe' };
  const f = porId(apps.apps(monorepo({ faro })), 'fantasma');
  assert.strictEqual(f.existe, false);
  assert.strictEqual(f.origen, 'declarada');
  assert.strictEqual(f.ruta, null);
});

test('appDeRuta: la app duena de un fichero (relativo, absoluto o con barras de Windows); null fuera', () => {
  const dir = monorepo({ faro: DECLARADO });
  assert.strictEqual(apps.appDeRuta(dir, 'apps/api/src/index.ts').id, 'api');
  assert.strictEqual(apps.appDeRuta(dir, path.join(dir, 'apps', 'web', 'vite.config.ts')).id, 'web');
  assert.strictEqual(apps.appDeRuta(dir, 'apps\\api\\tests\\api.test.ts').id, 'api');
  assert.strictEqual(apps.appDeRuta(dir, 'apps/api').id, 'api', 'la propia carpeta de la app tambien es suya');
  assert.strictEqual(apps.appDeRuta(dir, 'apps/apix/a.ts'), null, 'el prefijo debe ser una carpeta, no un trozo de nombre');
  assert.strictEqual(apps.appDeRuta(dir, 'ESTADO.md'), null);
});

test('appsAfectadas: las apps tocadas por un diff, sin repetir, y lo que cae fuera de toda app', () => {
  const dir = monorepo({ faro: DECLARADO });
  const r = apps.appsAfectadas(dir, ['apps/web/src/a.ts', 'apps/web/b.ts', 'ESTADO.md', 'apps/api/CHANGELOG.md']);
  assert.deepStrictEqual(r.apps.map((a) => a.id).sort(), ['api', 'web']);
  assert.deepStrictEqual(r.fueraDeApps, ['ESTADO.md']);
  assert.deepStrictEqual(apps.appsAfectadas(dir, []), { apps: [], fueraDeApps: [] });
});

test('tagDe aplica la plantilla del tag (por defecto {app}@{version})', () => {
  const dir = monorepo({ faro: { monorepo: { apps: { api: { rol: 'x' } }, tag: 'v{version}-{app}' } } });
  assert.strictEqual(apps.tagDe(dir, 'api', '2.0.0'), 'v2.0.0-api');
  const def = monorepo({ faro: { monorepo: { apps: { api: { rol: 'x' } } } } });
  assert.strictEqual(apps.tagDe(def, 'api', '2.0.0'), 'api@2.0.0');
});

// ---------- comando harness.js apps ----------

test('harness.js apps lista cada app con su rol y sus rasgos', () => {
  const { out, status } = harness(monorepo({ faro: DECLARADO }), 'apps');
  assert.strictEqual(status, 0, out);
  assert.match(out, /api \(apps\/api\).*API de metricas que sirve el panel/, out);
  assert.match(out, /api[^\n]*worker[^\n]*contrato/, out);
  assert.match(out, /web \(apps\/web\).*Panel de operaciones[^\n]*worker[^\n]*front tanstack/, out);
});

test('harness.js apps --json devuelve la misma lista que apps()', () => {
  const dir = monorepo({ faro: DECLARADO });
  const { stdout, status } = harness(dir, 'apps', '--json');
  assert.strictEqual(status, 0, stdout);
  const j = JSON.parse(stdout);
  assert.strictEqual(j.monorepo, true);
  assert.deepStrictEqual(j.workspace.globs, ['apps/*', 'packages/*']);
  assert.deepStrictEqual(j.apps.map((a) => a.id), apps.apps(dir).map((a) => a.id));
});

test('harness.js apps sin monorepo declarado lista lo descubierto y pide declararlo', () => {
  const { out } = harness(monorepo(), 'apps');
  assert.match(out, /api \(apps\/api\)/, out);
  assert.match(out, /sin declarar/i, out);
});

// ---------- validate ----------

test('validate avisa (sin bloquear) de app sin declarar, app inexistente y app sin CLAUDE.md', () => {
  const faro = JSON.parse(JSON.stringify(DECLARADO));
  faro.monorepo.apps.fantasma = { rol: 'No existe' };
  const dir = monorepo({ faro });
  escribir(dir, 'apps/nueva/package.json', JSON.stringify({ name: 'nueva', version: '0.1.0' }));
  escribir(dir, 'apps/nueva/CLAUDE.md', '# nueva\n');
  const { out } = harness(dir, 'validate');
  assert.match(out, /\[monorepo\][^\n]*apps\/nueva[^\n]*sin declarar/i, out);
  assert.match(out, /\[monorepo\][^\n]*fantasma[^\n]*no existe/i, out);
  assert.match(out, /\[monorepo\][^\n]*apps\/web[^\n]*CLAUDE\.md/, out);
  assert.doesNotMatch(out, /\[monorepo\][^\n]*apps\/api[^\n]*CLAUDE\.md/, out);
  assert.doesNotMatch(out, /\[monorepo\][^\n]*packages\/shared/, out, 'un paquete compartido no es una app que declarar');
  // Son avisos: no aparecen en la lista de errores.
  const errores = out.split(/Avisos \(NO bloquean CI\)/)[0];
  assert.doesNotMatch(errores, /\[monorepo\]/, out);
});

test('validate contrasta la declaracion con el contrato de faro-schema.json', () => {
  const dir = monorepo({ faro: { teams: ['desarrollo'], monorepo: { apps: { api: { rol: 'x', equipo: 'marketing', color: 'rojo' }, web: {} }, tag: '{app}' } } });
  const { out } = harness(dir, 'validate');
  assert.match(out, /\[monorepo\][^\n]*tag[^\n]*\{version\}/, out);
  assert.match(out, /\[monorepo\][^\n]*web[^\n]*rol/, out);
  assert.match(out, /\[monorepo\][^\n]*color/, out);
  assert.match(out, /\[monorepo\][^\n]*marketing/, out);
});

test('validate en un workspace SIN la clave monorepo sugiere declararlo (una sola linea)', () => {
  const { out } = harness(monorepo(), 'validate');
  const lineas = out.split('\n').filter((l) => l.includes('[monorepo]'));
  assert.strictEqual(lineas.length, 1, out);
  assert.match(lineas[0], /\.faro\.json/);
});

// ---------- code.js: modo y textos ----------

test("code.js: mode() es 'monorepo' con la clave, y los textos no mandan a separar back y front en repos", () => {
  const dir = monorepo({ faro: DECLARADO });
  const c = codeModule(dir);
  assert.strictEqual(c.mode(), 'monorepo');
  assert.strictEqual(c.hasCode(), true);
  const routing = c.skillRoutingLines().join('\n');
  assert.ok(routing.length > 0, 'en monorepo tambien hay routing');
  assert.doesNotMatch(routing, /repos separados|microservicio/i, routing);
  assert.match(routing, /harness\.js apps/);
  assert.match(c.infraLines().join('\n'), /monorepo/i);
  assert.strictEqual(c.ciPlan().mode, 'monorepo');
  const { out } = harness(dir, 'infra');
  assert.doesNotMatch(out, /repos propios|microservicio/i, out);
});

// ---------- no regresion: repo simple ----------

test('NO REGRESION: un repo simple sigue en generic, con sus textos y sin avisos de monorepo', () => {
  const dir = simple();
  const c = codeModule(dir);
  assert.strictEqual(c.mode(), 'generic');
  assert.match(c.skillRoutingLines().join('\n'), /back y front en repos separados \(microservicio\)/);
  assert.strictEqual(c.ciPlan().mode, 'generic');
  assert.deepStrictEqual(apps.apps(dir), []);
  assert.strictEqual(apps.appDeRuta(dir, 'src/a.js'), null);
  assert.deepStrictEqual(apps.appsAfectadas(dir, ['src/a.js']), { apps: [], fueraDeApps: ['src/a.js'] });
  const { out } = harness(dir, 'validate');
  assert.doesNotMatch(out, /\[monorepo\]/, out);
  const ap = harness(dir, 'apps');
  assert.strictEqual(ap.status, 0, ap.out);
  assert.match(ap.out, /no es un monorepo/i, ap.out);
});

// ---------- reconocer ----------

test('reconocer ve el monorepo y el stack de cada app', () => {
  const rutas = ['package.json', 'pnpm-workspace.yaml', 'README.md',
    'apps/api/package.json', 'apps/api/wrangler.jsonc', 'apps/api/src/index.ts',
    'apps/web/package.json', 'apps/web/wrangler.jsonc', 'apps/web/vite.config.ts', 'apps/web/src/main.tsx'];
  const r = reconocer(rutas, { workspaces: ['apps/*', 'packages/*'] });
  assert.ok(r.monorepo, JSON.stringify(r));
  assert.deepStrictEqual(r.monorepo.apps.map((a) => a.ruta), ['apps/api', 'apps/web']);
  assert.strictEqual(r.monorepo.apps[0].stacks[0], 'Cloudflare Workers');
  assert.ok(r.monorepo.apps[1].stacks.includes('Vite'), JSON.stringify(r.monorepo.apps[1]));
  const t = retrato(r);
  assert.match(t, /monorepo/i);
  assert.match(t, /apps\/api \(Cloudflare Workers/);
  // Sin globs explicitos, el pnpm-workspace.yaml de la raiz basta para reconocerlo
  assert.ok(reconocer(rutas).monorepo);
});

test('reconocer: un repo simple no se convierte en monorepo', () => {
  const r = reconocer(['wrangler.toml', 'package.json', 'src/index.js']);
  assert.strictEqual(r.monorepo, null);
  assert.doesNotMatch(retrato(r), /monorepo/i);
});
