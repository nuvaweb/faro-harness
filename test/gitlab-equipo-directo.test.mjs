// El EQUIPO de un proyecto son sus miembros DIRECTOS (0.22.0). Antes se leia '/members/all', que trae
// tambien a quien HEREDA acceso del grupo: en el repo real, 13 personas ajenas al proyecto que salian
// como asignables y como posibles revisores. En proceso con API simulada: determinista, sin red.
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
    const u = String(url).replace('https://gitlab.com/api/v4/', ''); const metodo = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null; llamadas.push({ metodo, ruta: u, body });
    for (const [re, fn] of rutas) { const m = u.match(re); if (m && (!fn.metodo || fn.metodo === metodo)) { const r = fn.resp(m, body); return { ok: r.status < 400, status: r.status, json: async () => r.body }; } }
    return { ok: false, status: 404, json: async () => ({ message: '404 ' + u }) };
  };
  return llamadas;
}
const R = (re, resp, metodo) => [re, { resp, metodo }];
async function adaptador(schema = {}) {
  const mod = await import(`file://${path.join(HOOKS, 'lib', 'forge-gitlab.js').replace(/\\/g, '/')}`);
  const home = tmp('home'); process.env.FARO_CONFIG_PATH = path.join(home, '.faro.json');
  return mod.default({ ROOT: tmp('root'), git: () => '', specBase: 'gestion/cambios',
    forge: () => ({ forge: 'gitlab', host: 'gitlab.com', owner: 'g', project: 'p', path: 'g/p' }),
    tokenPara: () => 'tok', guardarToken: () => {}, faroSchema: () => ({ enums: { labels: [{ slug: 'bug', color: 'D73A4A' }] }, ...schema }),
    fases: () => [], isDone: () => false, isActive: () => false });
}
async function correr(fn, argv) {
  const out = []; const log = console.log; const exit = process.exit; let codigo = null;
  console.log = (...a) => out.push(a.join(' ')); process.exit = (c) => { codigo = c; throw new Error('__exit__'); };
  if (argv) process.argv = ['node', 'harness.js', ...argv];
  try { await fn(); } catch (e) { if (e.message !== '__exit__') throw e; } finally { console.log = log; process.exit = exit; }
  return { out: out.join('\n'), codigo };
}
// Caso real: ningun humano directo (solo un bot) y 13 heredados del grupo.
const BOT = { id: 99, username: 'group_140_bot_abc', name: 'bot', access_level: 10 };
const HEREDADOS = [
  { id: 1, username: 'Iborra', name: 'I', access_level: 50 },
  { id: 2, username: 'miguel.lopezm-x', name: 'M', access_level: 40 },
  { id: 3, username: 'usuario-gitlab', name: 'R', access_level: 30 },
];
const rutas = (directos) => [
  R(/^projects\/g%2Fp\/members\?/, () => ({ status: 200, body: directos })),
  R(/^projects\/g%2Fp\/members\/all\?query=/, (m) => ({ status: 200, body: [...directos, ...HEREDADOS].filter((x) => x.username.toLowerCase().includes(decodeURIComponent(m.input.split('query=')[1]).toLowerCase())) })),
  R(/^projects\/g%2Fp\/members\/all\?/, () => ({ status: 200, body: [...directos, ...HEREDADOS] })),
];

test('equipo: solo cuenta a los DIRECTOS; los heredados se listan aparte y se dice que no son el equipo', async () => {
  apiFalsa(rutas([BOT]));
  const a = await adaptador();
  const r = await correr(a.cmdEquipo);
  assert.match(r.out, /miembros DIRECTOS \(0\)/, r.out);
  assert.match(r.out, /ninguno todavia/);
  assert.match(r.out, /Con acceso HEREDADO del grupo \(3\)/);
  assert.match(r.out, /NO son el equipo/);
  assert.match(r.out, /1 cuenta\(s\) de servicio directas/, 'el bot no cuenta como equipo');
});

test('approvers: con Maintainer DIRECTO manda el criterio fino (los heredados NO entran)', async () => {
  apiFalsa(rutas([BOT, { id: 5, username: 'ana', name: 'Ana', access_level: 40 }]));
  const a = await adaptador();
  const i = await a.approversInfo();
  assert.deepStrictEqual(i.logins, ['ana'], 'solo el Maintainer directo');
  assert.strictEqual(i.via, 'directos');
});

test('approvers: SIN directos cae a los OWNERS heredados — imprescindible si la organizacion bloquea la pertenencia', async () => {
  // Caso real (ACME): 'membership_lock' en un grupo ancestro -> nadie puede ser miembro directo JAMAS.
  // Con el criterio fino a secas, todos los repos se quedarian sin un solo aprobador posible.
  apiFalsa(rutas([BOT]));
  const a = await adaptador();
  const i = await a.approversInfo();
  assert.deepStrictEqual(i.logins, ['Iborra'], 'el Owner heredado');
  assert.strictEqual(i.via, 'owners-heredados');
  assert.ok(!i.logins.includes('group_140_bot_abc'), 'un bot nunca aprueba');
});

