// MOVER una tarea entre fases (y sacarla del Backlog): el backlog es la sala de espera, y de ahi
// se van sacando las tareas a su fase cuando se decide CUANDO se hacen.
//
// Mover trabajo entre fases es un CAMBIO DE ALCANCE, no un ajuste silencioso: el comando deja
// constancia en el propio issue (de donde viene y a donde va), para que dentro de tres semanas se
// sepa por que esa tarea acabo en la Fase 4 y no en la 2. Es la misma razon por la que el cierre
// forzoso avisa en vez de mover tareas por su cuenta.
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

const ESTADO = `---
iniciativa: Prueba
clave: PRU
fases_total: 3
fase_actual: 1
---
### Fase 1 · Fundamentos — in_progress
- [ ] algo

### Fase 2 · Construccion — pending
- [ ] otra cosa

### Fase 3 · Cierre — pending
- [ ] lo ultimo
`;

function faseFromEstado(root) {
  return () => {
    let text;
    try { text = fs.readFileSync(path.join(root, 'ESTADO.md'), 'utf8'); } catch { return []; }
    const out = [];
    const re = /^###\s+Fase\s+(\d+)\s*[·:]\s*(.+?)\s*(?:—|--|-)\s*(\w+)\s*$/gm;
    let m;
    while ((m = re.exec(text))) out.push({ num: Number(m[1]), nombre: m[2].trim(), estado: m[3].toLowerCase() });
    return out;
  };
}
async function adaptador(root) {
  const mod = await import(`file://${path.join(HOOKS, 'lib', 'github.js').replace(/\\/g, '/')}`);
  const home = tmp('home'); const cfg = path.join(home, '.faro.json');
  fs.writeFileSync(cfg, JSON.stringify({ tokens: { 'github.com': { token: 'tok', forja: 'github', user: { login: 'fer' } } } }));
  process.env.FARO_CONFIG_PATH = cfg; process.env.FARO_GITHUB_TOKEN = ''; process.env.GITHUB_TOKEN = '';
  const r = root || tmp('root');
  return mod.default({
    ROOT: r, IS_TEMPLATE: false, specBase: 'gestion/cambios',
    git: (...a) => (a[0] === 'remote' ? 'git@github.com:org/repo.git' : ''),
    forge: () => ({ forge: 'github', host: 'github.com', owner: 'org', project: 'repo', path: 'org/repo' }),
    fases: faseFromEstado(r), isDone: (e) => e === 'done', isActive: (e) => e === 'in_progress',
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
function repo() {
  const root = tmp('root');
  fs.writeFileSync(path.join(root, 'ESTADO.md'), ESTADO);
  return root;
}

const HITOS = [
  { number: 9, title: 'Backlog', state: 'open' },
  { number: 3, title: 'Fase 2 — Construccion', state: 'open' },
];
const LISTAR_HITOS = R(/^repos\/org\/repo\/milestones/, () => ({ status: 200, body: HITOS }));
// Al salir del Backlog la tarea tiene que llegar CON su formato (#72): el fixture lleva un cuerpo completo.
const CUERPO_COMPLETO = '## Objetivo\n\nx\n\n## Contexto\n\nx\n\n## Alcance\n\n- x\n\n## Fuera de alcance\n\n- x\n\n## Criterios de aceptacion\n\n- [ ] x\n';
const ISSUE_EN_BACKLOG = R(/^repos\/org\/repo\/issues\/42$/, () => ({ status: 200, body: { number: 42, title: 'Idea aceptada', state: 'open', body: CUERPO_COMPLETO, milestone: { number: 9, title: 'Backlog' } } }), 'GET');
const PATCH_OK = R(/^repos\/org\/repo\/issues\/42$/, (_m, b) => ({ status: 200, body: { number: 42, ...b } }), 'PATCH');
const COMENTAR_OK = R(/^repos\/org\/repo\/issues\/42\/comments$/, (_m, b) => ({ status: 201, body: b }), 'POST');

test('mover-tarea <N> --fase <M>: cambia el hito del issue al de esa fase', async () => {
  const llamadas = apiFalsa([LISTAR_HITOS, ISSUE_EN_BACKLOG, PATCH_OK, COMENTAR_OK]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdMoverTarea, ['mover-tarea', '42', '--fase', '2']);
  assert.match(r.out, /#42/, r.out);
  const patch = llamadas.find((c) => c.metodo === 'PATCH' && c.ruta === 'repos/org/repo/issues/42');
  assert.ok(patch, 'debe hacer PATCH sobre el issue');
  assert.strictEqual(patch.body.milestone, 3, 'debe apuntar al hito de la Fase 2');
});

test('mover-tarea deja CONSTANCIA en el issue: de donde viene y a donde va (es un cambio de alcance)', async () => {
  const llamadas = apiFalsa([LISTAR_HITOS, ISSUE_EN_BACKLOG, PATCH_OK, COMENTAR_OK]);
  const a = await adaptador(repo());
  await correr(a.cmdMoverTarea, ['mover-tarea', '42', '--fase', '2']);
  const com = llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues/42/comments');
  assert.ok(com, 'mover trabajo entre fases no puede ser silencioso');
  assert.match(com.body.body, /Backlog/, 'debe decir de donde venia');
  assert.match(com.body.body, /Fase 2/, 'y a donde va');
});

test('mover-tarea con un motivo: lo incluye en el comentario', async () => {
  const llamadas = apiFalsa([LISTAR_HITOS, ISSUE_EN_BACKLOG, PATCH_OK, COMENTAR_OK]);
  const a = await adaptador(repo());
  await correr(a.cmdMoverTarea, ['mover-tarea', '42', '--fase', '2', 'bloquea el piloto']);
  const com = llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues/42/comments');
  assert.match(com.body.body, /bloquea el piloto/, com.body.body);
});

test('mover-tarea --fase backlog: devuelve una tarea a la sala de espera (el movimiento inverso)', async () => {
  const llamadas = apiFalsa([
    LISTAR_HITOS, PATCH_OK, COMENTAR_OK,
    R(/^repos\/org\/repo\/issues\/42$/, () => ({ status: 200, body: { number: 42, title: 'X', state: 'open', milestone: { number: 3, title: 'Fase 2 — Construccion' } } }), 'GET'),
  ]);
  const a = await adaptador(repo());
  await correr(a.cmdMoverTarea, ['mover-tarea', '42', '--fase', 'backlog']);
  const patch = llamadas.find((c) => c.metodo === 'PATCH');
  assert.strictEqual(patch.body.milestone, 9, 'debe apuntar al hito Backlog');
});

test('mover-tarea a una fase que NO existe en ESTADO.md: se rechaza sin tocar el issue', async () => {
  const llamadas = apiFalsa([LISTAR_HITOS, ISSUE_EN_BACKLOG, PATCH_OK, COMENTAR_OK]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdMoverTarea, ['mover-tarea', '42', '--fase', '9']);
  assert.match(r.out, /Fase 9 no existe/i, r.out);
  assert.ok(!llamadas.some((c) => c.metodo === 'PATCH'), 'no debe tocar el issue si la fase no existe');
});

test('mover-tarea sin --fase: explica el uso y no toca nada', async () => {
  const llamadas = apiFalsa([LISTAR_HITOS, ISSUE_EN_BACKLOG, PATCH_OK, COMENTAR_OK]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdMoverTarea, ['mover-tarea', '42']);
  assert.match(r.out, /Uso:/, r.out);
  assert.ok(!llamadas.some((c) => c.metodo === 'PATCH'));
});

test('mover-tarea --listar backlog: enseña lo que espera sin fase, para decidir que sacar', async () => {
  apiFalsa([
    LISTAR_HITOS,
    R(/^repos\/org\/repo\/issues\?milestone=9/, () => ({ status: 200, body: [
      { number: 42, title: 'Idea aceptada', state: 'open', updated_at: '2026-09-01T00:00:00Z', labels: [{ name: 'faro:requerimiento' }] },
      { number: 51, title: 'Otra idea', state: 'open', updated_at: '2026-09-10T00:00:00Z', labels: [] },
    ] })),
  ]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdMoverTarea, ['mover-tarea', '--listar', 'backlog']);
  assert.match(r.out, /#42/, r.out);
  assert.match(r.out, /#51/, r.out);
  assert.match(r.out, /Idea aceptada/);
});

// REGLA DURA: del Backlog solo se SALE a una fase. Una tarea no se completa estando en la sala de
// espera — si se hizo, es que pertenecia a alguna fase. (Descartarla SI vale: 'descartar-tarea' la
// cierra como 'no se hara', que es una decision distinta de 'esta hecha'.)
test('cerrar-tarea de un issue en Backlog: se RECHAZA — primero pasa a una fase', async () => {
  const llamadas = apiFalsa([LISTAR_HITOS, ISSUE_EN_BACKLOG, PATCH_OK, COMENTAR_OK]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdCerrarTarea, ['cerrar-tarea', '42']);
  assert.match(r.out, /Backlog/, r.out);
  assert.match(r.out, /mover-tarea/, 'debe decir como resolverlo');
  assert.ok(!llamadas.some((c) => c.metodo === 'PATCH' && c.body && c.body.state === 'closed'),
    'no debe cerrarse un issue que sigue en la sala de espera');
});

test('cerrar-tarea de un issue YA anclado a una fase: se cierra normalmente', async () => {
  const llamadas = apiFalsa([
    LISTAR_HITOS, PATCH_OK, COMENTAR_OK,
    R(/^repos\/org\/repo\/issues\/42$/, () => ({ status: 200, body: { number: 42, title: 'X', state: 'open', milestone: { number: 3, title: 'Fase 2 — Construccion' } } }), 'GET'),
  ]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdCerrarTarea, ['cerrar-tarea', '42']);
  assert.doesNotMatch(r.out, /Backlog/, r.out);
  const patch = llamadas.find((c) => c.metodo === 'PATCH' && c.body && c.body.state === 'closed');
  assert.ok(patch, 'una tarea anclada a su fase si se puede cerrar');
});

test('descartar-tarea SI puede cerrar algo del Backlog: "no se hara" no es "esta hecha"', async () => {
  const llamadas = apiFalsa([LISTAR_HITOS, ISSUE_EN_BACKLOG, PATCH_OK, COMENTAR_OK]);
  const a = await adaptador(repo());
  await correr(a.cmdDescartarTarea, ['descartar-tarea', '42', 'fuera de alcance']);
  const patch = llamadas.find((c) => c.metodo === 'PATCH' && c.body && c.body.state === 'closed');
  assert.ok(patch, 'descartar una idea del backlog es legitimo');
  assert.strictEqual(patch.body.state_reason, 'not_planned', 'se cierra como NO PLANIFICADA, no como completada');
});

test('mover-tarea --listar backlog con el backlog vacio: lo dice, no falla', async () => {
  apiFalsa([
    LISTAR_HITOS,
    R(/^repos\/org\/repo\/issues\?milestone=9/, () => ({ status: 200, body: [] })),
  ]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdMoverTarea, ['mover-tarea', '--listar', 'backlog']);
  assert.match(r.out, /vacio|ninguna|nada/i, r.out);
});

test('del Backlog a una fase SIN formato: se niega, dice lo que falta y no toca el issue (#72)', async () => {
  const llamadas = apiFalsa([LISTAR_HITOS, PATCH_OK, COMENTAR_OK,
    R(/^repos\/org\/repo\/issues\/42$/, () => ({ status: 200, body: { number: 42, title: 'Idea', state: 'open', body: 'dos lineas', milestone: { number: 9, title: 'Backlog' } } }), 'GET')]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdMoverTarea, ['mover-tarea', '42', '--fase', '2']);
  assert.strictEqual(r.codigo, 1, r.out);
  assert.match(r.out, /formato de su tipo/, r.out);
  assert.match(r.out, /reparar-tarea 42/);
  assert.ok(!llamadas.some((c) => c.metodo === 'PATCH'), 'no se mueve sin formato');
});

test('un REPORTE no sale del Backlog sin triaje (#72)', async () => {
  const llamadas = apiFalsa([LISTAR_HITOS, PATCH_OK, COMENTAR_OK,
    R(/^repos\/org\/repo\/issues\/42$/, () => ({ status: 200, body: { number: 42, title: 'Llega de fuera', state: 'open', body: CUERPO_COMPLETO, labels: [{ name: 'faro:reporte' }], milestone: { number: 9, title: 'Backlog' } } }), 'GET')]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdMoverTarea, ['mover-tarea', '42', '--fase', '2']);
  assert.match(r.out, /REPORTE/, r.out);
  assert.match(r.out, /triaje/);
  assert.ok(!llamadas.some((c) => c.metodo === 'PATCH'));
});

test('de la BANDEJA (sin hito) a una fase SIN formato: se niega igual que desde el Backlog (#84)', async () => {
  const llamadas = apiFalsa([LISTAR_HITOS, PATCH_OK, COMENTAR_OK,
    R(/^repos\/org\/repo\/issues\/42$/, () => ({ status: 200, body: { number: 42, title: 'Llego de Userback', state: 'open', body: 'dos lineas', labels: [{ name: 'bug' }], milestone: null } }), 'GET')]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdMoverTarea, ['mover-tarea', '42', '--fase', '2']);
  assert.strictEqual(r.codigo, 1, r.out);
  assert.match(r.out, /bandeja de entrada/, r.out);
  assert.ok(!llamadas.some((c) => c.metodo === 'PATCH'));
});

// #196: sacar una tarea de la bandeja o del Backlog (lo que hace el triaje) le fija su tipo de GitHub.
test('#196: mover-tarea fuera del Backlog fija el tipo de GitHub segun su etiqueta', async () => {
  const llamadas = apiFalsa([
    LISTAR_HITOS, PATCH_OK, COMENTAR_OK,
    R(/^orgs\/org\/issue-types$/, () => ({ status: 200, body: [{ id: 1, name: 'Task' }, { id: 2, name: 'Bug' }, { id: 3, name: 'Feature' }] })),
    R(/^repos\/org\/repo\/issues\/42$/, () => ({ status: 200, body: { number: 42, title: 'Idea aceptada', state: 'open', body: CUERPO_COMPLETO + '\n## A quien sirve\n\nx\n', labels: [{ name: 'faro:requerimiento' }], milestone: { number: 9, title: 'Backlog' } } }), 'GET'),
  ]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdMoverTarea, ['mover-tarea', '42', '--fase', '2']);
  const patch = llamadas.find((c) => c.metodo === 'PATCH' && c.ruta === 'repos/org/repo/issues/42');
  assert.ok(patch, r.out);
  assert.strictEqual(patch.body.milestone, 3);
  assert.strictEqual(patch.body.type, 'Feature', r.out);
});

// #213: el tipo de GitHub se reconcilia en CADA movimiento, no solo al salir de la bandeja/Backlog.
test('#213: mover-tarea entre fases corrige un tipo de GitHub que no cuadra con la etiqueta', async () => {
  const llamadas = apiFalsa([
    LISTAR_HITOS, PATCH_OK, COMENTAR_OK,
    R(/^orgs\/org\/issue-types$/, () => ({ status: 200, body: [{ id: 1, name: 'Task' }, { id: 2, name: 'Bug' }, { id: 3, name: 'Feature' }] })),
    R(/^repos\/org\/repo\/issues\/42$/, () => ({ status: 200, body: { number: 42, title: 'Falla', state: 'open', body: CUERPO_COMPLETO, labels: [{ name: 'bug' }], type: { name: 'Task' }, milestone: { number: 3, title: 'Fase 2 — Construccion' } } }), 'GET'),
  ]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdMoverTarea, ['mover-tarea', '42', '--fase', 'backlog']);
  const patch = llamadas.find((c) => c.metodo === 'PATCH' && c.ruta === 'repos/org/repo/issues/42');
  assert.ok(patch, r.out);
  assert.strictEqual(patch.body.type, 'Bug', r.out);
});
