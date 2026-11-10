import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buscarSesiones, elegirSesion, textoSesion, mensajeSinSesion, leerCredencialGit, resolverDestino, rolDestino } from '../bin/lib/sesion.mjs';
import { detectarForja } from '../bin/lib/forja.mjs';

// API simulada de las dos forjas: `validos` = { host: { token: usuario } }. Cualquier otro token, 401.
function forjas(validos) {
  const llamadas = [];
  const fetchImpl = async (url, init = {}) => {
    llamadas.push(url);
    const { hostname, pathname } = new URL(url);
    const host = hostname === 'api.github.com' ? 'github.com' : hostname;
    const token = String(init.headers.Authorization).replace('Bearer ', '');
    const u = (validos[host] || {})[token];
    if (!u || !/\/user$/.test(pathname)) return new Response('{}', { status: 401 });
    return new Response(JSON.stringify(u), { status: 200 });
  };
  return { fetchImpl, llamadas };
}
const sinRed = async () => { throw new Error('sin red'); };
const nada = () => null;
const base = { env: {}, gh: nada, credencialGit: nada };
const noPreguntes = async () => { throw new Error('no debe preguntar'); };

test('una sesión guardada de GitHub se encuentra, se valida y se dice forja y usuario', async () => {
  const { fetchImpl } = forjas({ 'github.com': { t1: { login: 'ana', id: 7 } } });
  const sesiones = await buscarSesiones({ ...base, cfg: { tokens: { 'github.com': { token: 't1' } } }, fetchImpl });
  assert.equal(sesiones.length, 1);
  assert.equal(sesiones[0].perfil.id, 'github');
  assert.equal(sesiones[0].login, 'ana', 'el usuario sale de la API, no de lo guardado');
  assert.equal(sesiones[0].token, 't1');
  assert.equal(textoSesion(sesiones[0]), 'Este es tu git: GitHub · @ana');
});

test('una sesión de GitLab dice GitLab; en un host propio dice también el host', async () => {
  const { fetchImpl } = forjas({
    'gitlab.com': { g1: { username: 'bea', id: 3 } },
    'gitlab.cliente.com': { g2: { username: 'bea2', id: 4 } },
  });
  const sesiones = await buscarSesiones({ ...base, cfg: { tokens: { 'gitlab.com': { token: 'g1', forja: 'gitlab' }, 'gitlab.cliente.com': { token: 'g2', forja: 'gitlab' } } }, fetchImpl });
  assert.equal(textoSesion(sesiones.find((s) => s.host === 'gitlab.com')), 'Este es tu git: GitLab · @bea');
  const propia = sesiones.find((s) => s.host === 'gitlab.cliente.com');
  assert.equal(textoSesion(propia), 'Este es tu git: GitLab (gitlab.cliente.com) · @bea2');
  assert.equal(propia.perfil.host, 'gitlab.cliente.com');
  assert.equal(propia.perfil.client_id, null, 'la app OAuth de gitlab.com no sirve en otra instancia');
});

test('un host propio sin «gitlab» en el nombre se reconoce por la forja guardada', async () => {
  const { fetchImpl } = forjas({ 'git.cliente.com': { g: { username: 'bea', id: 4 } } });
  const [s] = await buscarSesiones({ ...base, cfg: { tokens: { 'git.cliente.com': { token: 'g', forja: 'gitlab' } } }, fetchImpl });
  assert.equal(s.forja, 'gitlab');
  assert.equal(s.login, 'bea');
});

test('el token plano antiguo cuenta como sesión de GitHub y la búsqueda no toca la configuración', async () => {
  const { fetchImpl } = forjas({ 'github.com': { viejo: { login: 'ana', id: 7 } } });
  const cfg = { token: 'viejo' };
  const [s] = await buscarSesiones({ ...base, cfg, fetchImpl });
  assert.equal(s.login, 'ana');
  assert.deepEqual(cfg, { token: 'viejo' });
});

