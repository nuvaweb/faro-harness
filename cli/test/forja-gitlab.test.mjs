import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pid, deviceFlow, scopesToken, miembroDe, rolEn, repos, login, renovar, subgrupos, crearSubgrupo, anadirMiembro, FORJA_GITLAB } from '../bin/lib/forjas/gitlab.mjs';
import { PERFILES } from '../bin/lib/perfil.mjs';

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body), headers: new Map() });

test('pid codifica la ruta completa con subgrupos', () => {
  assert.equal(pid('Acme/plataforma/equipo/faro/plugin'), 'Acme%2Fplataforma%2Fequipo%2Ffaro%2Fplugin');
});

test('deviceFlow: slow_down suma 5s y termina con access_token + refresh + expira', async () => {
  const llamadas = []; const esperas = [];
  const fetchImpl = async (url) => {
    llamadas.push(url);
    if (url.endsWith('/oauth/authorize_device')) return json(200, { device_code: 'D', user_code: 'ABCD', verification_uri: 'https://gitlab.com/oauth/device', verification_uri_complete: 'https://gitlab.com/oauth/device?user_code=ABCD', expires_in: 300, interval: 5 });
    if (llamadas.filter((u) => u.endsWith('/oauth/token')).length === 1) return json(400, { error: 'slow_down' });
    return json(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 7200, created_at: 1 });
  };
  let mostrado = null;
  const r = await deviceFlow('gitlab.com', 'CID', { fetchImpl, esperar: async (ms) => esperas.push(ms), ui: { mostrar: (d) => { mostrado = d; } }, ahora: () => 0 });
  assert.equal(r.token, 'AT'); assert.equal(r.refresh_token, 'RT'); assert.equal(r.expira, 7200 * 1000);
  assert.deepEqual(esperas, [5000, 10000], 'tras slow_down el intervalo pasa de 5 a 10 s');
  assert.equal(mostrado.user_code, 'ABCD');
});

test('deviceFlow: sin device_code explica app sin device grant o confidencial; caducidad corta el bucle', async () => {
  await assert.rejects(() => deviceFlow('gitlab.com', 'CID', { fetchImpl: async () => json(401, { error: 'invalid_client' }), ui: { mostrar: () => {} } }), /Device authorization grant|confidencial/);
  let t = 0;
  const f = async (url) => (url.endsWith('/oauth/authorize_device') ? json(200, { device_code: 'D', user_code: 'X', verification_uri: 'u', expires_in: 10, interval: 5 }) : json(400, { error: 'authorization_pending' }));
  await assert.rejects(() => deviceFlow('gitlab.com', 'CID', { fetchImpl: f, esperar: async () => { t += 6000; }, ui: { mostrar: () => {} }, ahora: () => t }), /caducó/);
});

test('scopesToken: PAT -> scopes reales; token OAuth (404 en self) -> api si user responde', async () => {
  const pat = async (u) => (u.endsWith('personal_access_tokens/self') ? json(200, { scopes: ['read_api'] }) : json(200, { username: 'ana' }));
  assert.deepEqual(await scopesToken('gitlab.com', 'T', { fetchImpl: pat }), ['read_api']);
  const oauth = async (u) => (u.endsWith('personal_access_tokens/self') ? json(404, {}) : json(200, { username: 'ana' }));
  assert.deepEqual(await scopesToken('gitlab.com', 'T', { fetchImpl: oauth }), ['api']);
  assert.equal(await scopesToken('gitlab.com', 'T', { fetchImpl: async () => json(401, {}) }), null);
});

test('miembroDe y rolEn', async () => {
  assert.equal(await miembroDe('gitlab.com', 'T', 'Acme/plataforma/equipo', 7, { fetchImpl: async () => json(200, { access_level: 30 }) }), true);
  assert.equal(await miembroDe('gitlab.com', 'T', 'Acme/plataforma/equipo', 7, { fetchImpl: async () => json(404, {}) }), false);
  assert.equal(await miembroDe('gitlab.com', 'T', 'g', 7, { fetchImpl: async () => { throw new Error('red'); } }), null);
  const proj = async () => json(200, { permissions: { project_access: null, group_access: { access_level: 40 } } });
  assert.deepEqual(await rolEn('gitlab.com', 'T', 'g/p', { fetchImpl: proj }), { nivel: 40, esOwner: false });
  const own = async () => json(200, { permissions: { project_access: { access_level: 50 }, group_access: null } });
  assert.equal((await rolEn('gitlab.com', 'T', 'g/p', { fetchImpl: own })).esOwner, true);
});

