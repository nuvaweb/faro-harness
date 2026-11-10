// PLANIFICADOR EXTERNO (#218, #277): FARO lee de la forja como organiza el repo la herramienta de
// planificacion que se declare (.faro.json > planificacion.prefijo) y no escribe nada. El planificador
// deja el proyecto en la propiedad '<prefijo>_id' (GitHub) o en el topic '<prefijo>-PRJ-x' (GitLab) y
// la epica en la descripcion del milestone ('<prefijo>:epica=EPI-n · titulo'). Los dos se encuentran
// en el milestone: no hay API ni token entre FARO y el planificador.
//
// lib/planificacion.js es DOMINIO puro (hexagonal): recibe la configuracion y la forja como puerto.
// Aqui la forja es una funcion falsa: {ok,status,body,sinToken}. Las pruebas usan el prefijo 'plan'.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const PL = createRequire(import.meta.url)(path.join(HOOKS, 'lib', 'planificacion.js'));
const AV = PL.crear({ prefijo: 'plan', nombre: 'Plan' });

const GH = { forge: 'github', owner: 'org', project: 'repo', path: 'org/repo' };
const GL = { forge: 'gitlab', owner: 'grupo', project: 'repo', path: 'grupo/repo' };
const ok = (body) => ({ ok: true, status: 200, body });
const no = (status) => ({ ok: false, status, body: { message: 'x' } });
const ms = (title, extra = {}) => ({ number: extra.number || 1, title, state: 'open', due_on: '2026-11-30T07:00:00Z', open_issues: 2, closed_issues: 3, description: '', ...extra });

// Forja falsa: ruta -> respuesta. Cuenta las llamadas y guarda los metodos (FARO solo LEE).
function forja(rutas) {
  const llamadas = [];
  const api = async (p, opts = {}) => {
    llamadas.push({ ruta: p, metodo: (opts.method || 'GET').toUpperCase() });
    for (const [re, r] of rutas) if (re.test(p)) return typeof r === 'function' ? r(p) : r;
    return no(404);
  };
  return { api, llamadas };
}
const github = (props, milestones) => forja([
  [/properties\/values/, props],
  [/milestones/, ok(milestones)],
]);
const texto = (rel) => AV.pintar(rel).join('\n');

test('marca: id EPI-n con titulo opcional y sin distinguir mayusculas, como la lee Plan', () => {
  assert.deepStrictEqual(AV.leerMarca('Objetivo\n\nplan:epica=EPI-3 · Portal clientes'), { id: 'EPI-3', titulo: 'Portal clientes' });
  assert.deepStrictEqual(AV.leerMarca('plan:epica=EPI-12'), { id: 'EPI-12', titulo: '' });
  assert.deepStrictEqual(AV.leerMarca('PLAN:EPICA=epi-7 · X'), { id: 'EPI-7', titulo: 'X' });
  assert.strictEqual(AV.leerMarca('sin marca'), null);
  assert.strictEqual(AV.leerMarca(null), null);
});

test('(1) proyecto con milestones marcados: proyecto -> epica -> milestones con fecha y avance', async () => {
  const { api } = github(ok([{ property_name: 'plan_id', value: 'PRJ-0001' }]), [
    ms('1.2', { description: 'Objetivo\nplan:epica=EPI-3 · Portal' }),
    ms('1.3', { number: 2, description: 'plan:epica=EPI-3 · Portal', due_on: '2026-12-15T07:00:00Z', open_issues: 4, closed_issues: 0 }),
  ]);
  const rel = await AV.leerRelacion(api, GH);
  assert.strictEqual(rel.proyecto, 'PRJ-0001');
  assert.strictEqual(rel.epicas.length, 1);
  assert.deepStrictEqual(rel.epicas[0].milestones.map((m) => [m.titulo, m.fecha, m.cerrados, m.abiertos]), [['1.2', '2026-11-30', 3, 2], ['1.3', '2026-12-15', 0, 4]]);
  const t = texto(rel);
  assert.match(t, /PRJ-0001/);
  assert.match(t, /EPI-3 · Portal/);
  assert.match(t, /1\.2.*2026-11-30.*3\/5/);
  assert.doesNotMatch(t, /sin épica/i);
});

test('(2) proyecto sin ninguna marca: no es un error, pide asignarlos en Plan', async () => {
  const { api } = github(ok([{ property_name: 'plan_id', value: 'PRJ-0001' }]), [ms('1.2'), ms('1.3', { number: 2 })]);
  const rel = await AV.leerRelacion(api, GH);
  assert.strictEqual(rel.error, null);
  assert.strictEqual(rel.epicas.length, 0);
  assert.match(texto(rel), /Proyecto PRJ-0001, milestones sin épica: asígnalos en Plan/);
});

