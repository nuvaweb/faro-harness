import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiBase, estadoToken, miembroDe, listarReposFaro, validarTokenSesion, FORJA_GITHUB } from '../bin/lib/forjas/github.mjs';
import { PERFILES } from '../bin/lib/perfil.mjs';

const respuesta = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: new Map(Object.entries(headers)), text: async () => JSON.stringify(body) });

test('apiBase: github.com -> api.github.com; autoalojado -> /api/v3', () => {
  assert.equal(apiBase('github.com'), 'https://api.github.com');
  assert.equal(apiBase('github.empresa.com'), 'https://github.empresa.com/api/v3');
});

test('estadoToken: lee X-OAuth-Scopes y calcula faltan; 401 -> invalido', async () => {
  const f = async () => respuesta(200, { login: 'ana' }, { 'x-oauth-scopes': 'repo, read:org' });
  const e = await estadoToken('t', 'github.com', { fetchImpl: f });
  assert.equal(e.valido, true); assert.deepEqual(e.scopes, ['repo', 'read:org']); assert.deepEqual(e.faltan, ['workflow', 'user:email']); assert.equal(e.login, 'ana');
  const e2 = await estadoToken('t', 'github.com', { fetchImpl: async () => respuesta(401, { message: 'Bad credentials' }) });
  assert.equal(e2.valido, false);
  assert.equal(await estadoToken('t', 'github.com', { fetchImpl: async () => { throw new Error('ENOTFOUND'); } }), null, 'sin red -> null');
});

test('miembroDe: 200 true, 404/403 false, red caida null', async () => {
  assert.equal(await miembroDe('t', 'Acme', 'github.com', { fetchImpl: async () => respuesta(200, { state: 'active' }) }), true);
  assert.equal(await miembroDe('t', 'Acme', 'github.com', { fetchImpl: async () => respuesta(404, {}) }), false);
  assert.equal(await miembroDe('t', 'Acme', 'github.com', { fetchImpl: async () => { throw new Error('ENOTFOUND'); } }), null);
});

test('listarReposFaro respeta soloFaro:false (antes filtraba siempre por topic)', async () => {
  const repos = [{ name: 'a', topics: ['faro'] }, { name: 'b', topics: [] }, { name: 't', topics: ['faro'], is_template: true }];
  const f = async () => respuesta(200, repos);
  assert.deepEqual((await listarReposFaro({ token: 't' }, 'Acme', { soloFaro: true, fetchImpl: f })).map((r) => r.name), ['a']);
  assert.deepEqual((await listarReposFaro({ token: 't' }, 'Acme', { soloFaro: false, fetchImpl: f })).map((r) => r.name), ['a', 'b']);
});

test('validarTokenSesion: lee el token de tokens[host], cachea 24h en la entrada y no bloquea sin red', async () => {
  const cfg = { tokens: { 'github.com': { token: 'T' } } };
  const f = async () => respuesta(200, { login: 'ana' }, { 'x-oauth-scopes': 'repo, read:org, workflow, user:email' });
  const v = await validarTokenSesion(cfg, PERFILES.github, { fetchImpl: f, ui: { say: () => {}, ok: () => {}, caja: () => {} }, guardar: () => {} });
  assert.equal(v.ok, true);
  assert.equal(cfg.tokens['github.com'].scopes_cache.huella, 'T'.slice(-8));
  let llamadas = 0;
  const v2 = await validarTokenSesion(cfg, PERFILES.github, { fetchImpl: async () => { llamadas++; return respuesta(200, {}, {}); }, ui: { say: () => {}, ok: () => {}, caja: () => {} }, guardar: () => {} });
  assert.equal(llamadas, 0, 'cache fresca: no llama a la API'); assert.equal(v2.ok, true);
  const sinToken = await validarTokenSesion({}, PERFILES.github, { fetchImpl: f, ui: { say: () => {}, ok: () => {}, caja: () => {} }, guardar: () => {}, gh: () => null });
  assert.equal(sinToken.ok, false);
  const corto = { tokens: { 'github.com': { token: 'X' } } };
  const v3 = await validarTokenSesion(corto, PERFILES.github, { fetchImpl: async () => respuesta(200, { login: 'ana' }, { 'x-oauth-scopes': 'read:org' }), ui: { say: () => {}, ok: () => {}, caja: () => {} }, guardar: () => {} });
  assert.equal(v3.ok, false); assert.ok(v3.faltan.includes('repo'));
  const sinRed = await validarTokenSesion({ tokens: { 'github.com': { token: 'Y' } } }, PERFILES.github, { fetchImpl: async () => { throw new Error('x'); }, ui: { say: () => {}, ok: () => {}, caja: () => {} }, guardar: () => {} });
  assert.equal(sinRed.ok, true); assert.equal(sinRed.sinRed, true);
});

