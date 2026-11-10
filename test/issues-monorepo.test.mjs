// #134 — ISSUES Y TAREAS PARA MONOREPO Y AGENTES.
//
// La jerarquia no cambia (fase = hito · issue = entregable, su rama y su PR · subtareas = lineas del
// tasks.md o checkboxes del cuerpo). Lo que se anade es lo que necesita un monorepo trabajado por
// agentes:
//   - asignar-tarea --app <app>: etiqueta 'app:<app>' (creada si falta, color fijo), validando que la
//     app existe; sin --app en un monorepo, aviso que la propone;
//   - harness.js codeowners: .github/CODEOWNERS por app (equipo = team de la org) y .github/labeler.yml
//     (actions/labeler v5), en un bloque marcado, idempotente y sin pisar lo manual;
//   - harness.js ficha <N>: ficha autocontenida (< 2.000 tokens) para el subagente implementador;
//   - tasks.md con [P], [US-n], test que debe fallar antes y checkpoint, sin romper el conteo;
//   - en el motor, asignar-tarea ancla al hito de la version en curso.
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
const af = require(path.join(HOOKS, 'lib', 'apps-forja.js'));
const fi = require(path.join(HOOKS, 'lib', 'ficha.js'));
const hv = require(path.join(HOOKS, 'lib', 'hito-version.js'));

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${n}-`));
const escribir = (dir, rel, txt) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };

// Monorepo pnpm: apps/api (worker con contrato y CLAUDE.md), apps/web (front) y packages/shared.
const DECLARADO = { monorepo: { apps: { api: { rol: 'API de metricas', funcional: 'M-FUN-001', equipo: 'backend' }, web: { rol: 'Panel', funcional: 'M-FUN-002', equipo: 'frontend' } } } };
function monorepo({ faro = DECLARADO } = {}) {
  const dir = tmp('mono');
  escribir(dir, 'package.json', JSON.stringify({ name: 'mono', private: true }));
  escribir(dir, 'pnpm-workspace.yaml', 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  escribir(dir, 'apps/api/package.json', JSON.stringify({ name: 'mono-api', version: '1.2.0' }));
  escribir(dir, 'apps/api/wrangler.jsonc', '{ "name": "mono-api", "main": "src/index.ts" }\n');
  escribir(dir, 'apps/api/ARCHITECTURE.md', '# Arquitectura\n');
  escribir(dir, 'apps/api/CLAUDE.md', '# api\n');
  escribir(dir, 'apps/api/tests/api.test.ts', '\n');
  escribir(dir, 'apps/web/package.json', JSON.stringify({ name: 'mono-web', version: '0.3.0', dependencies: { '@tanstack/react-start': '^1.0.0' } }));
  escribir(dir, 'packages/shared/package.json', JSON.stringify({ name: '@mono/shared', version: '0.0.1' }));
  if (faro) escribir(dir, '.faro.json', JSON.stringify(faro, null, 2));
  return dir;
}

// ---------- API falsa (mismo patron que asignar-tarea-cableado) ----------
function apiFalsa(rutas) {
  const llamadas = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url).replace('https://api.github.com/', ''); const metodo = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : null;
    llamadas.push({ metodo, ruta: u, body });
    for (const [re, fn] of rutas) { const m = u.match(re); if (m && (!fn.metodo || fn.metodo === metodo)) { const r = fn.resp(m, body); return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body), json: async () => r.body }; } }
    return { ok: false, status: 404, text: async () => '{}', json: async () => ({ message: 'Not Found' }) };
  };
  return llamadas;
}
const R = (re, resp, metodo) => [re, { resp, metodo }];
const EQUIPO = R(/^repos\/org\/repo\/collaborators/, () => ({ status: 200, body: [{ login: 'fer' }] }));
const CREA_ISSUE = R(/^repos\/org\/repo\/issues$/, (_m, b) => ({ status: 201, body: { number: 9, html_url: 'https://github.com/org/repo/issues/9', ...b } }), 'POST');

async function adaptador(root) {
  const mod = await import(`file://${path.join(HOOKS, 'lib', 'github.js').replace(/\\/g, '/')}?r=${Math.random()}`);
  const home = tmp('home'); const cfg = path.join(home, '.faro.json');
  fs.writeFileSync(cfg, JSON.stringify({ tokens: { 'github.com': { token: 'tok', forja: 'github', user: { login: 'fer' } } } }));
  process.env.FARO_CONFIG_PATH = cfg; process.env.FARO_GITHUB_TOKEN = ''; process.env.GITHUB_TOKEN = '';
  return mod.default({
    ROOT: root, IS_TEMPLATE: false, specBase: 'gestion/cambios',
    git: (...a) => (a[0] === 'remote' ? 'git@github.com:org/repo.git' : ''),
    forge: () => ({ forge: 'github', host: 'github.com', owner: 'org', project: 'repo', path: 'org/repo' }),
    fases: () => [], isDone: (e) => e === 'done', isActive: (e) => e === 'in_progress',
  });
}
async function correr(fn, argv) {
  const out = []; const log = console.log; const wr = process.stdout.write.bind(process.stdout);
  const exit = process.exit; let codigo = null;
  console.log = (...a) => out.push(a.join(' '));
  process.stdout.write = (s) => { out.push(String(s).replace(/\n$/, '')); return true; };
  process.exit = (c) => { codigo = c; throw new Error('__exit__'); };
  process.argv = ['node', 'harness.js', ...argv];
  try { await fn(); } catch (e) { if (e.message !== '__exit__') throw e; } finally { console.log = log; process.stdout.write = wr; process.exit = exit; }
  return { out: out.join('\n'), codigo };
}