test('approvers: sin directos y sin owners, cae a los MAINTAINERS heredados', async () => {
  const sinOwners = HEREDADOS.filter((h) => h.access_level < 50);
  apiFalsa([
    R(/^projects\/g%2Fp\/members\?/, () => ({ status: 200, body: [BOT] })),
    R(/^projects\/g%2Fp\/members\/all\?/, () => ({ status: 200, body: [BOT, ...sinOwners] })),
  ]);
  const a = await adaptador();
  const i = await a.approversInfo();
  assert.deepStrictEqual(i.logins, ['miguel.lopezm-x']);
  assert.strictEqual(i.via, 'maintainers-heredados');
});

test('approvers: si no hay nadie con nivel suficiente, la lista sale vacia y se dice', async () => {
  apiFalsa([
    R(/^projects\/g%2Fp\/members\?/, () => ({ status: 200, body: [BOT] })),
    R(/^projects\/g%2Fp\/members\/all\?/, () => ({ status: 200, body: [BOT, { id: 9, username: 'dev', name: 'D', access_level: 30 }] })),
  ]);
  const a = await adaptador();
  const i = await a.approversInfo();
  assert.deepStrictEqual(i.logins, []); assert.strictEqual(i.via, 'nadie');
});

test('asignar-tarea: a un HEREDADO se niega y dice como incorporarlo al equipo', async () => {
  const ll = apiFalsa(rutas([BOT]));
  const a = await adaptador();
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'T', 'miguel.lopezm-x', '--tipo', 'bug']);
  assert.match(r.out, /tiene acceso HEREDADO .*NO es del equipo/s, r.out);
  assert.match(r.out, /miembro anadir miguel\.lopezm-x developer/);
  assert.ok(!ll.some((c) => c.metodo === 'POST' && /issues$/.test(c.ruta)), 'no debe crear la tarea');
});

test('asignar-tarea: a un DIRECTO del equipo si se asigna', async () => {
  const ll = apiFalsa([...rutas([BOT, { id: 5, username: 'ana', name: 'Ana', access_level: 30 }]),
    R(/^projects\/g%2Fp\/labels\?/, () => ({ status: 200, body: [] })),
    R(/^projects\/g%2Fp\/labels$/, (_m, b) => ({ status: 201, body: { name: b.name } }), 'POST'),
    R(/^projects\/g%2Fp\/issues$/, () => ({ status: 201, body: { iid: 5, web_url: 'u' } }), 'POST')]);
  const a = await adaptador();
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'T', 'ana', '--tipo', 'bug']);
  assert.match(r.out, /Tarea #5 asignada a ana/, r.out);
  assert.strictEqual(ll.find((c) => c.metodo === 'POST' && /issues$/.test(c.ruta)).body.assignee_ids[0], 5);
});

test('miembro anadir: incorpora a un heredado al equipo y RELEE para confirmar el nivel', async () => {
  const directos = [BOT];
  const ll = apiFalsa([...rutas(directos),
    R(/^projects\/g%2Fp\/members$/, (_m, b) => { directos.push({ id: b.user_id, username: 'miguel.lopezm-x', name: 'M', access_level: b.access_level }); return { status: 201, body: {} }; }, 'POST')]);
  const a = await adaptador();
  const r = await correr(a.cmdMiembro, ['miembro', 'anadir', 'miguel.lopezm-x', 'maintainer']);
  assert.match(r.out, /miembro DIRECTO .* como maintainer \(40\)/, r.out);
  assert.match(r.out, /cuenta como aprobador/);
  assert.strictEqual(ll.find((c) => c.metodo === 'POST').body.access_level, 40);
});

test('miembro anadir: rol invalido se rechaza SIN tocar la API', async () => {
  const ll = apiFalsa(rutas([BOT]));
  const a = await adaptador();
  const r = await correr(a.cmdMiembro, ['miembro', 'anadir', 'ana', 'jefe']);
  assert.strictEqual(r.codigo, 1); assert.match(r.out, /Rol invalido/);
  assert.ok(!ll.some((c) => c.metodo === 'POST'));
});

test('miembro quitar: a un HEREDADO no se le puede quitar desde el proyecto, y se explica', async () => {
  apiFalsa(rutas([BOT]));
  const a = await adaptador();
  const r = await correr(a.cmdMiembro, ['miembro', 'quitar', 'Iborra']);
  assert.strictEqual(r.codigo, 1);
  assert.match(r.out, /no es miembro DIRECTO/); assert.match(r.out, /no se quita desde aqui/);
});

test('atomicidad: ningun modulo del adaptador supera las 400 lineas', () => {
  for (const f of ['forge-gitlab.js', 'forge-gitlab-equipo.js', 'forge-gitlab-gestion.js', 'forge-gitlab-proyecto.js']) {
    const n = fs.readFileSync(path.join(HOOKS, 'lib', f), 'utf8').split('\n').length;
    assert.ok(n <= 400, `${f}: ${n} lineas`);
  }
});
