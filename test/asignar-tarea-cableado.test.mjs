// asignar-tarea: el CABLEADO del submodulo github-tareas.js.
//
// Incidente (0.29.0): al extraer cmdAsignarTarea a lib/github-tareas.js se quedaron FUERA de la
// inyeccion tres simbolos que el codigo movido seguia usando: labelsCatalogo, resolverLabel y ctx
// (para ctx.specBase). Resultado: `ReferenceError: labelsCatalogo is not defined` con CUALQUIER
// invocacion — incluso sin argumentos, porque la llamada ocurre ANTES de validar el uso.
// Es el segundo corte seguido de este comando (en 0.9.5 fue la ruta de faro-schema.json).
//
// Estos tests cubren el patron completo, no solo el sintoma: el catalogo de tipos se lista sin red,
// cada rama de validacion responde sin reventar, y el issue se crea con su label resuelto.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${n}-`));

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

async function adaptador() {
  const mod = await import(`file://${path.join(HOOKS, 'lib', 'github.js').replace(/\\/g, '/')}`);
  const home = tmp('home'); const cfg = path.join(home, '.faro.json');
  fs.writeFileSync(cfg, JSON.stringify({ tokens: { 'github.com': { token: 'tok', forja: 'github', user: { login: 'fer' } } } }));
  process.env.FARO_CONFIG_PATH = cfg; process.env.FARO_GITHUB_TOKEN = ''; process.env.GITHUB_TOKEN = '';
  return mod.default({
    ROOT: tmp('root'), IS_TEMPLATE: false, specBase: 'gestion/cambios',
    git: (...a) => (a[0] === 'remote' ? 'git@github.com:org/repo.git' : ''),
    forge: () => ({ forge: 'github', host: 'github.com', owner: 'org', project: 'repo', path: 'org/repo' }),
    fases: () => [], isDone: (e) => e === 'done', isActive: (e) => e === 'in_progress',
  });
}
async function correr(fn, argv, ...args) {
  const out = []; const log = console.log; const wr = process.stdout.write.bind(process.stdout);
  const exit = process.exit; let codigo = null;
  console.log = (...a) => out.push(a.join(' '));
  process.stdout.write = (s) => { out.push(String(s).replace(/\n$/, '')); return true; };
  process.exit = (c) => { codigo = c; throw new Error('__exit__'); };
  if (argv) process.argv = ['node', 'harness.js', ...argv];
  try { await fn(...args); } catch (e) { if (e.message !== '__exit__') throw e; } finally { console.log = log; process.stdout.write = wr; process.exit = exit; }
  return { out: out.join('\n'), codigo };
}
// Equipo de la repo: 'fer' existe, cualquier otro no.
const EQUIPO = R(/^repos\/org\/repo\/collaborators/, () => ({ status: 200, body: [{ login: 'fer' }] }));

