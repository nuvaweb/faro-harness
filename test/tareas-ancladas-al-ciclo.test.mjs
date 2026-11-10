// TAREAS ANCLADAS AL CICLO: una tarea de PLAN no puede nacer huerfana.
//
// El problema (visto en atlas-core, 0.31.0): 41 issues abiertos, NINGUNO con hito, y 7 fases
// definidas en ESTADO.md. Las fases existian y el trabajo existia, pero nada los unia: al cerrar
// una fase, nadie sabia que tareas suyas quedaban abiertas. Backlog zombi por diseno.
//
// La regla, DETERMINISTA y leida del schema (no del criterio del agente):
//   - labels con ciclo:'plan'  -> la tarea PERTENECE a una fase: --fase OBLIGATORIA.
//   - labels con ciclo:'surge' -> nace fuera del plan (un bug no estaba planificado): fase OPCIONAL.
//   - labels con ciclo:'cierre'-> duplicado/descartado: no llevan fase.
// Un 'bug' NO tiene que fingir que estaba planificado, y un 'requerimiento' NO puede quedar suelto.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(HOOKS, 'faro-schema.json'), 'utf8'));
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
// 'requerimiento'/'tarea' no tienen label nativo de GitHub: hace falta resolver/crear faro:<slug>.
const LABELS_FARO = [
  R(/^repos\/org\/repo\/labels\?/, () => ({ status: 200, body: [] })),
  R(/^repos\/org\/repo\/labels$/, (_m, b) => ({ status: 201, body: b }), 'POST'),
];

const ESTADO = `---
iniciativa: Prueba
clave: PRU
fases_total: 3
fase_actual: 1
---

# Prueba

### Fase 1 · Fundamentos — in_progress
- [ ] algo

### Fase 2 · Construccion — pending
- [ ] otra cosa

### Fase 3 · Cierre — pending
- [ ] lo ultimo
`;

// Parseo minimo de las fases de ESTADO.md, EXACTO al mismo formato que lee lib/estado.js
// (harness.js: '### Fase N · nombre — estado'), para que el test ejercite el camino real: el
// adaptador de produccion (github.js) recibe 'fases()' del harness, no una lista fija en memoria.
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

// ---------- El contrato del schema ----------

test('schema: TODO label declara a que ciclo pertenece (plan / surge / cierre)', () => {
  const sinCiclo = SCHEMA.enums.labels.filter((l) => !l.transversal && !l.ciclo);
  assert.deepStrictEqual(sinCiclo.map((l) => l.slug), [],
    'un label sin `ciclo` deja al harness sin criterio determinista para exigir fase o no');
  const validos = new Set(['plan', 'surge', 'entrada', 'cierre']);
  for (const l of SCHEMA.enums.labels.filter((x) => !x.transversal)) {
    assert.ok(validos.has(l.ciclo), `'${l.slug}' tiene ciclo:'${l.ciclo}', que no es plan/surge/entrada/cierre`);
  }
});

test('schema: el reparto acordado — plan se decide, surge va a la fase activa, cierre no aplica', () => {
  // 'ciclo' ya NO decide SI lleva fase (todos la llevan desde 0.35.0), sino CUAL se propone:
  // un tipo de PLAN se decide con el usuario; uno que SURGE va a la fase activa sin preguntar.
  const por = (c) => SCHEMA.enums.labels.filter((l) => !l.transversal && l.ciclo === c).map((l) => l.slug).sort();
  assert.deepStrictEqual(por('plan'),
    ['datos', 'diseno', 'documentacion', 'investigacion', 'mejora', 'requerimiento', 'tarea'].sort(),
    'un spike (investigacion) consume tiempo de una fase: es plan, no incidencia');
  assert.deepStrictEqual(por('surge'), ['bug', 'infra', 'pregunta'].sort(),
    'lo que aparece mientras se trabaja: va a la fase activa, pero VA a una fase');
  assert.deepStrictEqual(por('entrada'), ['reporte'],
    'lo que llega de fuera sin decidir va al Backlog hasta el triaje, no a la fase activa (#66)');
  assert.deepStrictEqual(por('cierre'), ['descartado', 'duplicado'].sort());
});

