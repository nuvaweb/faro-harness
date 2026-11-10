// --HITO en vez de --fase (#217): el flag con el que se ancla un issue se llama --hito, porque un
// hito no siempre es una fase — puede ser una version (motor), el Backlog o cualquier milestone.
// --fase sigue aceptandose como ALIAS con aviso (repos y agentes con docs viejas no se rompen).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const FH = require(path.join(HOOKS, 'lib', 'flag-hito.js'));
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
const EQUIPO = R(/^repos\/org\/repo\/collaborators/, () => ({ status: 200, body: [{ login: 'fer' }] }));
const CREA_ISSUE = R(/^repos\/org\/repo\/issues$/, (_m, b) => ({ status: 201, body: { number: 9, html_url: 'u', ...b } }), 'POST');
const LABELS_FARO = [
  R(/^repos\/org\/repo\/labels\?/, () => ({ status: 200, body: [] })),
  R(/^repos\/org\/repo\/labels$/, (_m, b) => ({ status: 201, body: b }), 'POST'),
];

const ESTADO = `---
iniciativa: Prueba
clave: PRU
fases_total: 2
fase_actual: 1
---

### Fase 1 · Fundamentos — in_progress
- [ ] algo

### Fase 2 · Construccion — pending
- [ ] otra cosa
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
  return mod.default({
    ROOT: root, IS_TEMPLATE: false, specBase: 'gestion/cambios',
    git: (...a) => (a[0] === 'remote' ? 'git@github.com:org/repo.git' : ''),
    forge: () => ({ forge: 'github', host: 'github.com', owner: 'org', project: 'repo', path: 'org/repo' }),
    fases: faseFromEstado(root), isDone: (e) => e === 'done', isActive: (e) => e === 'in_progress',
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
function repo() {
  const root = tmp('root');
  fs.writeFileSync(path.join(root, 'ESTADO.md'), ESTADO);
  return root;
}
const hitosApi = (lista) => R(/^repos\/org\/repo\/milestones/, () => ({ status: 200, body: lista }), 'GET');

// ---------- El parseo (lib/flag-hito.js) ----------

test('extraer: --hito <v> y --hito=<v> dan el valor y quitan el flag del resto', () => {
  assert.deepStrictEqual(FH.extraer(['42', '--hito', '2', 'motivo']), { valor: '2', alias: false, resto: ['42', 'motivo'] });
  assert.deepStrictEqual(FH.extraer(['--hito=1.2', 'x']), { valor: '1.2', alias: false, resto: ['x'] });
});

test('extraer: --fase es ALIAS de --hito y lo marca para avisar', () => {
  assert.deepStrictEqual(FH.extraer(['42', '--fase', 'backlog']), { valor: 'backlog', alias: true, resto: ['42'] });
  assert.deepStrictEqual(FH.extraer(['--fase=3']), { valor: '3', alias: true, resto: [] });
  assert.match(FH.AVISO_ALIAS, /--hito/);
});

test('extraer: --origen-fase NO es el alias (documenta el origen, no ancla)', () => {
  const r = FH.extraer(['--origen-fase', '1', '--hito', '2']);
  assert.strictEqual(r.valor, '2');
  assert.deepStrictEqual(r.resto, ['--origen-fase', '1']);
});

// ---------- asignar-tarea ----------

test('asignar-tarea --hito N ancla al hito de esa fase (igual que --fase antes)', async () => {
  const llamadas = apiFalsa([EQUIPO, CREA_ISSUE, ...LABELS_FARO, hitosApi([{ number: 7, title: 'Fase 1 — Fundamentos', state: 'open' }])]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Definir', 'fer', '', '', '--tipo', 'requerimiento', '--hito', '1']);
  assert.match(r.out, /✅ Tarea #9/, r.out);
  assert.doesNotMatch(r.out, /se llama --hito/, 'con --hito no hay aviso de alias');
  const post = llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues');
  assert.strictEqual(post.body.milestone, 7);
});

test('asignar-tarea --fase N sigue funcionando, pero avisa de que se llama --hito', async () => {
  const llamadas = apiFalsa([EQUIPO, CREA_ISSUE, ...LABELS_FARO, hitosApi([{ number: 7, title: 'Fase 1 — Fundamentos', state: 'open' }])]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Definir', 'fer', '', '', '--tipo', 'requerimiento', '--fase', '1']);
  assert.match(r.out, /se llama --hito/, r.out);
  const post = llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues');
  assert.strictEqual(post.body.milestone, 7);
});

test('asignar-tarea --hito "<titulo>": ancla a un hito existente que no es una fase (p.ej. un sprint)', async () => {
  const llamadas = apiFalsa([EQUIPO, CREA_ISSUE, ...LABELS_FARO, hitosApi([{ number: 31, title: 'Sprint 4', state: 'open' }])]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Algo', 'fer', '', '', '--tipo', 'tarea', '--hito', 'Sprint 4']);
  assert.match(r.out, /✅ Tarea #9/, r.out);
  const post = llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues');
  assert.strictEqual(post.body.milestone, 31);
});

test('asignar-tarea --hito que no es fase ni hito existente: se rechaza sin crear', async () => {
  const llamadas = apiFalsa([EQUIPO, CREA_ISSUE, ...LABELS_FARO, hitosApi([])]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Algo', 'fer', '', '', '--tipo', 'tarea', '--hito', 'Sprint 9']);
  assert.match(r.out, /no existe/i, r.out);
  assert.ok(!llamadas.some((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues'));
});

test('asignar-tarea sin hito en un tipo de plan: el mensaje pide --hito', async () => {
  apiFalsa([EQUIPO, CREA_ISSUE, ...LABELS_FARO]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Definir', 'fer', '', '', '--tipo', 'requerimiento']);
  assert.match(r.out, /FALTA --hito/, r.out);
  assert.doesNotMatch(r.out, /--fase\b/, 'el mensaje ya no documenta --fase');
});

// ---------- mover-tarea ----------

const ISSUE_42 = R(/^repos\/org\/repo\/issues\/42$/, () => ({ status: 200, body: { number: 42, title: 'X', state: 'open', milestone: { number: 3, title: 'Fase 2 — Construccion' } } }), 'GET');
const PATCH_42 = R(/^repos\/org\/repo\/issues\/42$/, (_m, b) => ({ status: 200, body: { number: 42, ...b } }), 'PATCH');
const COMENTA_42 = R(/^repos\/org\/repo\/issues\/42\/comments$/, (_m, b) => ({ status: 201, body: b }), 'POST');

test('mover-tarea <N> --hito backlog: mueve igual que --fase backlog', async () => {
  const llamadas = apiFalsa([ISSUE_42, PATCH_42, COMENTA_42, hitosApi([{ number: 9, title: 'Backlog', state: 'open' }, { number: 3, title: 'Fase 2 — Construccion', state: 'open' }])]);
  const a = await adaptador(repo());
  await correr(a.cmdMoverTarea, ['mover-tarea', '42', '--hito', 'backlog']);
  assert.strictEqual(llamadas.find((c) => c.metodo === 'PATCH').body.milestone, 9);
});

test('mover-tarea --hito "<titulo>": mueve a un hito existente que no es fase', async () => {
  const llamadas = apiFalsa([ISSUE_42, PATCH_42, COMENTA_42, hitosApi([{ number: 31, title: 'Sprint 4', state: 'open' }, { number: 3, title: 'Fase 2 — Construccion', state: 'open' }])]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdMoverTarea, ['mover-tarea', '42', '--hito', 'Sprint 4']);
  const patch = llamadas.find((c) => c.metodo === 'PATCH');
  assert.ok(patch, r.out);
  assert.strictEqual(patch.body.milestone, 31);
});

test('mover-tarea en un repo SIN fases (p.ej. el motor): --hito X.Y mueve al hito de ese titulo', async () => {
  const llamadas = apiFalsa([ISSUE_42, PATCH_42, COMENTA_42, hitosApi([{ number: 11, title: '1.2', state: 'open' }])]);
  const a = await adaptador(tmp('sinfases'));
  const r = await correr(a.cmdMoverTarea, ['mover-tarea', '42', '--hito', '1.2']);
  const patch = llamadas.find((c) => c.metodo === 'PATCH');
  assert.ok(patch, r.out);
  assert.strictEqual(patch.body.milestone, 11);
});

test('mover-tarea --fase sigue funcionando con aviso; el uso documenta --hito', async () => {
  const llamadas = apiFalsa([ISSUE_42, PATCH_42, COMENTA_42, hitosApi([{ number: 9, title: 'Backlog', state: 'open' }])]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdMoverTarea, ['mover-tarea', '42', '--fase', 'backlog']);
  assert.match(r.out, /se llama --hito/, r.out);
  assert.strictEqual(llamadas.find((c) => c.metodo === 'PATCH').body.milestone, 9);
  const u = await correr(a.cmdMoverTarea, ['mover-tarea', '42']);
  assert.match(u.out, /--hito/, u.out);
  assert.doesNotMatch(u.out, /--fase\b/, u.out);
});