test('repos: proyectos del grupo con topic, normalizados a la forma que usan los flujos', async () => {
  const f = async (u) => { assert.match(u, /groups\/Acme%2Fplataforma%2Fequipo\/projects\?include_subgroups=true/); assert.match(u, /topic=faro/); return json(200, [{ path: 'analisis-red', path_with_namespace: 'Acme/plataforma/equipo/analisis-red', topics: ['faro', 'dom-producto'], last_activity_at: '2026-09-01T00:00:00Z', web_url: 'https://gitlab.com/x', permissions: {} }]); };
  const r = await repos('gitlab.com', 'T', 'Acme/plataforma/equipo', { fetchImpl: f });
  assert.equal(r[0].name, 'analisis-red'); assert.equal(r[0].path, 'Acme/plataforma/equipo/analisis-red'); assert.equal(r[0].pushed_at, '2026-09-01T00:00:00Z');
});

test('login con token personal: guarda tokens[host] con el client_id de la app propia declarada y forja gitlab', async () => {
  const cfg = {};
  const f = async (u) => (u.endsWith('personal_access_tokens/self') ? json(200, { scopes: ['api'] }) : json(200, { username: 'ana', id: 7, name: 'Ana', email: 'ANA@x.com' }));
  const auth = await login({ ...PERFILES.gitlab, client_id: 'CID' }, cfg, { tokenPegado: ' glpat-1 ', fetchImpl: f });
  assert.equal(auth.login, 'ana'); assert.equal(auth.email, 'ana@x.com'); assert.equal(auth.via, 'token personal');
  assert.equal(cfg.tokens['gitlab.com'].token, 'glpat-1');
  assert.equal(cfg.tokens['gitlab.com'].client_id, 'CID', 'el plugin lo lee de aqui');
  assert.equal(cfg.tokens['gitlab.com'].forja, 'gitlab');
  assert.equal(cfg.token, undefined, 'gitlab no toca el plano de github');
});

test('gitlab.com sin app OAuth embebida (#277): sin token pegado no hay device flow, se pide el token personal', async () => {
  let llamadas = 0;
  await assert.rejects(() => login(PERFILES.gitlab, {}, { fetchImpl: async () => { llamadas++; return json(200, {}); } }), /token personal/);
  assert.equal(llamadas, 0, 'no llama a ninguna app OAuth');
});

test('FORJA_GITLAB expone la interfaz', () => {
  for (const k of ['id', 'login', 'usuario', 'miembroDe', 'rolEn', 'repo', 'ramas', 'ramaPorDefecto', 'proteger', 'topics', 'estamparTopics', 'repos', 'usuarioHttp']) assert.ok(k in FORJA_GITLAB, k);
  assert.equal(FORJA_GITLAB.usuarioHttp, 'oauth2');
});

test('renovar: grant refresh_token con solo client_id; rota el refresh; null si falla', async () => {
  let cuerpo = null;
  const f = async (u, init) => { cuerpo = init.body; return json(200, { access_token: 'AT2', refresh_token: 'RT2', expires_in: 7200 }); };
  const r = await renovar('gitlab.com', 'CID', 'RT1', { fetchImpl: f, ahora: () => 1000 });
  assert.equal(r.token, 'AT2'); assert.equal(r.refresh_token, 'RT2'); assert.equal(r.expira, 1000 + 7200 * 1000);
  assert.match(cuerpo, /grant_type=refresh_token/); assert.match(cuerpo, /client_id=CID/); assert.ok(!/client_secret/.test(cuerpo));
  assert.equal(await renovar('gitlab.com', 'CID', 'RT1', { fetchImpl: async () => json(400, { error: 'invalid_grant' }) }), null);
  assert.equal(await renovar('gitlab.com', null, 'RT1', { fetchImpl: f }), null);
});