test('(3) marcados y sin marcar: agrupa por epica y lista aparte los sin epica', async () => {
  const { api } = github(ok([{ property_name: 'plan_id', value: 'PRJ-0001' }]), [
    ms('1.2', { description: 'plan:epica=EPI-3 · Portal' }),
    ms('Backlog', { number: 2, due_on: null }),
  ]);
  const rel = await AV.leerRelacion(api, GH);
  assert.deepStrictEqual(rel.sinEpica.map((m) => m.titulo), ['Backlog']);
  assert.match(texto(rel), /Sin épica: Backlog/);
});

test('(4) ni proyecto ni marcas: el repo no esta en Plan, sin error', async () => {
  const { api } = github(ok([{ property_name: 'plan_id', value: null }]), [ms('1.2')]);
  const rel = await AV.leerRelacion(api, GH);
  assert.strictEqual(rel.error, null);
  const t = texto(rel);
  assert.match(t, /Este repo no está en Plan \(no se ha creado o asociado el proyecto\)/);
  assert.strictEqual(t.split('no está en Plan').length - 1, 1, 'lo dice una sola vez');
});

test('(5) marcas sin proyecto: pinta las epicas y avisa de que el proyecto no esta fijado', async () => {
  const { api } = github(ok([{ property_name: 'plan_id', value: '' }]), [ms('1.2', { description: 'plan:epica=EPI-3 · Portal' })]);
  const rel = await AV.leerRelacion(api, GH);
  const t = texto(rel);
  assert.match(t, /EPI-3 · Portal/);
  assert.match(t, /proyecto no está fijado en el repo/);
});

for (const status of [404, 422]) {
  test(`(6) la organizacion no define la propiedad (${status}): como el 4 y lo dice una vez`, async () => {
    const { api } = github(no(status), [ms('1.2')]);
    const rel = await AV.leerRelacion(api, GH);
    assert.strictEqual(rel.error, null);
    const t = texto(rel);
    assert.match(t, /no está en Plan/);
    assert.strictEqual(t.split('la organización no tiene la propiedad plan_id').length - 1, 1);
  });
}

test('(6b) la propiedad no aparece entre las de la organizacion: igual que 404', async () => {
  const { api } = github(ok([{ property_name: 'otra', value: 'x' }]), [ms('1.2')]);
  assert.match(texto(await AV.leerRelacion(api, GH)), /la organización no tiene la propiedad plan_id/);
});

test('(7) milestone marcado sin fecha: "sin fecha", no se inventa', async () => {
  const { api } = github(ok([{ property_name: 'plan_id', value: 'PRJ-0001' }]), [ms('1.2', { due_on: null, description: 'plan:epica=EPI-3' })]);
  const rel = await AV.leerRelacion(api, GH);
  assert.strictEqual(rel.epicas[0].milestones[0].fecha, null);
  assert.match(texto(rel), /1\.2 · sin fecha/);
});

test('(8) milestone marcado y cerrado: cerrado con su avance final y no cuenta como pendiente', async () => {
  const { api } = github(ok([{ property_name: 'plan_id', value: 'PRJ-0001' }]), [
    ms('1.1', { state: 'closed', open_issues: 0, closed_issues: 5, description: 'plan:epica=EPI-3 · Portal' }),
    ms('1.2', { number: 2, description: 'plan:epica=EPI-3 · Portal' }),
  ]);
  const rel = await AV.leerRelacion(api, GH);
  assert.strictEqual(rel.epicas[0].pendientes, 1);
  assert.match(texto(rel), /1\.1 · cerrado · 5\/5/);
});

test('(9) marca mal escrita: el milestone sale sin epica y el aviso cita la linea', async () => {
  const { api } = github(ok([{ property_name: 'plan_id', value: 'PRJ-0001' }]), [ms('1.4', { description: 'Objetivo\nplan:epica=Epica 7 · Portal' })]);
  const rel = await AV.leerRelacion(api, GH);
  assert.deepStrictEqual(rel.sinEpica.map((m) => m.titulo), ['1.4']);
  assert.match(texto(rel), /1\.4.*plan:epica=Epica 7 · Portal/);
});

test('(10) GitLab: proyecto del topic plan-PRJ y la misma marca, con fechas de inicio y fin', async () => {
  const { api } = forja([
    [/^projects\/[^/]+$/, ok({ topics: ['web', 'plan-PRJ-0002'] })],
    [/issues_statistics/, ok({ statistics: { counts: { opened: 1, closed: 4 } } })],
    [/milestones/, ok([{ iid: 1, id: 9, title: 'Sprint 4', state: 'active', start_date: '2026-11-01', due_date: '2026-11-15', description: 'plan:epica=EPI-5 · Pagos' }])],
  ]);
  const rel = await AV.leerRelacion(api, GL);
  assert.strictEqual(rel.proyecto, 'PRJ-0002');
  const m = rel.epicas[0].milestones[0];
  assert.deepStrictEqual([m.titulo, m.inicio, m.fecha, m.cerrados, m.abiertos], ['Sprint 4', '2026-11-01', '2026-11-15', 4, 1]);
});

