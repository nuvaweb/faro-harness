// Contrato unico de forja (#254): los flujos piden una operacion y cada adaptador la resuelve. La misma
// operacion se comprueba en GitHub y en GitLab con la API simulada: sin red.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(RAIZ, 'plugins', 'faro', 'hooks');
const url = (rel) => `file://${path.join(HOOKS, ...rel.split('/')).replace(/\\/g, '/')}`;
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${n}-`));

const GH = 'https://api.github.com/';
const GL = 'https://gitlab.com/api/v4/';
const P = 'projects/g%2Fsub%2Fp';

function apiFalsa(base, rutas) {
  const llamadas = [];
  globalThis.fetch = async (u, opts = {}) => {
    const ruta = String(u).replace(base, ''); const metodo = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null; llamadas.push({ metodo, ruta, body });
    for (const [re, m, resp] of rutas) {
      if (re.test(ruta) && m === metodo) { const r = resp(body); return { ok: r.status < 400, status: r.status, json: async () => r.body }; }
    }
    return { ok: false, status: 404, json: async () => ({ message: `404 ${ruta}` }) };
  };
  return llamadas;
}

const salidaOriginal = process.exit;
const argvOriginal = process.argv;
afterEach(() => { process.exit = salidaOriginal; process.argv = argvOriginal; });

async function capturar(fn) {
  const lineas = []; const log = console.log;
  console.log = (...a) => lineas.push(a.join(' '));
  process.exit = (c) => { throw new Error(`exit ${c}`); };
  try { await fn(); } catch (e) { if (!/^exit /.test(e.message)) throw e; } finally { console.log = log; }
  return lineas.join('\n');
}

async function github() {
  const mod = (await import(url('lib/github.js'))).default;
  const cfg = path.join(tmp('home'), '.faro.json');
  fs.writeFileSync(cfg, JSON.stringify({ tokens: { 'github.com': { token: 'tok', forja: 'github', user: { login: 'fer' } } } }));
  process.env.FARO_CONFIG_PATH = cfg; process.env.FARO_GITHUB_TOKEN = ''; process.env.GITHUB_TOKEN = '';
  return mod({
    ROOT: tmp('root'), IS_TEMPLATE: false, specBase: 'gestion/cambios',
    git: (...a) => (a[0] === 'remote' ? 'https://github.com/org/repo.git' : ''),
    forge: () => ({ forge: 'github', host: 'github.com', owner: 'org', project: 'repo', path: 'org/repo' }),
    fases: () => [{ num: 2, nombre: 'Dos' }], isDone: () => false, isActive: () => false, faroSchema: () => ({}),
  });
}
const CATALOGO = { enums: { labels: [{ slug: 'bug', ciclo: 'surge' }, { slug: 'requerimiento', ciclo: 'plan' }, { slug: 'reporte', ciclo: 'surge' }, { slug: 'descartado', transversal: true }] } };
async function gitlab(extra = {}) {
  const mod = (await import(url('lib/forge-gitlab.js'))).default;
  process.env.FARO_CONFIG_PATH = path.join(tmp('home'), '.faro.json');
  return mod({
    ROOT: tmp('root'), git: (...a) => (a[0] === 'branch' ? 'origin/feat/1-x\norigin/develop' : ''), specBase: 'x',
    forge: () => ({ forge: 'gitlab', host: 'gitlab.com', owner: 'g', project: 'p', path: 'g/sub/p' }),
    tokenPara: () => 'tok', guardarToken: () => {}, faroSchema: () => CATALOGO,
    fases: () => [{ num: 2, nombre: 'Dos' }], isDone: () => false, isActive: () => false, ...extra,
  });
}

const incidencia = (o = {}) => ({ iid: 7, title: 'T', description: 'cuerpo', state: 'opened', labels: ['tipo::bug'], milestone: null, assignees: [{ username: 'ana' }], web_url: 'https://gitlab.com/g/sub/p/-/issues/7', updated_at: '2026-10-01T00:00:00Z', ...o });
const mr = (o = {}) => ({ iid: 3, title: 'M', description: 'Closes #7', state: 'merged', source_branch: 'feat/7-x', target_branch: 'develop', merged_at: '2026-10-02T00:00:00Z', merge_commit_sha: 'abc', web_url: 'https://gitlab.com/g/sub/p/-/merge_requests/3', ...o });

test('los dos adaptadores cumplen el contrato completo', async () => {
  const { OPERACIONES, faltan } = await import(url('lib/forge-contrato.js')).then((m) => m.default);
  assert.ok(OPERACIONES.length >= 20);
  assert.deepStrictEqual(faltan(await github()), []);
  assert.deepStrictEqual(faltan(await gitlab()), []);
});

test('un adaptador incompleto se detecta y dice que le falta', async () => {
  const { faltan } = await import(url('lib/forge-contrato.js')).then((m) => m.default);
  assert.ok(faltan({ leerIssue() {} }).includes('hechosTareas'));
});

test('leerIssue da la misma forma en GitHub y en GitLab', async () => {
  apiFalsa(GH, [[/^repos\/org\/repo\/issues\/7$/, 'GET', () => ({ status: 200, body: { number: 7, title: 'T', body: 'cuerpo', state: 'open', labels: [{ name: 'bug' }], milestone: null, assignees: [{ login: 'ana' }], html_url: 'u' } })]]);
  const a = await (await github()).leerIssue(7);
  apiFalsa(GL, [[/^projects\/g%2Fsub%2Fp\/issues\/7$/, 'GET', () => ({ status: 200, body: incidencia() })]]);
  const b = await (await gitlab()).leerIssue(7);
  for (const r of [a, b]) {
    assert.ok(r.ok);
    assert.strictEqual(r.body.number, 7);
    assert.strictEqual(r.body.body, 'cuerpo');
    assert.strictEqual(r.body.state, 'open');
    assert.strictEqual(r.body.assignees[0].login, 'ana');
  }
  assert.strictEqual(b.body.labels[0].name, 'faro:bug', 'el ambito tipo:: no llega a la logica comun');
});

test('GitLab: estado, cierre y comentario de una tarea', async () => {
  const ll = apiFalsa(GL, [
    [/\/issues\/7$/, 'GET', () => ({ status: 200, body: incidencia() })],
    [/\/issues\/7\/notes$/, 'POST', () => ({ status: 201, body: { id: 1 } })],
    [/\/issues\/7$/, 'PUT', () => ({ status: 200, body: incidencia({ state: 'closed' }) })],
  ]);
  const a = await gitlab();
  assert.strictEqual(await a.issueEstado(7), 'open');
  assert.strictEqual(await a.comentarIssue(7, 'hola'), true);
  assert.strictEqual(await a.cerrarIssue(7, 'nota'), true);
  const puts = ll.filter((l) => l.metodo === 'PUT');
  assert.deepStrictEqual(puts[0].body, { state_event: 'close' });
  assert.ok(ll.filter((l) => l.metodo === 'POST').some((l) => l.body.body === 'nota'));
});

test('GitLab: sin token las operaciones de tarea devuelven vacio, no lanzan', async () => {
  apiFalsa(GL, []);
  const a = await gitlab({ tokenPara: () => null });
  assert.strictEqual(await a.issueEstado(7), null);
  assert.strictEqual(await a.cerrarIssue(7), false);
  assert.strictEqual(await a.comentarIssue(7, 'x'), false);
  assert.strictEqual(await a.hechosTareas(), null);
  assert.strictEqual(await a.prAbiertoDe('x'), null);
  assert.strictEqual(await a.prsDeRama('x'), null);
});

test('GitLab: hechosTareas alimenta al reconciliador igual que GitHub', async () => {
  apiFalsa(GL, [
    [/\/issues\?state=opened/, 'GET', () => ({ status: 200, body: [incidencia()] })],
    [/\/issues\?state=closed/, 'GET', () => ({ status: 200, body: [incidencia({ iid: 8, state: 'closed', labels: ['faro:descartado'] })] })],
    [/\/merge_requests\?state=all/, 'GET', () => ({ status: 200, body: [mr()] })],
    [/\/milestones\?/, 'GET', () => ({ status: 200, body: [{ id: 90, iid: 2, title: 'Fase 2', state: 'active' }] })],
  ]);
  const h = await (await gitlab()).hechosTareas();
  assert.deepStrictEqual(h.issues.map((i) => i.number), [7, 8]);
  assert.strictEqual(h.issues[1].state_reason, 'not_planned');
  assert.deepStrictEqual(h.ramas, ['origin/feat/1-x', 'origin/develop']);
  const pr = h.prs[0];
  assert.strictEqual(pr.head.ref, 'feat/7-x'); assert.strictEqual(pr.base.ref, 'develop'); assert.strictEqual(pr.state, 'closed'); assert.strictEqual(pr.merged_at, '2026-10-02T00:00:00Z');
  assert.strictEqual(h.hitos[0].number, 2);
  const tarea = (await import(url('lib/tarea.js'))).default;
  const r = tarea.reconciliar(h);
  assert.deepStrictEqual(r.porCerrar.map((e) => e.numero), [7], 'el MR fusionado con Closes #7 cierra la tarea');
});

test('GitLab: peticiones de una rama', async () => {
  const ll = apiFalsa(GL, [[/\/merge_requests\?/, 'GET', () => ({ status: 200, body: [mr({ state: 'opened', merged_at: null })] })]]);
  const a = await gitlab();
  assert.strictEqual(await a.prAbiertoDe('feat/7-x'), 'https://gitlab.com/g/sub/p/-/merge_requests/3');
  const prs = await a.prsDeRama('feat/7-x');
  assert.strictEqual(prs[0].state, 'open');
  assert.ok(ll.every((l) => l.ruta.includes('source_branch=feat%2F7-x')));
});

test('GitLab: publicar crea el release y no repite uno que ya existe', async () => {
  const ll = apiFalsa(GL, [[/\/releases$/, 'POST', () => ({ status: 201, body: { _links: { self: 'https://gitlab.com/rel' } } })]]);
  const a = await gitlab();
  assert.deepStrictEqual(await a.publicarRelease('v1.0.0', 'notas'), { ok: true, url: 'https://gitlab.com/rel' });
  assert.deepStrictEqual(ll.at(-1).body, { tag_name: 'v1.0.0', name: 'v1.0.0', description: 'notas' });
  const ll2 = apiFalsa(GL, [[/\/releases\/v1\.0\.0$/, 'GET', () => ({ status: 200, body: { tag_name: 'v1.0.0', _links: { self: 'u' } } })]]);
  assert.deepStrictEqual(await a.publicarRelease('v1.0.0', 'notas'), { ok: true, yaExistia: true, url: 'u' });
  assert.ok(!ll2.some((l) => l.metodo === 'POST'));
});

test('GitLab: descartar deja marca para no contar la tarea como hecha', async () => {
  const ll = apiFalsa(GL, [
    [/\/labels\?/, 'GET', () => ({ status: 200, body: [{ name: 'faro:descartado' }] })],
    [/\/issues\/7$/, 'PUT', () => ({ status: 200, body: incidencia({ state: 'closed' }) })],
  ]);
  process.argv = ['node', 'harness', 'descartar-tarea', '7'];
  await capturar(async () => (await gitlab()).cmdDescartarTarea());
  const put = ll.find((l) => l.metodo === 'PUT');
  assert.strictEqual(put.body.state_event, 'close');
  assert.strictEqual(put.body.add_labels, 'faro:descartado');
});

test('GitLab: cerrar-tarea se niega en el Backlog y cierra en una fase', async () => {
  let hito = { id: 90, iid: 1, title: 'Backlog' };
  const ll = apiFalsa(GL, [
    [/\/issues\/7$/, 'GET', () => ({ status: 200, body: incidencia({ milestone: hito }) })],
    [/\/issues\/7$/, 'PUT', () => ({ status: 200, body: incidencia({ state: 'closed' }) })],
  ]);
  const a = await gitlab();
  process.argv = ['node', 'harness', 'cerrar-tarea', '7'];
  const salida = await capturar(() => a.cmdCerrarTarea());
  assert.match(salida, /sala de espera/);
  assert.ok(!ll.some((l) => l.metodo === 'PUT'));
  hito = { id: 91, iid: 2, title: 'Fase 2 — Dos' };
  assert.match(await capturar(() => a.cmdCerrarTarea()), /cerrada como completada/);
});

test('GitLab: mover-tarea cambia el hito y deja constancia despues', async () => {
  const ll = apiFalsa(GL, [
    [/\/issues\/7$/, 'GET', () => ({ status: 200, body: incidencia({ milestone: { id: 90, iid: 1, title: 'Fase 1' } }) })],
    [/\/milestones\?/, 'GET', () => ({ status: 200, body: [{ id: 91, iid: 2, title: 'Fase 2 — Dos' }] })],
    [/\/issues\/7$/, 'PUT', () => ({ status: 200, body: incidencia() })],
    [/\/notes$/, 'POST', () => ({ status: 201, body: { id: 1 } })],
  ]);
  process.argv = ['node', 'harness', 'mover-tarea', '7', '--hito', '2', 'replan'];
  const salida = await capturar(async () => (await gitlab()).cmdMoverTarea());
  assert.match(salida, /movida de 'Fase 1' a 'Fase 2 — Dos'/);
  const escrituras = ll.filter((l) => l.metodo !== 'GET');
  assert.deepStrictEqual(escrituras[0].body, { milestone_id: 91 });
  assert.match(escrituras[1].body.body, /Motivo: replan/);
});

test('GitLab: un reporte no sale de la bandeja a una fase sin triar', async () => {
  const ll = apiFalsa(GL, [
    [/\/issues\/7$/, 'GET', () => ({ status: 200, body: incidencia({ labels: ['tipo::reporte'] }) })],
    [/\/milestones\?/, 'GET', () => ({ status: 200, body: [{ id: 91, iid: 2, title: 'Fase 2 — Dos' }] })],
  ]);
  process.argv = ['node', 'harness', 'mover-tarea', '7', '--hito', '2'];
  assert.match(await capturar(async () => (await gitlab()).cmdMoverTarea()), /REPORTE/);
  assert.ok(!ll.some((l) => l.metodo === 'PUT'));
});

test('GitLab: ampliar-tarea anade subtareas al cuerpo', async () => {
  const ll = apiFalsa(GL, [
    [/\/issues\/7$/, 'GET', () => ({ status: 200, body: incidencia({ description: '## Subtareas\n- [ ] una\n' }) })],
    [/\/issues\/7$/, 'PUT', () => ({ status: 200, body: incidencia() })],
  ]);
  process.argv = ['node', 'harness', 'ampliar-tarea', '7', '--subtarea', 'dos'];
  assert.match(await capturar(async () => (await gitlab()).cmdAmpliarTarea()), /ampliado con 1/);
  assert.match(ll.find((l) => l.metodo === 'PUT').body.description, /- \[ \] dos/);
});

test('comentarios de usuario, sin las notas del sistema de GitLab', async () => {
  apiFalsa(GL, [[/\/issues\/7\/notes\?/, 'GET', () => ({ status: 200, body: [{ body: 'hola', system: false, author: { username: 'ana' } }, { body: 'cambio el hito', system: true }] })]]);
  const c = await (await gitlab()).leerComentarios(7);
  assert.deepStrictEqual(c.map((x) => x.body), ['hola']);
  assert.strictEqual(c[0].autor, 'ana');
  apiFalsa(GH, [[/\/issues\/7\/comments\?/, 'GET', () => ({ status: 200, body: [{ body: 'hola', user: { login: 'ana' } }] })]]);
  const d = await (await github()).leerComentarios(7);
  assert.deepStrictEqual(d, [{ autor: 'ana', fecha: undefined, body: 'hola' }]);
});

test('pedirRevision se resuelve en cada forja y no se asigna al autor', async () => {
  const gh = apiFalsa(GH, [[/^user$/, 'GET', () => ({ status: 200, body: { login: 'fer' } })], [/requested_reviewers$/, 'POST', () => ({ status: 201, body: {} })]]);
  assert.strictEqual(await (await github()).pedirRevision(4, ['ana', 'fer']), true);
  assert.deepStrictEqual(gh.find((l) => l.metodo === 'POST').body, { reviewers: ['ana'] });
  const gl = apiFalsa(GL, [
    [/\/members\/all|\/members\?/, 'GET', () => ({ status: 200, body: [{ id: 5, username: 'ana', access_level: 40 }] })],
    [/\/merge_requests\/4$/, 'PUT', () => ({ status: 200, body: {} })],
  ]);
  assert.strictEqual(await (await gitlab()).pedirRevision(4, ['ana']), true);
  assert.deepStrictEqual(gl.find((l) => l.metodo === 'PUT').body, { reviewer_ids: [5] });
});

test('adjuntos: GitLab apunta las subidas relativas a su API con credencial de su host', async () => {
  apiFalsa(GL, [
    [/\/issues\/7$/, 'GET', () => ({ status: 200, body: incidencia({ description: '![c](/uploads/abc/c.png)' }) })],
    [/\/issues\/7\/notes\?/, 'GET', () => ({ status: 200, body: [] })],
  ]);
  const r = await (await gitlab()).adjuntosDeIssue(7);
  assert.ok(r.ok);
  assert.strictEqual(r.host, 'gitlab.com');
  assert.match(r.textos[0], /https:\/\/gitlab\.com\/api\/v4\/projects\/g%2Fsub%2Fp\/uploads\/abc\/c\.png/);
});

test('harness.js no conoce las rutas de la API de cada forja en las tareas', () => {
  const src = fs.readFileSync(path.join(HOOKS, 'harness.js'), 'utf8');
  const ficha = src.slice(src.indexOf('async function cmdFicha'), src.indexOf('async function cmdFicha') + 1500);
  assert.ok(!/repos\/\$\{|projects\/\$\{/.test(ficha), 'cmdFicha pide el issue al adaptador');
  const adj = src.slice(src.indexOf('async function cmdTriajeAdjuntos'), src.indexOf('function cmdTriaje()'));
  assert.ok(!/ghMod\(\)|repos\/\$\{/.test(adj), 'los adjuntos se piden al adaptador de la forja detectada');
});

test('el aviso de capacidad explica lo que una forja no ofrece', async () => {
  const { capacidades } = await import(url('lib/forge.js')).then((m) => m.default);
  assert.strictEqual(capacidades('gitlab').tiempo, true);
  assert.strictEqual(capacidades('github').tiempo, false);
  assert.strictEqual(capacidades('gitlab').repararTarea, false);
  assert.strictEqual(capacidades('desconocida').api, false);
});

test('marketplace: GitLab recomienda el origen publico; un espejo declarado usa fuente git', async () => {
  const { marketplacePara, bloqueSettings, diagnosticoDescarga } = await import(url('lib/forge.js')).then((m) => m.default);
  const mk = marketplacePara('gitlab', () => '');
  assert.deepStrictEqual(mk, { source: 'github', repo: 'nuvaweb/faro-harness' });
  const espejo = marketplacePara('github', () => 'https://git.miempresa.com/faro.git');
  assert.deepStrictEqual(espejo, { source: 'git', url: 'https://git.miempresa.com/faro.git' });
  const bloque = JSON.parse(bloqueSettings(espejo));
  assert.deepStrictEqual(Object.keys(bloque.extraKnownMarketplaces['faro-marketplace'].source), ['source', 'url']);
  assert.match(diagnosticoDescarga(espejo), /^git ls-remote https:\/\/git\.miempresa\.com\//);
});
