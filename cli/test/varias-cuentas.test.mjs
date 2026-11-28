// Varias cuentas en la misma forja y SSH por cuenta (3.1.0). API de la forja simulada (fetch falso):
// sin red real, sin tokens reales y ~/.faro.json no se toca. Ninguna org fija: nombres de ejemplo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tokenPara, guardarToken, borrarToken, entradaPara, cuentaPara, cuentasDe, anotarOrg, guardarOrgs } from '../bin/lib/credenciales.mjs';
import { contenidoHelper } from '../bin/lib/gitcred.mjs';
import { obtenerToken, orgsDe } from '../bin/lib/forjas/github.mjs';
import { gruposDe } from '../bin/lib/forjas/gitlab.mjs';
import { viaRemoto } from '../bin/lib/repo.mjs';
import { resumenLogin, conexionNueva, registrarOrgs } from '../bin/flows/login.mjs';
import { cuentaSshInformativa } from '../bin/flows/preparar.mjs';

const u = (login) => ({ login, id: 1, name: null, email: null });
const sinColor = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body), headers: new Map() });

// ---- Almacén: cuentas[login] (misma forma que el plugin) ----
test('guardarToken: un login de OTRA cuenta no borra la anterior (cuentas[login])', () => {
  const cfg = {};
  guardarToken('github.com', { token: 'TOK_A', forja: 'github', user: u('ana-a') }, cfg);
  guardarToken('github.com', { token: 'TOK_B', forja: 'github', user: u('Ana-B') }, cfg);
  const e = cfg.tokens['github.com'];
  assert.equal(e.token, 'TOK_B', 'el primer nivel es el ultimo login, como antes');
  assert.equal(cfg.token, 'TOK_B', 'espejo plano');
  assert.deepEqual(Object.keys(e.cuentas).sort(), ['ana-a', 'ana-b']);
  assert.equal(e.cuentas['ana-a'].token, 'TOK_A');
});

test('guardarToken: almacén antiguo sin cuentas conserva el token previo bajo su user', () => {
  const cfg = { tokens: { 'github.com': { token: 'TOK_A', forja: 'github', user: u('ana-a') } } };
  guardarToken('github.com', { token: 'TOK_B', forja: 'github', user: u('ana-b') }, cfg);
  assert.equal(cfg.tokens['github.com'].cuentas['ana-a'].token, 'TOK_A');
  assert.equal(cfg.tokens['github.com'].cuentas['ana-b'].token, 'TOK_B');
});

test('guardarToken: renovar el MISMO token (sin user) actualiza su cuenta y no crea otra', () => {
  const cfg = {};
  guardarToken('gitlab.com', { token: 'V1', refresh_token: 'R1', forja: 'gitlab', user: { username: 'ana' } }, cfg);
  guardarToken('gitlab.com', { token: 'V2', refresh_token: 'R2', expira: 9, forja: 'gitlab' }, cfg);
  const e = cfg.tokens['gitlab.com'];
  assert.deepEqual(Object.keys(e.cuentas), ['ana']);
  assert.equal(e.cuentas.ana.token, 'V2');
  assert.equal(e.cuentas.ana.refresh_token, 'R2');
});

test('tokenPara con owner: la cuenta que llega a esa org; sin cuenta que llegue, el ultimo login', () => {
  const cfg = { tokens: { 'github.com': { token: 'TOK_B', cuentas: {
    'ana-a': { token: 'TOK_A', orgs: ['orga'] }, 'ana-b': { token: 'TOK_B', orgs: ['orgb'] } } } } };
  assert.equal(tokenPara('github.com', cfg, { env: {}, owner: 'OrgA' }), 'TOK_A');
  assert.equal(tokenPara('github.com', cfg, { env: {}, owner: 'ana-a' }), 'TOK_A', 'repos personales');
  assert.equal(tokenPara('github.com', cfg, { env: {}, owner: 'otra' }), 'TOK_B');
  assert.equal(tokenPara('github.com', cfg, { env: {} }), 'TOK_B');
  assert.equal(tokenPara('github.com', cfg, { env: { GITHUB_TOKEN: 'E' }, owner: 'OrgA' }), 'E', 'el entorno sigue mandando');
});