test('(10b) GitLab sin topic ni marcas: como el escenario 4', async () => {
  const { api } = forja([
    [/^projects\/[^/]+$/, ok({ topics: [] })],
    [/issues_statistics/, ok({ statistics: { counts: { opened: 0, closed: 0 } } })],
    [/milestones/, ok([{ iid: 1, id: 9, title: 'Fase 1', state: 'active', description: '' }])],
  ]);
  assert.match(texto(await AV.leerRelacion(api, GL)), /no está en Plan/);
});

test('(11) sin token o sin permiso: no lanza, solo el aviso con el motivo', async () => {
  const sinToken = forja([[/./, { ok: false, status: 0, body: null, sinToken: true }]]);
  const r1 = await AV.leerRelacion(sinToken.api, GH);
  assert.match(texto(r1), /No se pudo leer la relación con Plan \(.*token.*\)/);
  const prohibido = github(no(403), []);
  const r2 = await AV.leerRelacion(prohibido.api, GH);
  assert.match(texto(r2), /No se pudo leer la relación con Plan \(.*403.*\)/);
  const caido = forja([[/./, () => { throw new Error('ECONNRESET'); }]]);
  assert.match(texto(await AV.leerRelacion(caido.api, GH)), /No se pudo leer la relación con Plan/);
});

test('(12) una sola lectura del repo: el monorepo comparte el proyecto entre sus apps', async () => {
  const f = github(ok([{ property_name: 'plan_id', value: 'PRJ-0001' }]), [ms('1.2', { description: 'plan:epica=EPI-3' })]);
  await AV.leerRelacion(f.api, GH);
  assert.strictEqual(f.llamadas.filter((l) => /properties/.test(l.ruta)).length, 1);
  assert.strictEqual(f.llamadas.filter((l) => /milestones/.test(l.ruta)).length, 1);
});