// ---------- asignar-tarea --app ----------

test('asignar-tarea --app api: crea la etiqueta app:api (color fijo) y el issue la lleva', async () => {
  const dir = monorepo();
  const llamadas = apiFalsa([EQUIPO, CREA_ISSUE,
    R(/^repos\/org\/repo\/labels\/app%3Aapi$/, () => ({ status: 404, body: { message: 'Not Found' } })),
    R(/^repos\/org\/repo\/labels$/, (_m, b) => ({ status: 201, body: b }), 'POST'),
  ]);
  const a = await adaptador(dir);
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Falla el login', 'fer', '', '', '--tipo', 'bug', '--app', 'api']);
  assert.match(r.out, /✅ Tarea #9 asignada a fer · tipo: bug · app:api/, r.out);
  const crea = llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/labels');
  assert.ok(crea, 'debe crear la etiqueta que faltaba');
  assert.strictEqual(crea.body.name, 'app:api');
  assert.strictEqual(crea.body.color, af.COLOR_APP);
  const post = llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues');
  assert.deepStrictEqual(post.body.labels, ['bug', 'app:api']);
});

test('asignar-tarea --app con la etiqueta ya creada: la reutiliza sin crearla otra vez', async () => {
  const dir = monorepo();
  const llamadas = apiFalsa([EQUIPO, CREA_ISSUE, R(/^repos\/org\/repo\/labels\/app%3Aweb$/, () => ({ status: 200, body: { name: 'app:web' } }))]);
  const a = await adaptador(dir);
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Panel de uso', 'fer', '', '', '--tipo', 'bug', '--app=web']);
  assert.match(r.out, /app:web/, r.out);
  assert.ok(!llamadas.some((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/labels'));
  assert.deepStrictEqual(llamadas.find((c) => c.ruta === 'repos/org/repo/issues').body.labels, ['bug', 'app:web']);
});

test('asignar-tarea --app con una app que no existe: lo dice con las validas y NO crea nada', async () => {
  const dir = monorepo();
  const llamadas = apiFalsa([EQUIPO, CREA_ISSUE]);
  const a = await adaptador(dir);
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Algo', 'fer', '', '', '--tipo', 'bug', '--app', 'gold-api']);
  assert.strictEqual(r.codigo, 1);
  assert.match(r.out, /La app 'gold-api' no existe/, r.out);
  assert.match(r.out, /api · web/);
  assert.ok(!llamadas.some((c) => c.metodo === 'POST'), 'no debe crear ni etiqueta ni issue');
});

// #211: una tarea puede abarcar varias apps: --app api,web (o --app repetido) pone una etiqueta por app.
test('#211: asignar-tarea --app api,web pone app:api y app:web (y --app repetido, igual)', async () => {
  for (const args of [['--app', 'api,web'], ['--app', 'api', '--app=web'], ['--app', 'api, web,api']]) {
    const dir = monorepo();
    const llamadas = apiFalsa([EQUIPO, CREA_ISSUE, R(/^repos\/org\/repo\/labels\/app%3A(api|web)$/, (m) => ({ status: 200, body: { name: 'app:' + m[1] } }))]);
    const a = await adaptador(dir);
    const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Exportar a PDF', 'fer', '', '', '--tipo', 'bug', ...args]);
    assert.match(r.out, /✅ Tarea #9 asignada a fer · tipo: bug · app:api, app:web/, r.out);
    assert.deepStrictEqual(llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues').body.labels, ['bug', 'app:api', 'app:web'], args.join(' '));
  }
});

test('#211: si UNA de las apps no existe, no se crea nada y se listan las validas', async () => {
  const dir = monorepo();
  const llamadas = apiFalsa([EQUIPO, CREA_ISSUE]);
  const a = await adaptador(dir);
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Algo', 'fer', '', '', '--tipo', 'bug', '--app', 'api,gold-api']);
  assert.strictEqual(r.codigo, 1);
  assert.match(r.out, /La app 'gold-api' no existe/, r.out);
  assert.ok(!llamadas.some((c) => c.metodo === 'POST'), 'no debe crear ni etiqueta ni issue');
});

test('asignar-tarea --app en un repo que no es monorepo: lo rechaza', async () => {
  const dir = tmp('simple');
  apiFalsa([EQUIPO, CREA_ISSUE]);
  const a = await adaptador(dir);
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Algo', 'fer', '', '', '--tipo', 'bug', '--app', 'api']);
  assert.strictEqual(r.codigo, 1);
  assert.match(r.out, /--app solo aplica en un monorepo/, r.out);
});

test('monorepo sin --app: avisa proponiendo la app, pero el issue se crea igual', async () => {
  const dir = monorepo();
  const llamadas = apiFalsa([EQUIPO, CREA_ISSUE]);
  const a = await adaptador(dir);
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Falla algo', 'fer', '', '', '--tipo', 'bug']);
  assert.match(r.out, /Monorepo: este issue no lleva --app/, r.out);
  assert.match(r.out, /Apps: api · web/);
  assert.match(r.out, /✅ Tarea #9/);
  assert.deepStrictEqual(llamadas.find((c) => c.ruta === 'repos/org/repo/issues').body.labels, ['bug']);
});

test('avisoSinApp propone LA app cuando lo cambiado toca solo una; nada fuera de un monorepo', () => {
  const dir = monorepo();
  assert.match(af.avisoSinApp(dir, ['apps/web/src/a.ts', 'ESTADO.md']), /Propuesta: --app web/);
  assert.match(af.avisoSinApp(dir, ['apps/web/a.ts', 'apps/api/b.ts']), /Apps: api · web/);
  assert.strictEqual(af.avisoSinApp(tmp('simple'), ['x']), null);
});

// ---------- plantilla de bug ----------

test('asignar-tarea --tipo bug: el cuerpo nace con actual / esperado / lo que NO debe cambiar / pasos', async () => {
  const dir = tmp('simple');
  const llamadas = apiFalsa([EQUIPO, CREA_ISSUE]);
  const a = await adaptador(dir);
  await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Falla el login', 'fer', '', '', '--tipo', 'bug']);
  const body = llamadas.find((c) => c.ruta === 'repos/org/repo/issues').body.body;
  const orden = ['Comportamiento actual', 'Comportamiento esperado', 'Lo que NO debe cambiar', 'Pasos para reproducir'].map((s) => body.search(new RegExp(`^## ${s}$`, 'm')));
  assert.ok(orden.every((i) => i >= 0), `faltan secciones: ${body}`);
  assert.deepStrictEqual([...orden].sort((x, y) => x - y), orden, 'en ese orden');
});

// ---------- motor: hito por version ----------

test('elegirHitoVersion: prefiere el abierto mas proximo a la version en curso e ignora los olvidados', () => {
  const H = (number, title, state = 'open') => ({ number, title, state });
  // El caso real del motor: plugin 0.59.1 con '0.56' (olvidado) y '1.0' abiertos -> '1.0'.
  let e = hv.elegirHitoVersion('0.59.1', [H(1, 'Backlog'), H(2, '0.54', 'closed'), H(6, '0.56'), H(7, '1.0')]);
  assert.deepStrictEqual([e.titulo, e.numero, e.crear], ['1.0', 7, false]);
  assert.deepStrictEqual(e.olvidados, ['0.56']);
  // Con el hito de la version en curso abierto, ese.
  e = hv.elegirHitoVersion('0.59.1', [H(6, '0.56'), H(7, '1.0'), H(8, '0.59')]);
  assert.deepStrictEqual([e.titulo, e.numero], ['0.59', 8]);
  assert.match(e.motivo, /version en curso/);
  // Sin ninguno abierto igual o posterior, se crea X.Y.
  e = hv.elegirHitoVersion('0.59.1', [H(6, '0.56'), H(9, '0.59', 'closed')]);
  assert.deepStrictEqual([e.titulo, e.numero, e.crear], ['0.59', null, true]);
  assert.strictEqual(hv.elegirHitoVersion('sin-version', []), null);
});

function motor(version = '0.59.1') {
  const dir = tmp('motor');
  escribir(dir, '.claude-plugin/marketplace.json', '{}');
  escribir(dir, 'plugins/faro/.claude-plugin/plugin.json', JSON.stringify({ name: 'faro', version }));
  return dir;
}

test('en el MOTOR asignar-tarea ancla el issue al hito de la version en curso sin pedir --fase', async () => {
  const dir = motor();
  const llamadas = apiFalsa([EQUIPO, CREA_ISSUE,
    R(/^repos\/org\/repo\/milestones\?/, () => ({ status: 200, body: [{ number: 6, title: '0.56', state: 'open' }, { number: 7, title: '1.0', state: 'open' }] })),
  ]);
  const a = await adaptador(dir);
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Issues para monorepo', 'fer', '', '', '--tipo', 'mejora']);
  assert.match(r.out, /Motor: hito '1\.0'/, r.out);
  assert.match(r.out, /olvidados\?\): 0\.56/);
  assert.strictEqual(llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues').body.milestone, 7);
});

test('en el MOTOR sin hito abierto de la version, crea X.Y; con --fase X.Y usa ese', async () => {
  const dir = motor();
  let llamadas = apiFalsa([EQUIPO, CREA_ISSUE,
    R(/^repos\/org\/repo\/milestones\?/, () => ({ status: 200, body: [] })),
    R(/^repos\/org\/repo\/milestones$/, (_m, b) => ({ status: 201, body: { number: 12, title: b.title, state: 'open' } }), 'POST'),
  ]);
  let a = await adaptador(dir);
  let r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Algo del motor', 'fer', '', '', '--tipo', 'bug']);
  assert.strictEqual(llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/milestones').body.title, '0.59', r.out);
  assert.strictEqual(llamadas.find((c) => c.ruta === 'repos/org/repo/issues').body.milestone, 12);

  llamadas = apiFalsa([EQUIPO, CREA_ISSUE,
    R(/^repos\/org\/repo\/milestones\?/, () => ({ status: 200, body: [{ number: 7, title: '1.0', state: 'open' }, { number: 8, title: '0.59', state: 'open' }] })),
  ]);
  a = await adaptador(dir);
  r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Algo para la 1.0', 'fer', '', '', '--tipo', 'mejora', '--fase', '1.0']);
  assert.match(r.out, /hito '1\.0' \(indicado con --hito\)/, r.out);
  assert.strictEqual(llamadas.find((c) => c.ruta === 'repos/org/repo/issues').body.milestone, 7);
});

test('fuera del motor, sin ESTADO.md, nada cambia: el issue se crea sin hito', async () => {
  const dir = tmp('simple');
  const llamadas = apiFalsa([EQUIPO, CREA_ISSUE]);
  const a = await adaptador(dir);
  await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Algo', 'fer', '', '', '--tipo', 'mejora']);
  assert.ok(!llamadas.some((c) => c.ruta.startsWith('repos/org/repo/milestones')));
  assert.strictEqual(llamadas.find((c) => c.ruta === 'repos/org/repo/issues').body.milestone, undefined);
});

// ---------- CODEOWNERS y labeler ----------

const harness = (dir, args, env = {}) => {
  const r = spawnSync(process.execPath, [HARNESS, ...args], { cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...env } });
  return { out: r.stdout + r.stderr, status: r.status };
};
const conGit = (dir) => {
  spawnSync('git', ['init', '-q', '-b', 'develop'], { cwd: dir });
  spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/mono.git'], { cwd: dir });
  return dir;
};

test('codeowners genera CODEOWNERS por app (@org/team) y labeler.yml v5, idempotente', () => {
  const dir = conGit(monorepo());
  const r = harness(dir, ['codeowners']);
  assert.strictEqual(r.status, 0, r.out);
  const co = fs.readFileSync(path.join(dir, '.github/CODEOWNERS'), 'utf8');
  assert.match(co, /^\/apps\/api\/ @acme\/backend$/m);
  assert.match(co, /^\/apps\/web\/ @acme\/frontend$/m);
  assert.doesNotMatch(co, /shared/, 'un paquete compartido no es una app');
  const lb = fs.readFileSync(path.join(dir, '.github/labeler.yml'), 'utf8');
  assert.match(lb, /^'app:api':\n {2}- changed-files:\n {6}- any-glob-to-any-file: 'apps\/api\/\*\*'$/m);
  assert.match(lb, /'app:web':/);
  // Segunda vez: nada que cambiar, y --comprobar lo confirma.
  const r2 = harness(dir, ['codeowners']);
  assert.match(r2.out, /Sin cambios/, r2.out);
  assert.strictEqual(fs.readFileSync(path.join(dir, '.github/CODEOWNERS'), 'utf8'), co);
  assert.strictEqual(harness(dir, ['codeowners', '--comprobar']).status, 0);
});

test('codeowners respeta lo manual (fuera del bloque) y --comprobar falla si esta desactualizado', () => {
  const dir = conGit(monorepo());
  escribir(dir, '.github/CODEOWNERS', '# del equipo\n/docs/ @acme/docs\n');
  escribir(dir, '.github/labeler.yml', "'app:web':\n  - changed-files:\n      - any-glob-to-any-file: 'apps/web/src/**'\ndocs:\n  - changed-files:\n      - any-glob-to-any-file: 'docs/**'\n");
  assert.strictEqual(harness(dir, ['codeowners', '--comprobar']).status, 1, 'sin bloque, esta desactualizado');
  const r = harness(dir, ['codeowners']);
  assert.match(r.out, /'app:web' ya esta en \.github\/labeler\.yml fuera del bloque/, r.out);
  const co = fs.readFileSync(path.join(dir, '.github/CODEOWNERS'), 'utf8');
  assert.match(co, /\/docs\/ @acme\/docs/);
  assert.ok(co.indexOf(af.INICIO) < co.indexOf('/docs/'), 'el bloque va ARRIBA: en CODEOWNERS gana la ultima regla, lo manual sigue mandando');
  const lb = fs.readFileSync(path.join(dir, '.github/labeler.yml'), 'utf8');
  assert.strictEqual((lb.match(/'app:web':/g) || []).length, 1, 'no duplica la clave manual');
  assert.match(lb, /apps\/web\/src\/\*\*/);
  assert.match(lb, /'app:api':/);
  // Cambia el equipo de una app: se regenera solo el bloque.
  const faro = JSON.parse(fs.readFileSync(path.join(dir, '.faro.json'), 'utf8'));
  faro.monorepo.apps.api.equipo = 'plataforma';
  fs.writeFileSync(path.join(dir, '.faro.json'), JSON.stringify(faro));
  assert.strictEqual(harness(dir, ['codeowners', '--comprobar']).status, 1);
  harness(dir, ['codeowners']);
  const co2 = fs.readFileSync(path.join(dir, '.github/CODEOWNERS'), 'utf8');
  assert.match(co2, /^\/apps\/api\/ @acme\/plataforma$/m);
  assert.doesNotMatch(co2, /@acme\/backend/);
  assert.match(co2, /\/docs\/ @acme\/docs/);
});

test('codeowners avisa de la app sin equipo y no hace nada fuera de un monorepo', () => {
  const sinEquipo = { monorepo: { apps: { api: { rol: 'API' }, web: { rol: 'Panel', equipo: 'frontend' } } } };
  const g = af.generar(monorepo({ faro: sinEquipo }), { org: 'acme' });
  assert.ok(g.avisos.some((x) => /'api' no declara 'equipo'/.test(x)), g.avisos.join(' | '));
  assert.doesNotMatch(g.ficheros[0].texto, /apps\/api/);
  const r = harness(conGit(tmp('simple')), ['codeowners']);
  assert.match(r.out, /no es un monorepo/, r.out);
});

// ---------- ficha por issue ----------

function cambioLigado(dir) {
  escribir(dir, 'gestion/cambios/changes/login-api/proposal.md', '---\ntitulo: Login de la API\nestado: aprobada\nissue: 9\n---\n\n## Por qué\n\nEl login falla con tokens caducados y el panel se queda en blanco.\n\n## Qué cambia\n\n- Renovar el token antes de que caduque\n- Mensaje claro si no se puede\n');
  escribir(dir, 'gestion/cambios/changes/login-api/specs/auth/spec.md', '# Auth\n\n## Requisitos AÑADIDOS\n\n### Requisito: Renovacion del token\nCUANDO el token caduca, la API DEBE renovarlo.\n\n#### Escenario: x\n- CUANDO a\n- ENTONCES b\n');
  escribir(dir, 'gestion/cambios/changes/login-api/tasks.md', '# Tareas\n\n## US-1 · Login (#9)\n- [x] T001 [US-1] Test que debe FALLAR antes\n- [ ] T002 [US-1] Implementar\n- [ ] T003 [US-1] Checkpoint US-1\n');
}

test('ficha: issue + app y sus rasgos + cambio vinculado + rutas, dentro del presupuesto', () => {
  const dir = monorepo();
  cambioLigado(dir);
  const lista = require(path.join(HOOKS, 'lib', 'apps.js')).apps(dir);
  const issue = fi.normalizarIssue({ number: 9, title: 'Login de la API', state: 'open', html_url: 'https://github.com/acme/mono/issues/9', labels: [{ name: 'bug' }, { name: 'app:api' }], milestone: { title: 'Fase 2' }, assignees: [{ login: 'fer' }], body: '## Objetivo\n\nQue el login no falle.\n\n' + 'Detalle largo del contexto. '.repeat(1200) });
  const slug = fi.buscarCambio(dir, 'gestion/cambios', 9, issue.cuerpo);
  assert.strictEqual(slug, 'login-api');
  const txt = fi.componerFicha({ issue, apps: lista.filter((a) => a.id === 'api'), cambio: fi.resumenCambio(dir, 'gestion/cambios', slug), monorepo: true });
  assert.ok(fi.estimarTokens(txt) <= 2000, `la ficha debe caber en 2.000 tokens: ${fi.estimarTokens(txt)}`);
  assert.match(txt, /# Ficha del issue #9 — Login de la API/);
  assert.match(txt, /## App: api \(apps\/api\)/);
  assert.match(txt, /Lee primero: apps\/api\/CLAUDE\.md · apps\/api\/ARCHITECTURE\.md/);
  assert.match(txt, /Tests: apps\/api\/tests/);
  assert.match(txt, /## Cambio spec-driven: login-api \(aprobada\)/);
  assert.match(txt, /\[AÑADIDOS\] Renovacion del token/);
  assert.match(txt, /tasks\.md: 1\/3 hechas/);
  assert.match(txt, /- apps\/api\/\n- gestion\/cambios\/changes\/login-api\//);
  assert.match(txt, /recortado para la ficha: el issue completo en https:\/\/github\.com\/acme\/mono\/issues\/9/);
  assert.match(txt, /Closes #9/);
});

test('harness.js ficha <N> lee el issue de la forja y compone la ficha (API simulada)', () => {
  const dir = conGit(monorepo());
  cambioLigado(dir);
  const mock = path.join(tmp('mock'), 'fetch.cjs');
  fs.writeFileSync(mock, `globalThis.fetch = async (url) => {
    const u = String(url);
    if (/repos\\/acme\\/mono\\/issues\\/9$/.test(u)) return { ok: true, status: 200, json: async () => (${JSON.stringify({ number: 9, title: 'Login de la API', state: 'open', html_url: 'https://github.com/acme/mono/issues/9', labels: [{ name: 'app:api' }, { name: 'app:fantasma' }], body: '## Objetivo\n\nQue el login no falle.' })}) };
    return { ok: false, status: 404, json: async () => ({}) };
  };\n`);
  const r = harness(dir, ['ficha', '9', '--json'], { NODE_OPTIONS: `--require "${mock.replace(/\\/g, '/')}"`, FARO_GITHUB_TOKEN: 'tok', FARO_CONFIG_PATH: path.join(tmp('h'), 'c.json') });
  assert.strictEqual(r.status, 0, r.out);
  const j = JSON.parse(r.out.slice(r.out.indexOf('{')));
  assert.deepStrictEqual(j.apps, ['api']);
  assert.strictEqual(j.cambio, 'login-api');
  assert.ok(j.tokens <= 2000);
  assert.match(j.ficha, /Que el login no falle/);
  assert.match(j.ficha, /Etiqueta de app sin app en el monorepo: app:fantasma/);
  assert.strictEqual(harness(dir, ['ficha']).status, 1, 'sin numero: uso');
});

// ---------- formato de tasks.md ----------

test('el formato de tasks.md de /faro:aplicar trae [P], [US-n], test que falla antes y checkpoint, y el conteo no se rompe', () => {
  const skill = fs.readFileSync(path.join(RAIZ, 'plugins', 'faro', 'skills', 'aplicar', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n'); // checkout Windows (autocrlf)
  const m = skill.match(/## Formato de tasks\.md[\s\S]*?```markdown\n([\s\S]*?)```/);
  assert.ok(m, 'la skill aplicar debe documentar el formato con un ejemplo');
  const ejemplo = m[1];
  assert.match(ejemplo, /- \[ \] T\d{3} \[P\] \[US-1\]/, 'marca de paralelizable');
  assert.match(ejemplo, /^## US-1 · .*\(#N\)$/m, 'historia que cita el issue');
  assert.match(ejemplo, /Test que debe FALLAR antes/);
  assert.match(ejemplo, /Checkpoint US-1/);
  // El MISMO contador que usa el harness (progreso de sesion) y el gate de archivar.
  const dir = tmp('tasks');
  escribir(dir, 'tasks.md', ejemplo.replace('- [ ] T001', '- [x] T001'));
  const base = require(path.join(HOOKS, 'lib', 'base.js'))({ fs, path, ROOT: dir });
  const lineas = ejemplo.split('\n').filter((l) => /^- \[ \]/.test(l)).length;
  assert.strictEqual(base.progressOf('tasks.md'), `1/${lineas} tareas (${Math.round(100 / lineas)}%)`);
  assert.doesNotMatch(ejemplo, /\[(CLARIFICAR|NEEDS CLARIFICATION)\b/i, 'las marcas no se confunden con dudas abiertas');
  // Y la ficha lo cuenta igual.
  escribir(dir, 'gestion/cambios/changes/x/proposal.md', '---\ntitulo: X\n---\n');
  escribir(dir, 'gestion/cambios/changes/x/tasks.md', ejemplo);
  assert.deepStrictEqual(fi.resumenCambio(dir, 'gestion/cambios', 'x').tasks, { total: lineas, hechas: 0 });
});