test('orden de orígenes: guardada antes que entorno', async () => {
  const { fetchImpl } = forjas({ 'github.com': { guardado: { login: 'ana', id: 1 }, delEntorno: { login: 'ci', id: 2 } } });
  const [s] = await buscarSesiones({ ...base, env: { GITHUB_TOKEN: 'delEntorno' }, cfg: { tokens: { 'github.com': { token: 'guardado' } } }, fetchImpl });
  assert.equal(s.login, 'ana');
});

test('orden de orígenes: entorno antes que git credential, que ni se consulta', async () => {
  const { fetchImpl } = forjas({ 'github.com': { delEntorno: { login: 'ci', id: 2 }, delGit: { login: 'git', id: 3 } } });
  let consultado = false;
  const [s] = await buscarSesiones({ ...base, env: { GITHUB_TOKEN: 'delEntorno' }, credencialGit: (h) => { if (h === 'github.com') consultado = true; return null; }, cfg: {}, fetchImpl });
  assert.equal(s.login, 'ci');
  assert.equal(consultado, false);
});

test('un token rechazado se descarta y sigue por el origen siguiente', async () => {
  const { fetchImpl } = forjas({ 'github.com': { delGit: { login: 'ana', id: 3 } } });
  const [s] = await buscarSesiones({ ...base, env: { GITHUB_TOKEN: 'revocado2' }, credencialGit: (h) => (h === 'github.com' ? 'delGit' : null), cfg: { tokens: { 'github.com': { token: 'revocado' } } }, fetchImpl });
  assert.equal(s.login, 'ana');
  assert.equal(s.token, 'delGit');
});

test('git credential también vale para GitLab', async () => {
  const { fetchImpl } = forjas({ 'gitlab.com': { delGit: { username: 'bea', id: 3 } } });
  const [s] = await buscarSesiones({ ...base, credencialGit: (h) => (h === 'gitlab.com' ? 'delGit' : null), cfg: {}, fetchImpl });
  assert.equal(s.forja, 'gitlab');
  assert.equal(s.login, 'bea');
});

test('todos los tokens rechazados: no hay sesión', async () => {
  const { fetchImpl } = forjas({});
  const sesiones = await buscarSesiones({ ...base, cfg: { tokens: { 'github.com': { token: 'revocado', user: { login: 'ana' } } } }, fetchImpl });
  assert.deepEqual(sesiones, []);
});

test('con remoto solo se mira su host', async () => {
  const { fetchImpl, llamadas } = forjas({ 'github.com': { t1: { login: 'ana', id: 1 } }, 'gitlab.com': { g1: { username: 'bea', id: 2 } } });
  const sesiones = await buscarSesiones({ ...base, cfg: { tokens: { 'github.com': { token: 't1' }, 'gitlab.com': { token: 'g1', forja: 'gitlab' } } }, remoto: detectarForja('https://gitlab.com/grupo/proy.git'), fetchImpl });
  assert.deepEqual(sesiones.map((s) => s.host), ['gitlab.com']);
  assert.ok(llamadas.every((u) => !u.includes('github')), 'no se valida contra la otra forja');
});

test('sin red, una sesión guardada con usuario conocido vale; sin usuario, no', async () => {
  const conUsuario = await buscarSesiones({ ...base, cfg: { tokens: { 'github.com': { token: 't', user: { login: 'ana', id: 1 } } } }, fetchImpl: sinRed });
  assert.equal(conUsuario[0].login, 'ana');
  assert.deepEqual(await buscarSesiones({ ...base, cfg: { tokens: { 'github.com': { token: 't' } } }, fetchImpl: sinRed }), []);
});

test('una sesión caducada que se puede renovar no se descarta', async () => {
  const { fetchImpl } = forjas({});
  const [s] = await buscarSesiones({ ...base, cfg: { tokens: { 'gitlab.com': { token: 'g', forja: 'gitlab', expira: 1, refresh_token: 'r', client_id: 'c', user: { login: 'bea', id: 2 } } } }, fetchImpl });
  assert.equal(s.login, 'bea');
  assert.equal(s.renovable, true);
});