test('acceso: miembro explicito', async () => {
  const llamadas = [];
  const f = async (u, init) => { llamadas.push([u, init.method, init.body]); return json(201, { id: 1 }); };
  const m = await anadirMiembro('gitlab.com', 'T', 'g/p', 7, 40, { fetchImpl: f });
  assert.equal(m.ok, true); assert.match(llamadas[0][0], /projects\/g%2Fp\/members$/); assert.match(llamadas[0][2], /"user_id":7/); assert.match(llamadas[0][2], /"access_level":40/);
});

test('subgrupos: lista full_path de los subgrupos visibles del grupo', async () => {
  const f = async (u) => { assert.match(u, /groups\/Acme%2Fplataforma%2Fequipo\/subgroups/); return json(200, [{ id: 9, name: 'clientes', full_path: 'Acme/plataforma/equipo/clientes' }]); };
  const r = await subgrupos('gitlab.com', 'T', 'Acme/plataforma/equipo', { fetchImpl: f });
  assert.deepEqual(r, [{ path: 'Acme/plataforma/equipo/clientes', name: 'clientes', id: 9 }]);
  assert.deepEqual(await subgrupos('gitlab.com', 'T', 'g', { fetchImpl: async () => json(403, {}) }), []);
});

test('crearSubgrupo: resuelve el padre y crea con path slug, privado', async () => {
  const llamadas = [];
  const f = async (u, init) => { llamadas.push([u, init.method, init.body]); return u.endsWith('/groups') ? json(201, { id: 77, full_path: 'Acme/plataforma/equipo/cliente-acme' }) : json(200, { id: 5 }); };
  const r = await crearSubgrupo('gitlab.com', 'T', 'Acme/plataforma/equipo', 'Cliente Ácme', { fetchImpl: f });
  assert.equal(r.ok, true); assert.equal(r.body.full_path, 'Acme/plataforma/equipo/cliente-acme');
  assert.match(llamadas[1][2], /"path":"cliente-acme"/); assert.match(llamadas[1][2], /"parent_id":5/); assert.match(llamadas[1][2], /"visibility":"private"/);
  assert.equal((await crearSubgrupo('gitlab.com', 'T', 'x', 'y', { fetchImpl: async () => json(404, {}) })).ok, false);
});

test('FORJA_GITLAB ya no renombra ni gestiona personas', () => {
  for (const k of ['miembros', 'buscarUsuario', 'invitar', 'renombrar', 'crearIssue', 'leerFichero', 'escribirFichero']) assert.ok(!(k in FORJA_GITLAB), k);
});

// Contrato de alta: la misma firma que GitHub (ver forja-github.test.mjs).
const sesionGl = { host: 'gitlab.com', token: 'T' };
const grabarGl = (rutas) => {
  const llamadas = [];
  const fetchImpl = async (url, init = {}) => {
    const cuerpo = init.body ? JSON.parse(init.body) : null;
    llamadas.push({ url, method: init.method || 'GET', body: cuerpo });
    const clave = Object.keys(rutas).find((k) => url.includes(k));
    return clave ? json(...rutas[clave]) : json(404, {});
  };
  return { llamadas, fetchImpl };
};

test('alta.crearRepo en grupo: resuelve el namespace y crea un proyecto privado sin README', async () => {
  const { llamadas, fetchImpl } = grabarGl({
    '/groups/acme%2Fdatos': [200, { id: 77 }],
    '/projects': [201, { path_with_namespace: 'acme/datos/informe', web_url: 'https://gitlab.com/acme/datos/informe' }],
  });
  const r = await FORJA_GITLAB.alta.crearRepo(sesionGl, { org: 'acme/datos', personal: false }, { nombre: 'informe', descripcion: 'Un informe' }, { fetchImpl });
  assert.deepEqual(r, { ok: true, status: 201, ruta: 'acme/datos/informe', web: 'https://gitlab.com/acme/datos/informe', mensaje: null });
  const post = llamadas.find((l) => l.method === 'POST');
  assert.deepEqual(post.body, { name: 'informe', path: 'informe', namespace_id: 77, visibility: 'private', description: 'Un informe', initialize_with_readme: false });
});