test('borrarToken: por cuenta borra solo esa (--reautorizar); sin login, el host entero como antes', () => {
  const cfg = {};
  guardarToken('github.com', { token: 'TOK_A', forja: 'github', user: u('ana-a') }, cfg);
  guardarToken('github.com', { token: 'TOK_B', forja: 'github', user: u('ana-b') }, cfg);
  borrarToken('github.com', cfg, 'ana-b');
  const e = cfg.tokens['github.com'];
  assert.deepEqual(Object.keys(e.cuentas), ['ana-a']);
  assert.ok(e.token !== 'TOK_B' && cfg.token !== 'TOK_B', 'el token revocado no sigue en el primer nivel');
  borrarToken('github.com', cfg);
  assert.equal(cfg.tokens['github.com'], undefined);
});

test('gitlab: un repo de SUBGRUPO usa la cuenta de su grupo raíz; entradaPara da su sesión', () => {
  const cfg = { tokens: { 'gitlab.com': { token: 'TOK_A', forja: 'gitlab', user: { username: 'ana-a' }, cuentas: {
    'ana-a': { token: 'TOK_A', user: { username: 'ana-a' }, orgs: ['grupo-a'] },
    'ana-b': { token: 'TOK_B', user: { username: 'ana-b' }, orgs: ['acme'], refresh_token: 'R_B', expira: 1 },
  } } } };
  assert.equal(tokenPara('gitlab.com', cfg, { env: {}, owner: 'Acme/plataforma/equipo' }), 'TOK_B');
  assert.equal(entradaPara('gitlab.com', cfg, 'Acme/plataforma/equipo').refresh_token, 'R_B', 'la renovación usa el refresh_token de ESA cuenta');
  assert.equal(entradaPara('gitlab.com', cfg, 'otro').token, 'TOK_A', 'sin cuenta: el ultimo login');
  assert.deepEqual(cuentasDe('gitlab.com', cfg).map((c) => c.login), ['ana-a', 'ana-b']);
});

test('anotarOrg y guardarOrgs: org comprobada sin duplicar; lista completa con orgs_ts', () => {
  const cfg = {};
  guardarToken('github.com', { token: 'TOK_A', forja: 'github', user: u('ana-a') }, cfg);
  guardarToken('github.com', { token: 'TOK_B', forja: 'github', user: u('ana-b') }, cfg);
  assert.equal(cuentaPara('github.com', cfg, 'OrgA'), null);
  assert.equal(anotarOrg('github.com', cfg, 'ana-a', 'OrgA'), true);
  assert.equal(anotarOrg('github.com', cfg, 'ana-a', 'orga'), false);
  assert.equal(tokenPara('github.com', cfg, { env: {}, owner: 'OrgA' }), 'TOK_A');
  assert.equal(anotarOrg('github.com', cfg, 'nadie', 'OrgA'), false);
  assert.equal(guardarOrgs('github.com', cfg, 'Ana-B', ['OrgB', 'orgb', 'OrgC'], 42), true);
  assert.deepEqual(cfg.tokens['github.com'].cuentas['ana-b'].orgs, ['orgb', 'orgc']);
  assert.equal(cfg.tokens['github.com'].cuentas['ana-b'].orgs_ts, 42);
  assert.equal(guardarOrgs('github.com', cfg, 'nadie', ['x']), false);
});