test('asignar-tarea SIN argumentos: lista el catalogo de tipos en vez de reventar (labelsCatalogo cableado)', async () => {
  apiFalsa([EQUIPO]);
  const a = await adaptador();
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea']);
  assert.match(r.out, /Uso: node \.claude\/hooks\/harness\.js asignar-tarea/, r.out);
  assert.match(r.out, /requerimiento \(/, 'el catalogo del schema debe listarse, no salir vacio');
  assert.match(r.out, /bug \(/);
  assert.doesNotMatch(r.out, /\(faro-schema\.json sin enums\.labels\)/, 'el schema del plugin debe encontrarse');
  assert.strictEqual(r.codigo, 1);
});

test('asignar-tarea sin --tipo: exige el label y sigue mostrando el catalogo', async () => {
  apiFalsa([EQUIPO]);
  const a = await adaptador();
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Arreglar el login', 'fer']);
  assert.match(r.out, /FALTA --tipo/, r.out);
  assert.match(r.out, /mejora \(/);
  assert.strictEqual(r.codigo, 1);
});

test('asignar-tarea con un tipo fuera del catalogo: lo rechaza nombrando los validos', async () => {
  apiFalsa([EQUIPO]);
  const a = await adaptador();
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Algo', 'fer', '', '', '--tipo', 'inventado']);
  assert.match(r.out, /Tipo 'inventado' no esta en el catalogo/, r.out);
  assert.strictEqual(r.codigo, 1);
});

test('asignar-tarea crea el issue con label nativo resuelto y el cuerpo apunta al change (resolverLabel + specBase cableados)', async () => {
  const llamadas = apiFalsa([
    EQUIPO,
    R(/^repos\/org\/repo\/issues$/, (_m, b) => ({ status: 201, body: { number: 7, html_url: 'https://github.com/org/repo/issues/7', ...b } }), 'POST'),
  ]);
  const a = await adaptador();
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Falla el login', 'fer', 'mi-change', 'Pasos para reproducir', '--tipo', 'bug']);
  assert.match(r.out, /✅ Tarea #7 asignada a fer · tipo: bug/, r.out);
  const post = llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues');
  assert.ok(post, 'debe haberse creado el issue');
  assert.deepStrictEqual(post.body.labels, ['bug'], 'bug es nativo de GitHub: se reutiliza sin crear faro:bug');
  assert.deepStrictEqual(post.body.assignees, ['fer']);
  assert.match(post.body.body, /gestion\/cambios\/changes\/mi-change\//, 'el specBase inyectado debe usarse, no un ctx inexistente');
});

test('asignar-tarea con tipo NO nativo: crea el label faro:<slug> y lo aplica', async () => {
  const llamadas = apiFalsa([
    EQUIPO,
    R(/^repos\/org\/repo\/labels\?/, () => ({ status: 200, body: [] })),
    R(/^repos\/org\/repo\/labels$/, (_m, b) => ({ status: 201, body: b }), 'POST'),
    R(/^repos\/org\/repo\/issues$/, (_m, b) => ({ status: 201, body: { number: 8, html_url: 'u', ...b } }), 'POST'),
  ]);
  const a = await adaptador();
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Definir el modelo', 'fer', '', '', '--tipo', 'requerimiento']);
  assert.match(r.out, /✅ Tarea #8 asignada a fer · tipo: requerimiento/, r.out);
  const crea = llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/labels');
  assert.ok(crea && crea.body.name === 'faro:requerimiento', 'debe crear el label faro:requerimiento');
  const post = llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues');
  assert.deepStrictEqual(post.body.labels, ['faro:requerimiento']);
});

test('asignar-tarea a alguien que NO esta en el equipo: avisa y no crea nada', async () => {
  const llamadas = apiFalsa([EQUIPO]);
  const a = await adaptador();
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Algo', 'desconocido', '', '', '--tipo', 'bug']);
  assert.match(r.out, /NO esta en el equipo de la repo/, r.out);
  assert.ok(!llamadas.some((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues'), 'no debe crear el issue');
});

// #196: el issue lleva su TIPO de GitHub (Bug/Feature/Task de la organizacion), no solo la etiqueta.
const TIPOS_ORG = R(/^orgs\/org\/issue-types$/, () => ({ status: 200, body: [{ id: 1, name: 'Task' }, { id: 2, name: 'Bug' }, { id: 3, name: 'Feature' }] }));
const CREAR_ISSUE = R(/^repos\/org\/repo\/issues$/, (_m, b) => ({ status: 201, body: { number: 9, html_url: 'u', ...b } }), 'POST');
const LABELS_VACIOS = [R(/^repos\/org\/repo\/labels\?/, () => ({ status: 200, body: [] })), R(/^repos\/org\/repo\/labels$/, (_m, b) => ({ status: 201, body: b }), 'POST')];

for (const [tipo, esperado] of [['bug', 'Bug'], ['requerimiento', 'Feature'], ['mejora', 'Feature'], ['tarea', 'Task'], ['infra', 'Task']]) {
  test(`#196: asignar-tarea --tipo ${tipo} fija el tipo de GitHub ${esperado}`, async () => {
    const llamadas = apiFalsa([EQUIPO, TIPOS_ORG, CREAR_ISSUE, ...LABELS_VACIOS]);
    const a = await adaptador();
    const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Algo', 'fer', '', '', '--tipo', tipo]);
    const post = llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues');
    assert.ok(post, r.out);
    assert.strictEqual(post.body.type, esperado, r.out);
  });
}

test('#196: en una organizacion SIN tipos de issue, el issue se crea con su etiqueta y el harness lo avisa', async () => {
  const llamadas = apiFalsa([EQUIPO, CREAR_ISSUE]);
  const a = await adaptador();
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Falla algo', 'fer', '', '', '--tipo', 'bug']);
  const post = llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues');
  assert.ok(post, r.out);
  assert.strictEqual(post.body.type, undefined, 'sin tipos en la org no se manda type (la API lo rechazaria)');
  assert.deepStrictEqual(post.body.labels, ['bug']);
  assert.match(r.out, /no tiene tipos de issue/, r.out);
});

// #213: el tipo de GitHub es OBLIGATORIO para todo issue — sin excepciones por slug.
for (const tipo of ['reporte', 'duplicado', 'descartado', 'pregunta']) {
  test(`#213: asignar-tarea --tipo ${tipo} tambien nace con tipo de GitHub (Task)`, async () => {
    const llamadas = apiFalsa([EQUIPO, TIPOS_ORG, CREAR_ISSUE, ...LABELS_VACIOS]);
    const a = await adaptador();
    const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Algo', 'fer', '', '', '--tipo', tipo]);
    const post = llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues');
    assert.ok(post, r.out);
    assert.strictEqual(post.body.type, 'Task', r.out);
  });
}

// #213: reparar-tarea audita y repara el tipo de GitHub que falta o no cuadra con la etiqueta.
const CUERPO_BUG_OK = '## Objetivo\n\nx\n\n## Pasos para reproducir\n\n1. x\n\n## Resultado esperado\n\nx\n\n## Resultado obtenido\n\nx\n\n## Contexto\n\nx\n\n## Alcance\n\n- x\n\n## Fuera de alcance\n\n- x\n\n## Criterios de aceptacion\n\n- [ ] x\n';
test('#213: reparar-tarea sin numero lista los issues abiertos SIN tipo de GitHub', async () => {
  apiFalsa([TIPOS_ORG,
    R(/^repos\/org\/repo\/issues\?state=open/, () => ({ status: 200, body: [
      { number: 5, title: 'Sin tipo', body: '', labels: [{ name: 'bug' }], type: null },
      { number: 6, title: 'Con tipo', body: '', labels: [{ name: 'bug' }], type: { name: 'Bug' } },
    ] }))]);
  const a = await adaptador();
  const r = await correr(a.cmdRepararTarea, ['reparar-tarea']);
  assert.match(r.out, /#5[\s\S]*sin tipo de GitHub \(deberia ser Bug\)/, r.out);
  assert.doesNotMatch(r.out, /#6[^\n]*\n[^\n]*sin tipo de GitHub/, r.out);
});

test('#213: reparar-tarea <N> --confirmo pone el tipo de GitHub aunque el formato ya este completo', async () => {
  const llamadas = apiFalsa([TIPOS_ORG,
    R(/^repos\/org\/repo\/issues\/5$/, () => ({ status: 200, body: { number: 5, title: 'Falla', body: CUERPO_BUG_OK, labels: [{ name: 'bug' }], type: null, html_url: 'u' } }), 'GET'),
    R(/^repos\/org\/repo\/issues\/5$/, (_m, b) => ({ status: 200, body: { number: 5, ...b } }), 'PATCH')]);
  const a = await adaptador();
  const r = await correr(a.cmdRepararTarea, ['reparar-tarea', '5', '--confirmo']);
  const patch = llamadas.find((c) => c.metodo === 'PATCH' && c.ruta === 'repos/org/repo/issues/5');
  assert.ok(patch, r.out);
  assert.strictEqual(patch.body.type, 'Bug', r.out);
});
