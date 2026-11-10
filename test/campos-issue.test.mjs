// CAMPOS DE ISSUE de la organizacion (#215): Target date, Start date, Priority, Effort... o los que
// defina cada organizacion. FARO no fija nombres: los atajos se resuelven contra lo que la org tenga.
//
// Reglas que se prueban:
//  - los valores se validan ANTES de crear el issue (un valor malo no deja un issue a medias);
//  - sin --fecha-objetivo, el issue HEREDA la fecha de su hito, sea cual sea (fase, version, Backlog...);
//  - al mover de hito, la fecha heredada sigue al hito nuevo; la puesta a mano no se toca;
//  - nunca se manda la lista VACIA (la API la interpreta como "borra todos los valores").
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const CI = createRequire(import.meta.url)(path.join(HOOKS, 'lib', 'campos-issue.js'));
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
async function correr(fn, argv) {
  const out = []; const log = console.log; const wr = process.stdout.write.bind(process.stdout);
  const exit = process.exit; let codigo = null;
  console.log = (...a) => out.push(a.join(' '));
  process.stdout.write = (s) => { out.push(String(s).replace(/\n$/, '')); return true; };
  process.exit = (c) => { codigo = c; throw new Error('__exit__'); };
  if (argv) process.argv = ['node', 'harness.js', ...argv];
  try { await fn(); } catch (e) { if (e.message !== '__exit__') throw e; } finally { console.log = log; process.stdout.write = wr; process.exit = exit; }
  return { out: out.join('\n'), codigo };
}

// Los campos que tiene hoy la organizacion acme-org (ids inventados).
const DEFS = [
  { id: 11, name: 'Priority', data_type: 'single_select', options: [{ name: 'Urgent' }, { name: 'High' }, { name: 'Medium' }, { name: 'Low' }] },
  { id: 12, name: 'Start date', data_type: 'date' },
  { id: 13, name: 'Target date', data_type: 'date' },
  { id: 14, name: 'Effort', data_type: 'single_select', options: [{ name: 'S' }, { name: 'M' }, { name: 'L' }] },
];
const CAMPOS_ORG = R(/^orgs\/org\/issue-fields$/, () => ({ status: 200, body: DEFS }));
const EQUIPO = R(/^repos\/org\/repo\/collaborators/, () => ({ status: 200, body: [{ login: 'fer' }] }));
const CREAR = R(/^repos\/org\/repo\/issues$/, (_m, b) => ({ status: 201, body: { number: 7, html_url: 'u', ...b } }), 'POST');
const ESCRIBIR = R(/^repos\/org\/repo\/issues\/\d+\/issue-field-values$/, (_m, b) => ({ status: 200, body: b }), 'POST');
const CUERPO = '## Objetivo\n\nx\n\n## Contexto\n\nx\n\n## Alcance\n\n- x\n\n## Fuera de alcance\n\n- x\n\n## Criterios de aceptacion\n\n- [ ] x\n';
const posts = (ll, re) => ll.filter((c) => c.metodo === 'POST' && re.test(c.ruta));

// ---------- logica pura ----------

test('parsearArgs: saca --campo y los atajos, deja el resto intacto', () => {
  const p = CI.parsearArgs(['Titulo', 'fer', '--campo', 'Target date=2026-11-30', '--prioridad=high', '--tipo', 'bug', '--esfuerzo', 'M']);
  assert.deepStrictEqual(p.resto, ['Titulo', 'fer', '--tipo', 'bug']);
  assert.deepStrictEqual(p.pedidos, [{ nombre: 'Target date', valor: '2026-11-30' }, { alias: 'prioridad', valor: 'high' }, { alias: 'esfuerzo', valor: 'M' }]);
  assert.match(CI.parsearArgs(['--campo', 'sin-igual']).error, /Nombre=valor/);
});

test('resolver: atajo y nombre sin distinguir mayusculas; la opcion se normaliza a la de la org', () => {
  const r = CI.resolver(DEFS, [{ alias: 'fecha-objetivo', valor: '2026-11-30' }, { nombre: 'priority', valor: 'high' }]);
  assert.deepStrictEqual(r.valores.map(({ field_id, value }) => ({ field_id, value })), [{ field_id: 13, value: '2026-11-30' }, { field_id: 11, value: 'High' }]);
});