test('alta.crearRepo en cuenta personal: sin namespace_id, porque el login no es un grupo', async () => {
  const { llamadas, fetchImpl } = grabarGl({ '/projects': [201, { path_with_namespace: 'ana/informe', web_url: 'https://gitlab.com/ana/informe' }] });
  const r = await FORJA_GITLAB.alta.crearRepo(sesionGl, { org: 'ana', personal: true }, { nombre: 'informe' }, { fetchImpl });
  assert.equal(r.ok, true); assert.equal(r.ruta, 'ana/informe');
  assert.equal(llamadas.length, 1, 'no consulta ningún grupo');
  assert.equal('namespace_id' in llamadas[0].body, false);
});

test('alta.crearRepo traduce el rechazo de GitLab, venga como objeto o como texto', async () => {
  const objeto = grabarGl({ '/projects': [400, { message: { path: ['has already been taken'] } }] });
  const r = await FORJA_GITLAB.alta.crearRepo(sesionGl, { org: 'ana', personal: true }, { nombre: 'x' }, { fetchImpl: objeto.fetchImpl });
  assert.equal(r.ok, false); assert.equal(r.status, 400); assert.match(r.mensaje, /has already been taken/);
  const grupo = grabarGl({});
  const sinGrupo = await FORJA_GITLAB.alta.crearRepo(sesionGl, { org: 'nadie', personal: false }, { nombre: 'x' }, { fetchImpl: grupo.fetchImpl });
  assert.equal(sinGrupo.ok, false); assert.match(sinGrupo.mensaje, /nadie/);
});

test('alta.existe distingue libre de no comprobable: un 500 no autoriza a crear', async () => {
  const con = (status) => FORJA_GITLAB.alta.existe(sesionGl, 'acme/x', { fetchImpl: async () => json(status, {}) });
  assert.equal(await con(200), true);
  assert.equal(await con(404), false);
  assert.equal(await con(500), null);
});

test('alta.nombres: grupo por /groups y cuenta personal por sus proyectos propios', async () => {
  const grupo = grabarGl({ '/groups/acme/projects': [200, [{ path: 'a', path_with_namespace: 'acme/a' }]] });
  assert.deepEqual(await FORJA_GITLAB.alta.nombres(sesionGl, { org: 'acme', personal: false }, { fetchImpl: grupo.fetchImpl }), ['a']);
  const cuenta = grabarGl({ '/projects?owned=true': [200, [{ path: 'mio', path_with_namespace: 'ana/mio' }, { path: 'otro', path_with_namespace: 'acme/otro' }]] });
  assert.deepEqual(await FORJA_GITLAB.alta.nombres(sesionGl, { org: 'ana', personal: true }, { fetchImpl: cuenta.fetchImpl }), ['mio']);
});

test('alta.ramaPorDefecto, estamparTopics y proteger: misma forma que GitHub sobre la API de GitLab', async () => {
  const { llamadas, fetchImpl } = grabarGl({ '/projects/ana%2Fx': [200, {}] });
  assert.equal((await FORJA_GITLAB.alta.ramaPorDefecto(sesionGl, 'ana/x', 'develop', { fetchImpl })).ok, true);
  assert.deepEqual(llamadas[0].body, { default_branch: 'develop' });
  await FORJA_GITLAB.alta.estamparTopics(sesionGl, 'ana/x', ['faro', 'doc'], { fetchImpl });
  assert.deepEqual(llamadas[1].body, { topics: ['faro', 'doc'] });
  const r = await FORJA_GITLAB.alta.proteger(sesionGl, 'ana/x', 'main', { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(llamadas.at(-1).body.name, 'main');
  assert.equal(llamadas.at(-1).body.push_access_level, 0);
});

test('alta.configurar: GitLab borra la rama tras fusionar y propone squash', async () => {
  const { llamadas, fetchImpl } = grabarGl({ '/projects/ana%2Fx': [200, {}] });
  await FORJA_GITLAB.alta.configurar(sesionGl, 'ana/x', { descripcion: 'd' }, { fetchImpl });
  assert.equal(llamadas[0].method, 'PUT');
  assert.deepEqual(llamadas[0].body, { remove_source_branch_after_merge: true, squash_option: 'default_on', description: 'd' });
});