test('schema: los TRANSVERSALES no declaran ciclo (son ortogonales: acompanan, no sustituyen)', () => {
  for (const l of SCHEMA.enums.labels.filter((x) => x.transversal)) {
    assert.strictEqual(l.ciclo, undefined, `'${l.slug}' es transversal: no le toca declarar ciclo`);
  }
});

// ---------- La atadura en asignar-tarea ----------

test('tipo de PLAN sin --fase: NO crea el issue y explica que pertenece a una fase', async () => {
  const llamadas = apiFalsa([EQUIPO, CREA_ISSUE, ...LABELS_FARO]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Definir el modelo', 'fer', '', '', '--tipo', 'requerimiento']);
  assert.match(r.out, /FALTA --hito/, r.out);
  assert.match(r.out, /Fase 1/, 'debe listar las fases disponibles de ESTADO.md');
  assert.ok(!llamadas.some((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues'),
    'sin fase, una tarea de plan NO se crea: naceria huerfana');
});

// REGLA DURA (0.35.0, endurece lo de 0.31.1): TODO issue cuelga de un hito, sin excepcion — tambien
// los que SURGEN. Un bug sin hito no cuenta en ninguna fase, no sale en los informes y nadie lo mira
// al cerrar el ciclo. Lo que cambia segun el ciclo NO es si lleva fase, sino cual se propone: un
// tipo de PLAN se decide; un bug va a la fase ACTIVA, que es donde aparecio.
test('tipo que SURGE sin --fase: tampoco se crea — todo issue lleva hito', async () => {
  const llamadas = apiFalsa([EQUIPO, CREA_ISSUE]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Falla el login', 'fer', '', '', '--tipo', 'bug']);
  assert.match(r.out, /FALTA --hito/, r.out);
  assert.ok(!llamadas.some((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues'),
    'un bug sin hito no contaria en ninguna fase ni saldria en los informes');
});

test('tipo que SURGE: se le propone la fase ACTIVA (es donde aparecio), no hay que decidirlo', async () => {
  apiFalsa([EQUIPO, CREA_ISSUE]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Falla el login', 'fer', '', '', '--tipo', 'bug']);
  assert.match(r.out, /--hito 1\b/, `la Fase 1 es la activa en ESTADO.md:\n${r.out}`);
});

test('--origen-fase N: documenta la fase de ORIGEN sin anclarse a ella — se atiende en la fase que se indique', async () => {
  const llamadas = apiFalsa([
    EQUIPO, CREA_ISSUE,
    R(/^repos\/org\/repo\/milestones\?/, () => ({ status: 200, body: [{ number: 5, title: 'Fase 2 — Construccion', state: 'open' }] })),
  ]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'RLS no cubre INSERT', 'fer', '', 'Encontrado al probar', '--tipo', 'bug', '--extra', 'riesgo', '--fase', '2', '--origen-fase', '1']);
  assert.match(r.out, /✅ Tarea #9/, r.out);
  const post = llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues');
  assert.strictEqual(post.body.milestone, 5, 'se atiende en la Fase 2, que es donde hay hueco');
  assert.match(post.body.body, /Origen: Fase 1/, 'pero el cuerpo conserva de donde viene el problema (la Fase 1 ya cerro)');
});

test('--origen-fase junto con --fase: documenta el origen Y cuelga del hito de la fase donde se atiende (son cosas distintas)', async () => {
  const llamadas = apiFalsa([
    EQUIPO, CREA_ISSUE,
    R(/^repos\/org\/repo\/milestones\?/, () => ({ status: 200, body: [{ number: 9, title: 'Fase 3 — Cierre', state: 'open' }] })),
  ]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'RLS no cubre INSERT', 'fer', '', '', '--tipo', 'bug', '--fase', '3', '--origen-fase', '1']);
  const post = llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues');
  assert.strictEqual(post.body.milestone, 9, 'se atiende en la Fase 3 (donde hay hueco), no en la 1 (ya cerrada)');
  assert.match(post.body.body, /Origen: Fase 1/, 'pero el cuerpo no debe perder de donde viene el problema');
});

test('--fase N adjunta el hito de esa fase al issue', async () => {
  const llamadas = apiFalsa([
    EQUIPO, CREA_ISSUE, ...LABELS_FARO,
    R(/^repos\/org\/repo\/milestones\?/, () => ({ status: 200, body: [{ number: 7, title: 'Fase 1 — Fundamentos', state: 'open' }] })),
  ]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Definir el modelo', 'fer', '', '', '--tipo', 'requerimiento', '--fase', '1']);
  assert.match(r.out, /✅ Tarea #9/, r.out);
  const post = llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues');
  assert.strictEqual(post.body.milestone, 7, 'el issue debe colgar del hito de la Fase 1');
});

test('--fase N sin hito existente: lo CREA desde ESTADO.md y lo usa (una llamada, solo la 1a vez)', async () => {
  const llamadas = apiFalsa([
    EQUIPO, CREA_ISSUE, ...LABELS_FARO,
    R(/^repos\/org\/repo\/milestones\?/, () => ({ status: 200, body: [] })),
    R(/^repos\/org\/repo\/milestones$/, (_m, b) => ({ status: 201, body: { number: 12, ...b } }), 'POST'),
  ]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Construir', 'fer', '', '', '--tipo', 'tarea', '--fase', '2']);
  assert.match(r.out, /✅ Tarea #9/, r.out);
  const creaHito = llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/milestones');
  assert.ok(creaHito, 'si la fase no tiene hito, se crea');
  assert.match(creaHito.body.title, /^Fase 2/, 'el titulo ANCLA al numero de fase: sin fichero de mapeo');
  const post = llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues');
  assert.strictEqual(post.body.milestone, 12);
});

test('--fase de una fase que NO existe en ESTADO.md: se rechaza', async () => {
  const llamadas = apiFalsa([EQUIPO, CREA_ISSUE, ...LABELS_FARO, R(/^repos\/org\/repo\/milestones/, () => ({ status: 200, body: [] }))]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Algo', 'fer', '', '', '--tipo', 'tarea', '--fase', '9']);
  assert.match(r.out, /Fase 9 no existe/i, r.out);
  assert.ok(!llamadas.some((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues'));
});

test("--fase backlog: valida como fase de PLAN sin numero — un requerimiento que aun no se sabe CUANDO se hace no queda fuera del sistema", async () => {
  const llamadas = apiFalsa([
    EQUIPO, CREA_ISSUE, ...LABELS_FARO,
    R(/^repos\/org\/repo\/milestones\?/, () => ({ status: 200, body: [] })),
    R(/^repos\/org\/repo\/milestones$/, (_m, b) => ({ status: 201, body: { number: 20, ...b } }), 'POST'),
  ]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Idea nueva', 'fer', '', '', '--tipo', 'requerimiento', '--fase', 'backlog']);
  assert.match(r.out, /✅ Tarea #9/, r.out);
  const creaHito = llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/milestones');
  assert.ok(creaHito && creaHito.body.title === 'Backlog', 'debe usar/crear un hito unico llamado Backlog, no ligado a ninguna fase de ESTADO.md');
  const post = llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues');
  assert.strictEqual(post.body.milestone, 20);
});

test('tipo de CIERRE (duplicado): no pide fase ni la adjunta', async () => {
  const llamadas = apiFalsa([EQUIPO, CREA_ISSUE, R(/^repos\/org\/repo\/milestones/, () => ({ status: 200, body: [] }))]);
  const a = await adaptador(repo());
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Repetida', 'fer', '', '', '--tipo', 'duplicado']);
  assert.doesNotMatch(r.out, /FALTA --hito/, r.out);
  const post = llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues');
  assert.ok(post);
  assert.strictEqual(post.body.milestone, undefined);
});

test('sin ESTADO.md (repo nivel 0) una tarea de plan se crea igual: no hay fases que exigir', async () => {
  const llamadas = apiFalsa([EQUIPO, CREA_ISSUE, ...LABELS_FARO]);
  const a = await adaptador(tmp('sin-estado'));   // repo SIN ESTADO.md
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Algo', 'fer', '', '', '--tipo', 'requerimiento']);
  assert.match(r.out, /✅ Tarea #9/, `un repo sin faseo no puede exigir fase:\n${r.out}`);
  assert.ok(llamadas.some((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues'));
});

// ---------- La VIGILANCIA (agregado.js): sin gastar tokens ni red propia, sin bloquear validate ----------
//
// cmdValidate() es SINCRONO (sin red, corre en CI/hooks locales) — no se le mete una llamada a la API
// ahi dentro. La vigilancia de tareas vive donde YA vive el patron de "un dato agregado cacheado que
// se refresca en background" (agregado.js + gh_resumen): un query barato mas (total_count, sin traer
// los issues), compuesto en el MISMO refresco que ya hace mis_tareas/prs_por_revisar.

test('refrescarResumen: cuenta issues de PLAN sin hito, con UN query barato (total_count, no trae los issues)', async () => {
  const llamadas = apiFalsa([
    R(/^user$/, () => ({ status: 200, body: { login: 'fer' } })),
    R(/^search\/issues\?q=/, () => ({ status: 200, body: { total_count: 3, items: [] } })),
  ]);
  const a = await adaptador(repo());
  const snap = await a.refrescarResumen(Date.now());
  assert.ok(snap, 'debe devolver snapshot');
  assert.strictEqual(typeof snap.plan_sin_hito, 'number', 'plan_sin_hito debe ser un total_count, no un array (barato)');
  const q = llamadas.find((c) => c.ruta.startsWith('search/issues') && /no%3Amilestone|no:milestone/.test(decodeURIComponent(c.ruta)));
  assert.ok(q, 'debe consultar con el qualifier no:milestone');
  // el query debe restringirse a los labels de ciclo:'plan' del schema (no a TODOS los issues sin hito)
  const qDecoded = decodeURIComponent(q.ruta);
  assert.match(qDecoded, /label:/, 'debe filtrar por los labels de PLAN, no contar cualquier issue sin hito');
});

test("refrescarResumen: un issue en el hito 'Backlog' NO cuenta como zombi (tiene milestone, aunque no sea una fase de ESTADO.md)", async () => {
  // no:milestone en el query de GitHub Search ya excluye cualquier issue CON milestone asignado,
  // 'Backlog' incluido — esta prueba documenta esa propiedad a proposito, para que un cambio futuro
  // del query no la rompa sin que un test lo note.
  const llamadas = apiFalsa([
    R(/^user$/, () => ({ status: 200, body: { login: 'fer' } })),
    R(/^search\/issues\?q=/, () => ({ status: 200, body: { total_count: 0, items: [] } })),
  ]);
  const a = await adaptador(repo());
  const snap = await a.refrescarResumen(Date.now());
  assert.strictEqual(snap.plan_sin_hito, 0);
  const q = llamadas.find((c) => c.ruta.startsWith('search/issues') && decodeURIComponent(c.ruta).includes('no:milestone'));
  assert.ok(q, 'el query debe seguir usando no:milestone (un issue CON hito, sea cual sea, no es zombi)');
});

test('refrescarResumen: tambien cuenta ESTANCADAS (>30 dias sin tocar) entre las de PLAN sin hito', async () => {
  apiFalsa([
    R(/^user$/, () => ({ status: 200, body: { login: 'fer' } })),
    R(/^search\/issues\?q=/, () => ({ status: 200, body: { total_count: 1, items: [] } })),
  ]);
  const a = await adaptador(repo());
  const snap = await a.refrescarResumen(Date.now());
  assert.strictEqual(typeof snap.plan_sin_hito_estancadas, 'number');
});