test('resolver: rechaza fechas imposibles, opciones que no existen y campos que la org no tiene', () => {
  assert.match(CI.resolver(DEFS, [{ alias: 'inicio', valor: '2026-02-30' }]).error, /AAAA-MM-DD/);
  assert.match(CI.resolver(DEFS, [{ alias: 'prioridad', valor: 'altisima' }]).error, /Opciones: Urgent · High · Medium · Low/);
  assert.match(CI.resolver(DEFS, [{ nombre: 'Sprint', valor: '3' }]).error, /no tiene el campo 'Sprint'.*Target date/);
  assert.match(CI.resolver(DEFS.filter((d) => d.id !== 14), [{ alias: 'esfuerzo', valor: 'M' }]).error, /no tiene --esfuerzo/);
});

test('planFechaAlMover: la heredada sigue al hito; la puesta a mano no se toca', () => {
  assert.deepStrictEqual(CI.planFechaAlMover('2026-10-31', '2026-10-31', '2026-12-15'), { accion: 'poner', fecha: '2026-12-15' });
  assert.deepStrictEqual(CI.planFechaAlMover(null, '2026-10-31', '2026-12-15'), { accion: 'poner', fecha: '2026-12-15' });
  assert.deepStrictEqual(CI.planFechaAlMover('2026-10-31', '2026-10-31', null), { accion: 'quitar' });
  assert.deepStrictEqual(CI.planFechaAlMover('2026-11-05', '2026-10-31', '2026-12-15'), { accion: 'nada' });
  assert.deepStrictEqual(CI.planFechaAlMover(null, null, null), { accion: 'nada' });
});

test('cuerpoApi nunca manda el nombre interno; escribir() con lista vacia no llama a la API', async () => {
  assert.deepStrictEqual(CI.cuerpoApi([{ field_id: 13, value: '2026-11-30', nombre: 'Target date' }]), { issue_field_values: [{ field_id: 13, value: '2026-11-30' }] });
  let llamadas = 0;
  const acc = CI.crear(async () => { llamadas++; return { ok: true, status: 200 }; });
  await acc.escribir('org', 'repo', 7, []);
  assert.strictEqual(llamadas, 0, 'un array vacio BORRARIA todos los valores del issue');
});

// ---------- asignar-tarea ----------