// ---- Helper de git: elige la cuenta por la org (FARO_ORG) ----
test('helper real: responde con el token de la cuenta de SU org, y el ultimo login si no hay cuenta para ella', (t) => {
  if (spawnSync('sh', ['-c', 'exit 0']).status !== 0) return t.skip('sin sh');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-helper-'));
  try {
    fs.writeFileSync(path.join(home, '.faro.json'), JSON.stringify({ tokens: { 'github.com': { token: 'TOK_B', cuentas: {
      'ana-a': { token: 'TOK_A', orgs: ['orga'] }, 'ana-b': { token: 'TOK_B', orgs: ['orgb'] } } } } }));
    const script = path.join(home, 'helper.sh');
    fs.writeFileSync(script, contenidoHelper());
    const pide = (org) => spawnSync('sh', [script, 'get'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, FARO_ORG: org || '' } }).stdout;
    assert.match(pide('OrgA'), /password=TOK_A/);
    assert.match(pide('OrgB'), /password=TOK_B/);
    assert.match(pide('OtraOrg'), /password=TOK_B/, 'sin cuenta para la org: el ultimo login');
    assert.match(pide(null), /username=x-access-token/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ---- SSH por cuenta: informa, nunca bloquea ----
test('viaRemoto: SSH solo si la clave es de la cuenta de la sesión; con varias cuentas y clave de otra, HTTPS', () => {
  assert.equal(viaRemoto({ sshLogin: 'ana-a', loginTok: 'Ana-A', nCuentas: 2 }), 'ssh');
  assert.equal(viaRemoto({ sshLogin: 'ana-a', loginTok: 'ana-b', nCuentas: 2 }), 'https', 'clave de OTRA cuenta: nunca SSH');
  assert.equal(viaRemoto({ sshLogin: null, loginTok: 'ana-b', nCuentas: 2 }), 'https', 'clave sin verificar y varias cuentas: no se adivina');
  assert.equal(viaRemoto({ sshLogin: null, loginTok: 'ana-b', nCuentas: 1 }), 'detectar', 'una sola cuenta: como siempre');
});

test('cuentaSshInformativa: clave de otra cuenta solo informa (no bloquea) y deja ctx.sshLogin', () => {
  const dichos = [];
  const ctx = { perfil: { host: 'github.com', forja: 'github' }, auth: { login: 'ana-b' } };
  assert.equal(cuentaSshInformativa(ctx, { ssh: () => 'ana-a', decir: (m) => dichos.push(sinColor(m)) }), 'ana-a');
  assert.equal(ctx.sshLogin, 'ana-a');
  assert.match(dichos.join('\n'), /@ana-a.*HTTPS/);
  const ctx2 = { perfil: { host: 'github.com' }, auth: { login: 'ana-a' } };
  cuentaSshInformativa(ctx2, { ssh: () => { throw new Error('sin ssh'); }, decir: () => assert.fail('no debe decir nada') });
  assert.equal(ctx2.sshLogin, null);
});

// ---- faro --login ----
const github = { id: 'github', forja: 'github', host: 'github.com', org: null, plugin: { url: 'https://example.test/plugin.git' } };
const gitlab = { id: 'gitlab', forja: 'gitlab', host: 'gitlab.com', org: null, plugin: { url: 'u' } };

test('resumenLogin: forja/host, cuenta, orgs detectadas y de qué cuenta es la clave SSH', () => {
  const t = sinColor(resumenLogin({ login: 'ana-b' }, github, { scopesOk: true, marketplace: true, orgs: ['orga', 'orgb'], sshLogin: 'ana-a' }).join('\n'));
  assert.match(t, /GitHub.*github\.com.*@ana-b/);
  assert.match(t, /Organizaciones: orga, orgb/);
  assert.match(t, /SSH: tu clave es de @ana-a, no de @ana-b.*HTTPS/);
  const g = sinColor(resumenLogin({ login: 'ana' }, gitlab, { scopesOk: true, marketplace: true, orgs: [], sshLogin: 'ana' }).join('\n'));
  assert.match(g, /Grupos: ninguna/);
  assert.match(g, /SSH: tu clave es de @ana; git puede ir por SSH/);
  const n = sinColor(resumenLogin({ login: 'ana' }, github, { scopesOk: true, marketplace: true, orgs: Array.from({ length: 10 }, (_, i) => `o${i}`), sshLogin: null }).join('\n'));
  assert.match(n, /y 2 más/);
  assert.match(n, /no hay clave válida.*HTTPS/);
  assert.ok(!/--token|pega/i.test(t + g + n), 'nunca se sugiere pegar un token');
});

test('conexionNueva: pregunta SOLO dónde (GitHub, GitLab o forja propia), nunca la org ni un token', async () => {
  const preguntas = [];
  const elegir = (resp) => async (q, ops) => { preguntas.push([q, Object.keys(ops)]); return resp.shift(); };
  const gh = await conexionNueva({}, null, { elegir: elegir(['github']), preguntar: async () => assert.fail('no pregunta nada más') });
  assert.equal(gh.forja, 'github'); assert.equal(gh.host, 'github.com'); assert.equal(gh.org, null, 'ninguna org fija');
  assert.deepEqual(preguntas[0], ['¿Dónde está tu código?', ['github', 'gitlab', 'propia']]);
  const gl = await conexionNueva({}, null, { elegir: elegir(['gitlab']), preguntar: async () => assert.fail('no pregunta nada más') });
  assert.equal(gl.forja, 'gitlab'); assert.equal(gl.org, null);
  // Forja propia: host + qué forja es (si no estaba declarada); se declara en git config (inyectado).
  const declaradas = [];
  const propia = await conexionNueva({}, null, { elegir: elegir(['propia', 'gitlab']), preguntar: async () => 'https://git.example.test/algo',
    leerDeclarada: () => null, declarar: (h, f) => declaradas.push([h, f]) });
  assert.equal(propia.host, 'git.example.test'); assert.equal(propia.forja, 'gitlab');
  assert.deepEqual(declaradas, [['git.example.test', 'gitlab']]);
  for (const [q] of preguntas) assert.ok(!/org|grupo|token/i.test(q), `pregunta de más: ${q}`);
  // Ya declarada: no pregunta qué forja es.
  const yaDecl = await conexionNueva({}, null, { elegir: elegir(['propia']), preguntar: async () => 'ghe.example.test', leerDeclarada: () => 'github', declarar: () => {} });
  assert.equal(yaDecl.forja, 'github'); assert.equal(yaDecl.host, 'ghe.example.test');
});

test('registrarOrgs: lee orgs (GitHub) y grupos raíz (GitLab) por API y los guarda en cuentas[login]', async () => {
  const cfg = {};
  guardarToken('github.com', { token: 'TOK_A', forja: 'github', user: u('ana-a') }, cfg);
  const fGh = async (url) => { assert.match(String(url), /\/user\/orgs\?per_page=100&page=1/); return new Response(JSON.stringify([{ login: 'OrgA' }, { login: 'OrgX' }]), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  const { FORJA_GITHUB } = await import('../bin/lib/forjas/github.mjs');
  let guardado = 0;
  const orgs = await registrarOrgs(cfg, github, FORJA_GITHUB, { token: 'TOK_A', login: 'ana-a' }, { fetchImpl: fGh, guardar: () => { guardado++; } });
  assert.deepEqual(orgs, ['orga', 'orgx']);
  assert.deepEqual(cfg.tokens['github.com'].cuentas['ana-a'].orgs, ['orga', 'orgx']);
  assert.ok(cfg.tokens['github.com'].cuentas['ana-a'].orgs_ts > 0);
  assert.equal(guardado, 1);

  guardarToken('gitlab.com', { token: 'GL', forja: 'gitlab', user: { username: 'ana' } }, cfg);
  const fGl = async (url) => { assert.match(String(url), /groups\?min_access_level=10&top_level_only=true/); return json(200, [{ full_path: 'Acme' }, { full_path: 'Otro' }]); };
  const { FORJA_GITLAB } = await import('../bin/lib/forjas/gitlab.mjs');
  assert.deepEqual(await registrarOrgs(cfg, gitlab, FORJA_GITLAB, { token: 'GL', login: 'ana' }, { fetchImpl: fGl, guardar: () => {} }), ['acme', 'otro']);
  assert.deepEqual(cfg.tokens['gitlab.com'].cuentas.ana.orgs, ['acme', 'otro']);
  // API caída: no se inventa nada.
  assert.equal(await registrarOrgs(cfg, gitlab, FORJA_GITLAB, { token: 'GL', login: 'ana' }, { fetchImpl: async () => json(500, {}), guardar: () => assert.fail() }), null);
});

test('orgsDe y gruposDe: null si la API falla (sin inventar orgs)', async () => {
  assert.equal(await orgsDe('T', 'github.com', { fetchImpl: async () => { throw new Error('red'); } }), null);
  assert.equal(await gruposDe('gitlab.com', 'T', { fetchImpl: async () => json(401, {}) }), null);
});

// ---- obtenerToken: la cuenta de la org, no el último login ----
const CUENTAS = { TOK_A: { login: 'ana-a', orgs: ['orga'] }, TOK_B: { login: 'ana-b', orgs: ['orgb'] } };
function apiFalsa() {
  const llamadas = [];
  globalThis.fetch = async (url, init = {}) => {
    const tok = String((init.headers || {}).Authorization || '').replace(/^(Bearer|token) /, '');
    const c = CUENTAS[tok]; const ruta = new URL(url).pathname; llamadas.push(ruta);
    const r = (st, b) => new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json', 'x-oauth-scopes': 'repo, read:org, workflow, user:email' } });
    if (!c) return r(401, { message: 'Bad credentials' });
    const m = ruta.match(/^\/user\/memberships\/orgs\/(.+)$/);
    if (m) return c.orgs.includes(m[1].toLowerCase()) ? r(200, { state: 'active' }) : r(404, {});
    if (ruta === '/user/emails') return r(200, []);
    if (ruta === '/user') return r(200, { login: c.login, id: 1, name: null, email: null });
    return r(404, {});
  };
  return llamadas;
}
const almacen = () => ({ tokens: { 'github.com': { token: 'TOK_B', forja: 'github', user: { login: 'ana-b' }, cuentas: {
  'ana-a': { token: 'TOK_A', user: { login: 'ana-a' } }, 'ana-b': { token: 'TOK_B', user: { login: 'ana-b' } } } } } });
const perfil = (org) => ({ id: 'p', forja: 'github', host: 'github.com', org, client_id: null });
function sinEntorno() {
  const prev = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, FARO_GITHUB_TOKEN: process.env.FARO_GITHUB_TOKEN };
  process.env.GITHUB_TOKEN = ''; process.env.FARO_GITHUB_TOKEN = '';
  return () => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

test('obtenerToken: el último login es de OrgB, pero para OrgA (org del repo) se usa la cuenta de OrgA', async () => {
  const restaurar = sinEntorno(); const orig = globalThis.fetch; apiFalsa();
  try {
    const cfg = almacen();
    const auth = await obtenerToken(cfg, perfil(null), { owner: 'OrgA', gh: () => null });
    assert.equal(auth.login, 'ana-a');
    assert.equal(auth.token, 'TOK_A');
    assert.deepEqual(cfg.tokens['github.com'].cuentas['ana-a'].orgs, ['orga']);
    assert.equal(cfg.tokens['github.com'].cuentas['ana-b'].token, 'TOK_B', 'la otra cuenta sigue intacta');
  } finally { globalThis.fetch = orig; restaurar(); }
});

test('obtenerToken: si ya se sabe qué cuenta llega a la org, se prueba la primera', async () => {
  const restaurar = sinEntorno(); const orig = globalThis.fetch; const llamadas = apiFalsa();
  try {
    const cfg = almacen(); cfg.tokens['github.com'].cuentas['ana-a'].orgs = ['orga'];
    const auth = await obtenerToken(cfg, perfil('OrgA'), { gh: () => null });
    assert.equal(auth.login, 'ana-a');
    assert.equal(llamadas.filter((r) => r.startsWith('/user/memberships')).length, 1, 'sin probar la cuenta ajena');
  } finally { globalThis.fetch = orig; restaurar(); }
});