test('seguridad: un remoto de un host desconocido no recibe ni el entorno ni gh', async () => {
  const { fetchImpl, llamadas } = forjas({ 'gitlab.evil.com': { env: { username: 'x', id: 1 }, cli: { username: 'x', id: 1 } } });
  const sesiones = await buscarSesiones({ ...base, env: { GITLAB_TOKEN: 'env', GITHUB_TOKEN: 'env' }, gh: () => 'cli', cfg: {}, remoto: { host: 'gitlab.evil.com', forja: 'gitlab', selfHosted: true }, fetchImpl });
  assert.deepEqual(sesiones, []);
  assert.deepEqual(llamadas, [], 'ningún token sale hacia un host que nadie ha declarado');
});

test('seguridad: un servidor declarado sin sesión guardada usa git credential, no el entorno', async () => {
  const { fetchImpl } = forjas({ 'git.empresa.com': { env: { username: 'ci', id: 1 }, cred: { username: 'bea', id: 2 } } });
  const [s] = await buscarSesiones({ ...base, env: { GITLAB_TOKEN: 'env' }, credencialGit: (h) => (h === 'git.empresa.com' ? 'cred' : null), cfg: {}, remoto: { host: 'git.empresa.com', forja: 'gitlab', declarada: true }, fetchImpl });
  assert.equal(s.login, 'bea');
  assert.equal(s.via, 'git credential');
});

test('seguridad: un servidor con sesión guardada es de confianza y sí admite el entorno', async () => {
  const { fetchImpl } = forjas({ 'git.empresa.com': { env: { username: 'ci', id: 1 } } });
  const [s] = await buscarSesiones({ ...base, env: { GITLAB_TOKEN: 'env' }, cfg: { tokens: { 'git.empresa.com': { token: 'revocado', forja: 'gitlab' } } }, fetchImpl });
  assert.equal(s.login, 'ci');
  assert.equal(s.via, 'entorno');
});

test('seguridad: el token de la CLI gh solo viaja a github.com', async () => {
  const { fetchImpl, llamadas } = forjas({ 'ghe.empresa.com': { cli: { login: 'x', id: 1 } } });
  const sesiones = await buscarSesiones({ ...base, perfiles: [], gh: () => 'cli', cfg: { tokens: { 'ghe.empresa.com': { token: 'malo', forja: 'github' } } }, fetchImpl });
  assert.deepEqual(sesiones, []);
  assert.equal(llamadas.length, 1, 'solo se prueba la sesión guardada');
});

const sesion = (id, login) => ({ perfil: { id }, login, host: `${id}.com`, forja: id });

test('elegirSesion: una sola se usa sin preguntar', async () => {
  const s = await elegirSesion({ sesiones: [sesion('github', 'ana')], interactivo: true, preguntar: noPreguntes });
  assert.equal(s.login, 'ana');
});

test('elegirSesion: ninguna devuelve null', async () => {
  assert.equal(await elegirSesion({ sesiones: [], interactivo: true, preguntar: noPreguntes }), null);
});

test('elegirSesion: varias con terminal preguntan con la última usada primero', async () => {
  let ops = null;
  const s = await elegirSesion({ sesiones: [sesion('github', 'ana'), sesion('gitlab', 'bea')], ultimo: 'gitlab', interactivo: true, preguntar: async (o) => { ops = o; return 'github'; } });
  assert.deepEqual(Object.keys(ops), ['gitlab', 'github']);
  assert.equal(s.login, 'ana');
});

test('elegirSesion: la última usada se reconoce por id exacto o derivado', async () => {
  const lista = [sesion('github', 'ana'), sesion('gitlab', 'bea')];
  for (const ultimo of ['gitlab', 'gitlab@Grupo']) {
    const s = await elegirSesion({ sesiones: lista, ultimo, interactivo: false, preguntar: noPreguntes });
    assert.equal(s.login, 'bea', ultimo);
  }
});