test('asignar-tarea --fecha-objetivo --prioridad: crea el issue y DESPUES fija los campos', async () => {
  const ll = apiFalsa([CAMPOS_ORG, EQUIPO, CREAR, ESCRIBIR]);
  const a = await adaptador();
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Login roto', 'fer', '', CUERPO, '--tipo', 'bug', '--fecha-objetivo', '2026-11-30', '--prioridad', 'high']);
  assert.match(r.out, /✅ Tarea #7/, r.out);
  assert.match(r.out, /Campos: Target date = 2026-11-30 · Priority = High/, r.out);
  const iCrear = ll.findIndex((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues');
  const iCampos = ll.findIndex((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/issues/7/issue-field-values');
  assert.ok(iCrear >= 0 && iCampos > iCrear, 'los valores van tras crear el issue');
  assert.deepStrictEqual(ll[iCampos].body, { issue_field_values: [{ field_id: 13, value: '2026-11-30' }, { field_id: 11, value: 'High' }] });
});

test('asignar-tarea con un valor invalido: se rechaza y NO se crea el issue', async () => {
  const ll = apiFalsa([CAMPOS_ORG, EQUIPO, CREAR, ESCRIBIR]);
  const a = await adaptador();
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Login roto', 'fer', '', CUERPO, '--tipo', 'bug', '--prioridad', 'altisima']);
  assert.strictEqual(r.codigo, 1, r.out);
  assert.match(r.out, /no es una opcion de 'Priority'/);
  assert.strictEqual(posts(ll, /issues/).length, 0, 'nada a medias: ni issue ni valores');
});

test('asignar-tarea --campo en una organizacion SIN campos: se rechaza sin crear nada', async () => {
  const ll = apiFalsa([R(/^orgs\/org\/issue-fields$/, () => ({ status: 200, body: [] })), EQUIPO, CREAR]);
  const a = await adaptador();
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Login roto', 'fer', '', CUERPO, '--tipo', 'bug', '--campo', 'Target date=2026-11-30']);
  assert.strictEqual(r.codigo, 1, r.out);
  assert.match(r.out, /no tiene campos de issue/);
  assert.strictEqual(posts(ll, /issues/).length, 0);
});

test('asignar-tarea sin --fecha-objetivo HEREDA la fecha del hito (aqui, el Backlog: cualquier hito vale)', async () => {
  const ll = apiFalsa([
    CAMPOS_ORG, EQUIPO, CREAR, ESCRIBIR,
    R(/^repos\/org\/repo\/milestones\/5$/, () => ({ status: 200, body: { number: 5, title: 'Backlog', due_on: '2026-12-31T08:00:00Z' } })),
    R(/^repos\/org\/repo\/milestones/, () => ({ status: 200, body: [{ number: 5, title: 'Backlog', state: 'open' }] })),
  ]);
  const a = await adaptador();
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Idea', 'fer', '', CUERPO, '--tipo', 'bug', '--fase', 'backlog']);
  assert.match(r.out, /Target date = 2026-12-31 \(la del hito\)/, r.out);
  const v = posts(ll, /issue-field-values$/)[0];
  assert.deepStrictEqual(v.body, { issue_field_values: [{ field_id: 13, value: '2026-12-31' }] });
});

test('asignar-tarea con --fecha-objetivo explicita: manda la suya, no la del hito', async () => {
  const ll = apiFalsa([
    CAMPOS_ORG, EQUIPO, CREAR, ESCRIBIR,
    R(/^repos\/org\/repo\/milestones\/5$/, () => ({ status: 200, body: { number: 5, title: 'Backlog', due_on: '2026-12-31T08:00:00Z' } })),
    R(/^repos\/org\/repo\/milestones/, () => ({ status: 200, body: [{ number: 5, title: 'Backlog', state: 'open' }] })),
  ]);
  const a = await adaptador();
  await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Idea', 'fer', '', CUERPO, '--tipo', 'bug', '--fase', 'backlog', '--fecha-objetivo', '2026-11-15']);
  assert.deepStrictEqual(posts(ll, /issue-field-values$/)[0].body, { issue_field_values: [{ field_id: 13, value: '2026-11-15' }] });
});

test('asignar-tarea sin campos ni hito con fecha: no toca issue-field-values', async () => {
  const ll = apiFalsa([CAMPOS_ORG, EQUIPO, CREAR, ESCRIBIR]);
  const a = await adaptador();
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Login roto', 'fer', '', CUERPO, '--tipo', 'bug']);
  assert.match(r.out, /✅ Tarea #7/, r.out);
  assert.strictEqual(posts(ll, /issue-field-values/).length, 0);
});

// ---------- mover-tarea ----------

function rutasMover(valorActual, dueDestino) {
  return [
    CAMPOS_ORG,
    R(/^repos\/org\/repo\/milestones\/9$/, () => ({ status: 200, body: { number: 9, title: 'Backlog', due_on: dueDestino } })),
    R(/^repos\/org\/repo\/milestones/, () => ({ status: 200, body: [{ number: 9, title: 'Backlog', state: 'open' }] })),
    R(/^repos\/org\/repo\/issues\/42$/, () => ({ status: 200, body: { number: 42, title: 'X', state: 'open', body: CUERPO, labels: [{ name: 'bug' }], milestone: { number: 3, title: '1.2', due_on: '2026-10-31T07:00:00Z' } } }), 'GET'),
    R(/^repos\/org\/repo\/issues\/42$/, (_m, b) => ({ status: 200, body: { number: 42, ...b } }), 'PATCH'),
    R(/^repos\/org\/repo\/issues\/42\/comments$/, (_m, b) => ({ status: 201, body: b }), 'POST'),
    R(/^repos\/org\/repo\/issues\/42\/issue-field-values\?/, () => ({ status: 200, body: valorActual ? [{ issue_field_id: 13, data_type: 'date', value: valorActual }] : [] }), 'GET'),
    ESCRIBIR,
    R(/^repos\/org\/repo\/issues\/42\/issue-field-values\/13$/, () => ({ status: 204, body: {} }), 'DELETE'),
  ];
}

test('mover-tarea: la fecha HEREDADA del hito de origen pasa a la del hito nuevo', async () => {
  const ll = apiFalsa(rutasMover('2026-10-31', '2026-12-31T08:00:00Z'));
  const a = await adaptador();
  const r = await correr(a.cmdMoverTarea, ['mover-tarea', '42', '--fase', 'backlog']);
  assert.match(r.out, /Target date: 2026-12-31 \(la del hito nuevo/, r.out);
  assert.deepStrictEqual(posts(ll, /issue-field-values$/)[0].body, { issue_field_values: [{ field_id: 13, value: '2026-12-31' }] });
});

test('mover-tarea: una fecha puesta A MANO no se toca', async () => {
  const ll = apiFalsa(rutasMover('2026-11-05', '2026-12-31T08:00:00Z'));
  const a = await adaptador();
  await correr(a.cmdMoverTarea, ['mover-tarea', '42', '--fase', 'backlog']);
  assert.strictEqual(ll.filter((c) => /issue-field-values/.test(c.ruta) && c.metodo !== 'GET').length, 0);
});

test('mover-tarea a un hito SIN fecha: la heredada se quita (DELETE, nunca un POST vacio)', async () => {
  const ll = apiFalsa(rutasMover('2026-10-31', null));
  const a = await adaptador();
  const r = await correr(a.cmdMoverTarea, ['mover-tarea', '42', '--fase', 'backlog']);
  assert.match(r.out, /Target date: quitada/, r.out);
  assert.ok(ll.some((c) => c.metodo === 'DELETE' && c.ruta === 'repos/org/repo/issues/42/issue-field-values/13'));
  assert.strictEqual(posts(ll, /issue-field-values$/).length, 0);
});

// ---------- campos-tarea ----------

test('campos-tarea sin numero: lista los campos de la organizacion y a que campo va cada atajo', async () => {
  apiFalsa([CAMPOS_ORG]);
  const a = await adaptador();
  const r = await correr(a.cmdCamposTarea, ['campos-tarea']);
  assert.match(r.out, /Priority \(single_select\) — Urgent · High · Medium · Low/, r.out);
  assert.match(r.out, /--fecha-objetivo -> Target date/);
});

test('campos-tarea <N>: muestra los valores con el nombre del campo', async () => {
  apiFalsa([CAMPOS_ORG, R(/^repos\/org\/repo\/issues\/42\/issue-field-values\?/, () => ({ status: 200, body: [{ issue_field_id: 13, value: '2026-12-31' }, { issue_field_id: 11, single_select_option: { name: 'High' } }] }))]);
  const a = await adaptador();
  const r = await correr(a.cmdCamposTarea, ['campos-tarea', '42']);
  assert.match(r.out, /Target date: 2026-12-31/, r.out);
  assert.match(r.out, /Priority: High/);
});

test('campos-tarea <N> --campo / --quitar: fija y quita', async () => {
  const ll = apiFalsa([CAMPOS_ORG, ESCRIBIR, R(/^repos\/org\/repo\/issues\/42\/issue-field-values\/12$/, () => ({ status: 204, body: {} }), 'DELETE')]);
  const a = await adaptador();
  const r = await correr(a.cmdCamposTarea, ['campos-tarea', '42', '--campo', 'Effort=l', '--quitar', 'inicio']);
  assert.match(r.out, /Effort = L/, r.out);
  assert.match(r.out, /'Start date' sin valor/);
  assert.deepStrictEqual(posts(ll, /issue-field-values$/)[0].body, { issue_field_values: [{ field_id: 14, value: 'L' }] });
  assert.ok(ll.some((c) => c.metodo === 'DELETE' && /issue-field-values\/12$/.test(c.ruta)));
});