test('FORJA_GITHUB expone la interfaz comun', () => {
  for (const k of ['id', 'apiBase', 'login', 'validarTokenSesion', 'miembroDe', 'estadoToken', 'repos', 'protegerRama', 'estamparTopics', 'usuarioHttp']) assert.ok(k in FORJA_GITHUB, k);
  assert.equal(FORJA_GITHUB.usuarioHttp, 'x-access-token');
});

test('FORJA_GITHUB.login respeta la firma comun (perfil, cfg): lee la sesion guardada del host del perfil', async () => {
  // Con token en tokens[host] y sin red disponible, la cascada intenta validar via fetch: se intercepta.
  const fetchOrig = globalThis.fetch;
  globalThis.fetch = async (url) => ({ status: 200, ok: true, text: async () => JSON.stringify({ login: 'ana', id: 1, name: 'Ana', email: 'ana@x.com' }), headers: new Map([['x-oauth-scopes', 'repo, read:org, workflow, user:email']]) });
  try {
    const cfg = { tokens: { 'github.com': { token: 'ghp_T' } } };
    const auth = await FORJA_GITHUB.login(PERFILES.github, cfg, {});
    assert.equal(auth.login, 'ana');
    assert.equal(auth.token, 'ghp_T', 'el token viene de tokens[host] del perfil, no de un cfg mal posicionado');
  } finally { globalThis.fetch = fetchOrig; }
});

const silencio = { say: () => {}, ok: () => {}, caja: () => {} };

test('validarTokenSesion: con solo repo la sesión vale; read:org es opcional', async () => {
  const v = await validarTokenSesion({ tokens: { 'github.com': { token: 'R' } } }, PERFILES.github, { fetchImpl: async () => respuesta(200, { login: 'ana' }, { 'x-oauth-scopes': 'repo' }), ui: silencio, guardar: () => {} });
  assert.equal(v.ok, true);
  assert.ok(v.faltan.includes('read:org'), 'falta, pero no impide trabajar');
});

test('validarTokenSesion: el aviso de SSO no menciona una organización que el perfil no tiene', async () => {
  let lineas = [];
  await validarTokenSesion({ tokens: { 'github.com': { token: 'S' } } }, PERFILES.github, { fetchImpl: async () => respuesta(200, { login: 'ana' }, { 'x-oauth-scopes': 'repo, workflow', 'x-github-sso': 'required' }), ui: { ...silencio, caja: (l) => { lineas = l; } }, guardar: () => {} });
  assert.match(lineas.join('\n'), /SSO/);
  assert.ok(!/null/.test(lineas.join('\n')));
});