test('FARO no escribe el chivato: el lector solo hace GET y ningun modulo escribe la propiedad ni la marca', async () => {
  const f = github(ok([{ property_name: 'plan_id', value: 'PRJ-0001' }]), [ms('1.2', { description: 'plan:epica=EPI-3' })]);
  await AV.leerRelacion(f.api, GH);
  assert.ok(f.llamadas.every((l) => l.metodo === 'GET'));
  const fuentes = [path.join(HOOKS, 'harness.js'), ...fs.readdirSync(path.join(HOOKS, 'lib')).map((n) => path.join(HOOKS, 'lib', n))].filter((p) => p.endsWith('.js'));
  for (const p of fuentes) {
    const s = fs.readFileSync(p, 'utf8');
    assert.doesNotMatch(s, /properties\/values['"`][^\n]*(PATCH|POST|PUT)/, `${path.basename(p)} escribe properties/values`);
    if (!p.endsWith('planificacion.js')) assert.doesNotMatch(s, /:epica=/, `${path.basename(p)} toca la marca de epica`);
  }
});

test('epicaDe y resumen corto: la epica de un milestone por su titulo y una linea para el arranque', async () => {
  const { api } = github(ok([{ property_name: 'plan_id', value: 'PRJ-0001' }]), [ms('1.2', { description: 'plan:epica=EPI-3 · Portal' }), ms('1.3', { number: 2 })]);
  const rel = await AV.leerRelacion(api, GH);
  assert.deepStrictEqual(AV.epicaDe(rel, '1.2'), { id: 'EPI-3', titulo: 'Portal' });
  assert.strictEqual(AV.epicaDe(rel, '1.3'), null);
  assert.strictEqual(AV.epicaDe(null, '1.2'), null);
  const r = AV.resumenCorto(rel);
  assert.match(r, /PRJ-0001/);
  assert.match(r, /EPI-3 · Portal/);
  assert.match(r, /1 milestone\(s\) sin épica/);
});

// US-2: la epica en el flujo de tareas. La forja ya devuelve el milestone completo dentro del issue
// (con su descripcion), asi que se lee de ahi: ninguna llamada nueva.
test('epica visible: textoEpica lee la marca del milestone del issue', () => {
  assert.strictEqual(AV.textoEpica({ title: '1.2', description: 'Entrega\nplan:epica=EPI-3 · Portal' }), 'EPI-3 · Portal');
  assert.strictEqual(AV.textoEpica({ title: '1.2', description: 'plan:epica=epi-7' }), 'EPI-7');
  assert.strictEqual(AV.textoEpica({ title: '1.3', description: 'sin marca' }), '');
  assert.strictEqual(AV.textoEpica(null), '');
});

test('epica visible: asignar-tarea (GitHub y GitLab), mover-tarea y consolidar la muestran', () => {
  const lee = (f) => fs.readFileSync(path.join(HOOKS, f), 'utf8');
  for (const f of ['lib/github-tareas.js', 'lib/forge-gitlab.js', 'lib/forge-gitlab-tareas.js', 'harness.js']) assert.match(lee(f), /planificacion\.lineaEpica\(|pl\.lineaEpica\(/, `${f} no muestra la epica`);
  assert.ok((lee('lib/github-tareas.js').match(/lineaEpica\(/g) || []).length >= 2, 'asignar-tarea y mover-tarea en GitHub');
});

// US-3: ClickUp sale del plugin. El planificador habla con su gestor; FARO no lleva cliente, skill ni agente.
test('el plugin no lleva ClickUp ni la gestion de proyectos (#218)', () => {
  const PLUGIN = path.join(HOOKS, '..');
  for (const f of ['hooks/lib/clickup.js', 'hooks/lib/epica.js', 'hooks/lib/pm.js', 'skills/clickup', 'agents/gestor-clickup.md']) {
    assert.ok(!fs.existsSync(path.join(PLUGIN, f)), `${f} sigue en el plugin`);
  }
  const src = fs.readFileSync(path.join(HOOKS, 'harness.js'), 'utf8');
  assert.doesNotMatch(src, /cmd === 'clickup'|cmdClickUp|pushGestorSiProcede|CLICKUP_API_KEY/);
  assert.match(src, /cmd === 'planificacion'/);
  assert.doesNotMatch(src, new RegExp(['ava', 'lon'].join(''), 'i'), 'el motor no nombra ningun planificador concreto');
});

// #277: el planificador es GENERICO y se declara; el dominio no lee configuracion por su cuenta.
test('sin planificador declarado no hay planificador: crear(null) y prefijos invalidos dan null', () => {
  assert.strictEqual(PL.crear(null), null);
  assert.strictEqual(PL.crear({}), null);
  for (const prefijo of ['', 'Con Espacio', '1abc', 'a'.repeat(30), 'x:y', 42]) assert.strictEqual(PL.crear({ prefijo }), null, String(prefijo));
});

test('el prefijo declarado manda: otra herramienta lee SUS marcas y no las de otro prefijo', async () => {
  const otro = PL.crear({ prefijo: 'roadmap' });
  assert.strictEqual(otro.nombre, 'Roadmap', 'sin nombre, el prefijo capitalizado');
  assert.strictEqual(otro.PROPIEDAD, 'roadmap_id');
  assert.deepStrictEqual(otro.leerMarca('roadmap:epica=EP-4 · Web'), { id: 'EP-4', titulo: 'Web' });
  assert.strictEqual(otro.leerMarca('plan:epica=EPI-4 · Web'), null);
  const { api } = github(ok([{ property_name: 'roadmap_id', value: 'PRJ-9' }]), [ms('2.0', { description: 'roadmap:epica=EP-4 · Web' })]);
  const rel = await otro.leerRelacion(api, GH);
  assert.strictEqual(rel.proyecto, 'PRJ-9');
  assert.match(otro.pintar(rel).join('\n'), /^Roadmap · proyecto PRJ-9/);
  assert.strictEqual(otro.lineaEpica({ description: 'roadmap:epica=EP-4 · Web' }), 'Épica de Roadmap: EP-4 · Web.');
});

test('nombre con caracteres raros se ignora y vuelve al prefijo: nada de texto libre en la sesion', () => {
  assert.strictEqual(PL.crear({ prefijo: 'plan', nombre: 'x<script>' }).nombre, 'Plan');
  assert.strictEqual(PL.crear({ prefijo: 'plan', nombre: 'Mi Plan 2' }).nombre, 'Mi Plan 2');
});

test('hexagonal: el dominio no importa infraestructura y los adaptadores no lo construyen', () => {
  const dom = fs.readFileSync(path.join(HOOKS, 'lib', 'planificacion.js'), 'utf8');
  assert.doesNotMatch(dom, /require\(/, 'el dominio no importa nada');
  assert.doesNotMatch(dom, /process\.|fs\.|readFileSync|fetch\(/, 'el dominio no toca entorno, ficheros ni red');
  for (const f of ['lib/github.js', 'lib/github-tareas.js', 'lib/forge-gitlab.js', 'lib/forge-gitlab-tareas.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(HOOKS, f), 'utf8'), /planificacion\.js/, `${f} construye el dominio: debe recibirlo por ctx`);
  }
  const h = fs.readFileSync(path.join(HOOKS, 'harness.js'), 'utf8');
  assert.match(h, /require\('\.\/lib\/planificacion\.js'\)\.crear\(cfg\)/, 'el cableado lo construye con la configuracion resuelta');
  assert.match(h, /planificacion: planificacion\(\)/, 'y lo inyecta en los adaptadores');
});