test('elegirSesion: varias sin terminal usan la última sin preguntar', async () => {
  const s = await elegirSesion({ sesiones: [sesion('github', 'ana'), sesion('gitlab', 'bea')], ultimo: 'gitlab', interactivo: false, preguntar: noPreguntes });
  assert.equal(s.login, 'bea');
});

test('elegirSesion: varias sin terminal ni última usan la primera', async () => {
  const s = await elegirSesion({ sesiones: [sesion('github', 'ana'), sesion('gitlab', 'bea')], interactivo: false, preguntar: noPreguntes });
  assert.equal(s.login, 'ana');
});

test('sin sesión ni terminal, el mensaje da el comando para conectar', () => {
  assert.match(mensajeSinSesion(), /npx faro-harness --login/);
  assert.match(mensajeSinSesion(), /GITHUB_TOKEN/);
  assert.match(mensajeSinSesion(), /GITLAB_TOKEN/);
});

test('leerCredencialGit: pregunta a git sin poder abrir ningún diálogo y extrae la contraseña', () => {
  let visto = null;
  const ejecutar = (cmd, args, o) => { visto = { cmd, args, o }; return 'protocol=https\nhost=gitlab.com\nusername=oauth2\npassword=secreto\n'; };
  assert.equal(leerCredencialGit('gitlab.com', { ejecutar, env: {} }), 'secreto');
  assert.equal(visto.cmd, 'git');
  assert.deepEqual(visto.args, ['-c', 'credential.interactive=false', 'credential', 'fill']);
  assert.equal(visto.o.input, 'protocol=https\nhost=gitlab.com\n\n');
  assert.equal(visto.o.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(visto.o.env.GCM_INTERACTIVE, 'never');
});

test('leerCredencialGit: sin credencial o si git falla devuelve null', () => {
  assert.equal(leerCredencialGit('x.com', { ejecutar: () => 'protocol=https\nhost=x.com\n', env: {} }), null);
  assert.equal(leerCredencialGit('x.com', { ejecutar: () => { throw new Error('128'); }, env: {} }), null);
});

// API simulada de destinos: `rutas` = { 'ruta?query': cuerpo }. Una ruta sin declarar, 404.
function api(rutas, status = 200) {
  const llamadas = [];
  const fetchImpl = async (url) => {
    const { pathname, search } = new URL(url);
    const ruta = (pathname + search).replace(/^\/api\/v4\//, '/');
    llamadas.push(ruta);
    return ruta in rutas ? new Response(JSON.stringify(rutas[ruta]), { status }) : new Response('{}', { status: 404 });
  };
  return { fetchImpl, llamadas };
}
const deGithub = { forja: 'github', host: 'github.com', token: 't', login: 'ana', id: 7 };
const deGitlab = { forja: 'gitlab', host: 'gitlab.com', token: 'g', login: 'bea', id: 3 };
const ORGS = '/user/orgs?per_page=100';
const GRUPOS = '/groups?min_access_level=30&per_page=100';

test('destino: --org manda y no se consulta nada', async () => {
  const { fetchImpl, llamadas } = api({});
  assert.deepEqual(await resolverDestino({ sesion: deGithub, org: 'Acme', fijo: 'Otra', preguntar: noPreguntes, fetchImpl }), { org: 'Acme', personal: false });
  assert.deepEqual(llamadas, []);
});

test('destino: el fijado por remoto o perfil se usa sin preguntar', async () => {
  const { fetchImpl } = api({});
  assert.deepEqual(await resolverDestino({ sesion: deGithub, fijo: 'Otra', preguntar: noPreguntes, fetchImpl }), { org: 'Otra', personal: false });
});

test('destino: si coincide con el usuario es la cuenta personal, sin distinguir mayúsculas', async () => {
  const { fetchImpl } = api({});
  assert.deepEqual(await resolverDestino({ sesion: deGithub, fijo: 'ANA', fetchImpl }), { org: 'ANA', personal: true });
});

test('destino: una cuenta sin organizaciones es personal y no pregunta', async () => {
  const { fetchImpl } = api({ [ORGS]: [] });
  assert.deepEqual(await resolverDestino({ sesion: deGithub, preguntar: noPreguntes, fetchImpl }), { org: 'ana', personal: true });
});

test('destino: si no se puede leer la lista, sigue con la cuenta personal', async () => {
  assert.deepEqual(await resolverDestino({ sesion: deGithub, preguntar: noPreguntes, fetchImpl: sinRed }), { org: 'ana', personal: true });
  assert.deepEqual(await resolverDestino({ sesion: deGitlab, preguntar: noPreguntes, fetchImpl: sinRed }), { org: 'bea', personal: true });
});

test('destino GitHub: ofrece la cuenta personal primero y después las organizaciones', async () => {
  const { fetchImpl } = api({ [ORGS]: [{ login: 'Acme' }, { login: 'Beta' }] });
  let ops = null;
  const d = await resolverDestino({ sesion: deGithub, preguntar: async (o) => { ops = o; return 'Beta'; }, fetchImpl });
  assert.deepEqual(Object.keys(ops), ['__personal', 'Acme', 'Beta']);
  assert.match(ops.__personal.etiqueta, /@ana/);
  assert.deepEqual(d, { org: 'Beta', personal: false });
});

test('destino: elegir la cuenta personal devuelve el usuario', async () => {
  const { fetchImpl } = api({ [ORGS]: [{ login: 'Acme' }] });
  assert.deepEqual(await resolverDestino({ sesion: deGithub, preguntar: async () => '__personal', fetchImpl }), { org: 'ana', personal: true });
});

test('destino GitLab: lista los grupos donde puede crear, con su ruta completa', async () => {
  const { fetchImpl } = api({ [GRUPOS]: [{ full_path: 'acme/equipo', name: 'equipo' }] });
  const d = await resolverDestino({ sesion: deGitlab, preguntar: async (o) => Object.keys(o)[1], fetchImpl });
  assert.deepEqual(d, { org: 'acme/equipo', personal: false });
});

test('destino: sin terminal va a la cuenta personal aunque haya organizaciones', async () => {
  const { fetchImpl, llamadas } = api({ [ORGS]: [{ login: 'Acme' }] });
  assert.deepEqual(await resolverDestino({ sesion: deGithub, preguntar: null, fetchImpl }), { org: 'ana', personal: true });
  assert.deepEqual(llamadas, [], 'sin nadie a quien preguntar, la lista no hace falta');
});

test('rol: en la cuenta personal manda el dueño, sin consultar', async () => {
  const { fetchImpl, llamadas } = api({});
  assert.equal(await rolDestino({ sesion: deGithub, destino: { org: 'ana', personal: true }, fetchImpl }), true);
  assert.deepEqual(llamadas, []);
});

test('rol GitHub: solo un admin activo es owner', async () => {
  const ruta = '/user/memberships/orgs/Acme';
  const rol = (cuerpo) => rolDestino({ sesion: deGithub, destino: { org: 'Acme', personal: false }, fetchImpl: api({ [ruta]: cuerpo }).fetchImpl });
  assert.equal(await rol({ state: 'active', role: 'admin' }), true);
  assert.equal(await rol({ state: 'active', role: 'member' }), false);
  assert.equal(await rol({ state: 'pending', role: 'admin' }), false);
});

test('rol GitLab: owner desde nivel 50, con el grupo anidado codificado', async () => {
  const ruta = '/groups/acme%2Fequipo/members/all/3';
  const rol = (nivel) => rolDestino({ sesion: deGitlab, destino: { org: 'acme/equipo', personal: false }, fetchImpl: api({ [ruta]: { access_level: nivel } }).fetchImpl });
  assert.equal(await rol(50), true);
  assert.equal(await rol(40), false);
});

test('rol: si la forja no responde es false y no lanza', async () => {
  const destino = { org: 'Acme', personal: false };
  assert.equal(await rolDestino({ sesion: deGithub, destino, fetchImpl: sinRed }), false);
  assert.equal(await rolDestino({ sesion: deGitlab, destino, fetchImpl: sinRed }), false);
});