// Forja simulada para login(): valida /user con `scopes`, sin correos; el device flow no debe llegar.
async function conLogin(scopes, fn) {
  const fetchOrig = globalThis.fetch;
  const llamadas = [];
  globalThis.fetch = async (url, init = {}) => {
    llamadas.push(String(url));
    if (String(url).includes('login/device') || String(url).includes('oauth')) throw new Error('no debe pasar por el device flow');
    if (String(url).endsWith('/user')) return { status: 200, ok: true, text: async () => JSON.stringify({ login: 'ana', id: 1, name: 'Ana', email: 'ana@x.com' }), headers: new Map([['x-oauth-scopes', scopes]]) };
    return { status: 404, ok: false, text: async () => '{}', headers: new Map() };
  };
  try { return await fn(llamadas); } finally { globalThis.fetch = fetchOrig; }
}

test('login: un token con solo repo se acepta tal cual', async () => {
  await conLogin('repo', async () => {
    const auth = await FORJA_GITHUB.login(PERFILES.github, { tokens: { 'github.com': { token: 'ghp_R' } } }, {});
    assert.equal(auth.token, 'ghp_R');
    assert.ok(!/limitados/.test(auth.via), auth.via);
  });
});

test('login: la sesión ya encontrada se usa sin volver a buscar y conserva su origen', async () => {
  await conLogin('repo', async () => {
    const auth = await FORJA_GITHUB.login(PERFILES.github, { tokens: { 'github.com': { token: 'otro' } } }, { tokenInicial: { token: 'delGit', via: 'git credential' } });
    assert.equal(auth.token, 'delGit');
    assert.equal(auth.via, 'git credential');
  });
});

test('FORJA_GITHUB ya no gestiona personas: añadirlas es cosa del owner en la forja', () => {
  for (const k of ['miembros', 'buscarUsuario', 'invitar']) assert.ok(!(k in FORJA_GITHUB), k);
});

// Contrato de alta: la misma firma en las dos forjas, con la sesión primero y el destino explícito.
const sesionGh = { host: 'github.com', token: 'T' };
const grabarGh = (status, body) => {
  const llamadas = [];
  const fetchImpl = async (url, init = {}) => { llamadas.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null }); return respuesta(status, body); };
  return { llamadas, fetchImpl };
};

test('alta.crearRepo en organización: privado, vacío y bajo /orgs', async () => {
  const { llamadas, fetchImpl } = grabarGh(201, { full_name: 'acme/informe', html_url: 'https://github.com/acme/informe' });
  const r = await FORJA_GITHUB.alta.crearRepo(sesionGh, { org: 'acme', personal: false }, { nombre: 'informe', descripcion: 'Un informe' }, { fetchImpl });
  assert.deepEqual(r, { ok: true, status: 201, ruta: 'acme/informe', web: 'https://github.com/acme/informe', mensaje: null });
  assert.equal(llamadas[0].url, 'https://api.github.com/orgs/acme/repos');
  assert.deepEqual(llamadas[0].body, { name: 'informe', private: true, description: 'Un informe', auto_init: false });
});

test('alta.crearRepo en cuenta personal: va a /user/repos, porque /orgs/<login> da 404', async () => {
  const { llamadas, fetchImpl } = grabarGh(201, { full_name: 'ana/informe', html_url: 'https://github.com/ana/informe' });
  const r = await FORJA_GITHUB.alta.crearRepo(sesionGh, { org: 'ana', personal: true }, { nombre: 'informe' }, { fetchImpl });
  assert.equal(r.ruta, 'ana/informe');
  assert.equal(llamadas[0].url, 'https://api.github.com/user/repos');
});

test('alta.crearRepo respeta el host propio y devuelve el motivo si la forja lo rechaza', async () => {
  const { llamadas, fetchImpl } = grabarGh(422, { message: 'name already exists on this account' });
  const r = await FORJA_GITHUB.alta.crearRepo({ host: 'github.empresa.com', token: 'T' }, { org: 'acme', personal: false }, { nombre: 'x' }, { fetchImpl });
  assert.equal(llamadas[0].url, 'https://github.empresa.com/api/v3/orgs/acme/repos');
  assert.equal(r.ok, false); assert.equal(r.status, 422); assert.equal(r.mensaje, 'name already exists on this account');
});

