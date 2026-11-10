// Abrir lista lo que la forja da a la cuenta, en cualquier dueño: primero lo FARO, con «Ver todos».
import test from 'node:test';
import assert from 'node:assert/strict';
import { elegirDeLista, elegirRepoCuenta } from '../bin/flows/abrir.mjs';
import { FORJA_GITHUB, reposDelDestino } from '../bin/lib/forjas/github.mjs';
import { FORJA_GITLAB } from '../bin/lib/forjas/gitlab.mjs';

const json = (status, cuerpo) => new Response(JSON.stringify(cuerpo), { status });
const faro = { ruta: 'ana/faro-uno', nombre: 'faro-uno', topics: ['faro'], pushed_at: null };
const compartido = { ruta: 'ajena/app', nombre: 'app', topics: [], pushed_at: null };

// Responde a cada menú con lo que diga `guion` y anota las claves que se ofrecieron.
function menu(...guion) {
  const vistos = [];
  return { vistos, elige: async (_t, ops) => { vistos.push(Object.keys(ops)); return guion.shift(); } };
}

test('accesibles en GitHub: pide todo lo de la cuenta, compartido incluido, y deja fuera las plantillas', async () => {
  const pedidas = [];
  const f = async (u) => {
    pedidas.push(String(u));
    return json(200, [
      { full_name: 'ana/faro-uno', name: 'faro-uno', topics: ['faro'], pushed_at: 'x' },
      { full_name: 'ajena/app', name: 'app', topics: [] },
      { full_name: 'ana/molde', name: 'molde', is_template: true },
    ]);
  };
  const r = await FORJA_GITHUB.alta.accesibles({ host: 'github.com', token: 't' }, { fetchImpl: f });
  assert.deepEqual(r.map((x) => x.ruta), ['ana/faro-uno', 'ajena/app']);
  assert.equal(r[0].nombre, 'faro-uno');
  assert.match(pedidas[0], /^https:\/\/api\.github\.com\/user\/repos\?/);
  assert.match(pedidas[0], /affiliation=owner,collaborator,organization_member/);
});

test('accesibles en GitLab: pide los proyectos de los que la cuenta es miembro y recorre las páginas', async () => {
  const pedidas = [];
  const pagina = (n) => Array.from({ length: n }, (_, i) => ({ path: `p${i}`, path_with_namespace: `g/sub/p${i}`, topics: ['faro'], last_activity_at: 'x' }));
  const f = async (u) => { pedidas.push(String(u)); return json(200, /page=1\b/.test(String(u)) ? pagina(100) : pagina(3)); };
  const r = await FORJA_GITLAB.alta.accesibles({ host: 'gitlab.com', token: 't' }, { fetchImpl: f });
  assert.equal(r.length, 103);
  assert.deepEqual(r[0], { ruta: 'g/sub/p0', nombre: 'p0', topics: ['faro'], pushed_at: 'x' });
  assert.match(pedidas[0], /\/projects\?membership=true/);
  assert.equal(pedidas.length, 2);
});

test('elegirDeLista: enseña primero lo FARO y «Ver todos» abre el resto', async () => {
  const m = menu('__todos', 'ajena/app');
  const r = await elegirDeLista([compartido, faro], 'Elige', m);
  assert.equal(r, 'ajena/app');
  assert.deepEqual(m.vistos[0], ['ana/faro-uno', '__todos', '__buscar']);
  assert.deepEqual(m.vistos[1], ['ajena/app', 'ana/faro-uno', '__buscar']);
});

test('elegirDeLista: sin repos FARO enseña todos y no ofrece «Ver todos»', async () => {
  const m = menu('ajena/app');
  await elegirDeLista([compartido], 'Elige', m);
  assert.deepEqual(m.vistos[0], ['ajena/app', '__buscar']);
});

test('elegirDeLista: la búsqueda alcanza también lo que no es FARO', async () => {
  const m = { ...menu('__buscar', 'ajena/app'), pregunta: async () => 'APP' };
  assert.equal(await elegirDeLista([faro, compartido], 'Elige', m), 'ajena/app');
  assert.deepEqual(m.vistos[1], ['ajena/app']);
});

test('reposDelDestino: en cuenta personal lee /user/repos y se queda con lo suyo; en una org, /orgs', async () => {
  const pedidas = [];
  const f = async (u) => { pedidas.push(String(u)); return json(200, [{ name: 'a', owner: { login: 'ana' }, topics: ['faro'] }, { name: 'b', owner: { login: 'ajena' }, topics: ['faro'] }]); };
  const s = { host: 'github.com', token: 't' };
  assert.deepEqual((await reposDelDestino(s, { org: 'ana', personal: true }, { fetchImpl: f })).map((r) => r.name), ['a']);
  assert.match(pedidas[0], /\/user\/repos\?/);
  assert.equal((await reposDelDestino(s, { org: 'acme', personal: false }, { fetchImpl: f })).length, 2);
  assert.match(pedidas[1], /\/orgs\/acme\/repos\?/);
});

test('elegirRepoCuenta lista con la sesión activa y ofrece crear si la cuenta no tiene repos', async () => {
  const pedidas = [];
  const ctx = (repos) => ({ perfil: { host: 'h.test' }, auth: { token: 't' }, forja: { alta: { accesibles: async (s) => { pedidas.push(s); return repos; } } } });
  assert.equal(await elegirRepoCuenta(ctx([]), 'T', { confirma: async () => true }), '__crear');
  assert.equal(await elegirRepoCuenta(ctx([]), 'T', { confirma: async () => false }), null);
  assert.equal(await elegirRepoCuenta(ctx([{ ruta: 'a/b', nombre: 'b', topics: [] }]), 'T', { elige: async (_, ops) => Object.keys(ops)[0] }), 'a/b');
  assert.deepEqual(pedidas[0], { host: 'h.test', token: 't' });
});