test('alta.existe distingue libre de no comprobable: un 500 no autoriza a crear', async () => {
  const con = (status) => FORJA_GITHUB.alta.existe(sesionGh, 'acme/x', { fetchImpl: async () => respuesta(status, {}) });
  assert.equal(await con(200), true);
  assert.equal(await con(404), false);
  assert.equal(await con(500), null);
});

test('alta.nombres: organización por /orgs; cuenta personal solo con lo propio, no lo compartido', async () => {
  const org = grabarGh(200, [{ name: 'a' }]);
  assert.deepEqual(await FORJA_GITHUB.alta.nombres(sesionGh, { org: 'acme', personal: false }, { fetchImpl: org.fetchImpl }), ['a']);
  assert.match(org.llamadas[0].url, /\/orgs\/acme\/repos/);
  const cuenta = grabarGh(200, [{ name: 'mio', owner: { login: 'ana' } }, { name: 'ajeno', owner: { login: 'acme' } }]);
  assert.deepEqual(await FORJA_GITHUB.alta.nombres(sesionGh, { org: 'ana', personal: true }, { fetchImpl: cuenta.fetchImpl }), ['mio']);
  assert.match(cuenta.llamadas[0].url, /\/user\/repos/);
});

test('alta.ramaPorDefecto, estamparTopics y proteger: operan sobre la ruta y devuelven {ok} sin escribir en pantalla', async () => {
  const uno = grabarGh(200, {});
  assert.equal((await FORJA_GITHUB.alta.ramaPorDefecto(sesionGh, 'ana/x', 'develop', { fetchImpl: uno.fetchImpl })).ok, true);
  assert.deepEqual(uno.llamadas[0], { url: 'https://api.github.com/repos/ana/x', method: 'PATCH', body: { default_branch: 'develop' } });

  const dos = grabarGh(200, {});
  await FORJA_GITHUB.alta.estamparTopics(sesionGh, 'ana/x', ['faro', 'faro', null, 'doc'], { fetchImpl: dos.fetchImpl });
  assert.deepEqual(dos.llamadas[0], { url: 'https://api.github.com/repos/ana/x/topics', method: 'PUT', body: { names: ['faro', 'doc'] } });

  const tres = grabarGh(200, {});
  await FORJA_GITHUB.alta.proteger(sesionGh, 'ana/x', 'main', { fetchImpl: tres.fetchImpl });
  assert.equal(tres.llamadas[0].url, 'https://api.github.com/repos/ana/x/branches/main/protection');
  assert.equal(tres.llamadas[0].method, 'PUT');
  assert.equal(tres.llamadas[0].body.required_pull_request_reviews.required_approving_review_count, 1);
});

test('alta.proteger: en un plan sin protección (403) informa sin lanzar', async () => {
  const r = await FORJA_GITHUB.alta.proteger(sesionGh, 'ana/x', 'main', { fetchImpl: async () => respuesta(403, { message: 'Upgrade to GitHub Pro' }) });
  assert.equal(r.ok, false); assert.equal(r.status, 403);
});

test('alta.configurar: higiene del repo en la API de GitHub y por el host de la sesión', async () => {
  const { llamadas, fetchImpl } = grabarGh(200, {});
  await FORJA_GITHUB.alta.configurar({ host: 'github.empresa.com', token: 'T' }, 'acme/x', { descripcion: 'd' }, { fetchImpl });
  assert.equal(llamadas[0].url, 'https://github.empresa.com/api/v3/repos/acme/x');
  assert.equal(llamadas[0].body.delete_branch_on_merge, true);
  assert.equal(llamadas[0].body.description, 'd');
});

test('la forja GitHub ya no reparte equipos: el acceso se gestiona en la propia forja', async () => {
  const m = await import('../bin/lib/forjas/github.mjs');
  for (const k of ['elegirTeams', 'asignarTeams', 'mapaRepoTeams', 'elegirRepoExistente']) assert.equal(m[k], undefined, k);
});
