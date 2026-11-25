// Varias cuentas en la MISMA forja (#28): conectarse con la cuenta de otra organizacion no puede
// borrar la anterior, y cada repo usa la cuenta que llega a su organizacion. La API falsa corre en
// OTRO proceso (las consultas son sincronas) y responde segun el token. HOME aislado.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks', 'lib', 'credenciales.js');
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${n}-`));

// cuentas: { <token>: { login, orgs: [..] } }. Cuenta las peticiones para afirmar sobre el reintento.
const SERVIDOR = `
const http = require('http'); const fs = require('fs');
const cuentas = JSON.parse(process.argv[1]); const fichero = process.argv[2];
http.createServer((q, s) => {
  fs.appendFileSync(fichero, q.url + '\\n');
  const c = cuentas[String(q.headers.authorization || '').replace('Bearer ', '')];
  const r = (st, b) => { s.writeHead(st, { 'Content-Type': 'application/json' }); s.end(JSON.stringify(b)); };
  if (q.url.startsWith('/oauth/token')) return r(200, { access_token: 'NUEVO_B', refresh_token: 'R2', expires_in: 7200 });
  if (!c) return r(401, { message: 'Bad credentials' });
  if (q.url.startsWith('/user/orgs')) return r(200, c.orgs.map((login) => ({ login })));
  if (q.url.startsWith('/user')) return r(200, { login: c.login, id: 1, name: null });
  r(404, {});
}).listen(0, '127.0.0.1', function () { process.stdout.write('PORT:' + this.address().port + '\\n'); });`;
async function api(cuentas) {
  const fichero = path.join(tmp('reqs'), 'peticiones.txt');
  const hijo = spawn(process.execPath, ['-e', SERVIDOR, JSON.stringify(cuentas), fichero], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((ok, ko) => {
    let buf = ''; hijo.stdout.on('data', (d) => { buf += d; const m = buf.match(/PORT:(\d+)/); if (m) ok(m[1]); });
    hijo.on('exit', (c) => ko(new Error('API falsa termino con ' + c)));
  });
  return { base: `http://127.0.0.1:${port}/`, peticiones: () => { try { return fs.readFileSync(fichero, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } }, cerrar: () => hijo.kill() };
}
async function cred(contenido, base) {
  const home = tmp('home');
  process.env.FARO_CONFIG_PATH = path.join(home, '.faro.json');
  process.env.FARO_GITHUB_TOKEN = ''; process.env.GITHUB_TOKEN = '';
  process.env.FARO_API_BASE = base;
  fs.writeFileSync(process.env.FARO_CONFIG_PATH, JSON.stringify(contenido));
  const mod = await import(`file://${LIB.replace(/\\/g, '/')}?t=${Date.now()}${Math.random()}`);
  return { c: mod.default(), fichero: process.env.FARO_CONFIG_PATH };
}
const CUENTAS = { TOK_A: { login: 'ana-a', orgs: ['OrgA'] }, TOK_B: { login: 'ana-b', orgs: ['OrgB'] } };
const user = (login) => ({ login, name: null, email: null });

test('dos logins en github.com: el segundo no borra el primero y cada org usa su cuenta', async () => {
  const s = await api(CUENTAS);
  try {
    const { c } = await cred({}, s.base);
    c.guardarToken('github.com', { token: 'TOK_A', user: user('ana-a'), forja: 'github' });
    c.guardarToken('github.com', { token: 'TOK_B', user: user('ana-b'), forja: 'github' });
    assert.strictEqual(c.tokenPara('github.com', 'OrgA'), 'TOK_A');
    assert.strictEqual(c.tokenPara('github.com', 'orgb'), 'TOK_B', 'el owner se compara sin mayusculas');
    assert.strictEqual(c.tokenPara('github.com'), 'TOK_B', 'sin owner: el ultimo login, como antes');
    assert.strictEqual(c.tokenPara('github.com', 'ana-a'), 'TOK_A', 'los repos personales son de la propia cuenta');
  } finally { s.cerrar(); }
});

test('otro programa escribe un token nuevo con el user VIEJO: se identifica por la API, no por el campo', async () => {
  const s = await api(CUENTAS);
  try {
    // Lo que deja el wizard al ampliar scopes: token de B con el user de A todavia en la entrada.
    const { c, fichero } = await cred({ tokens: { 'github.com': { token: 'TOK_B', user: user('ana-a'), forja: 'github', cuentas: { 'ana-a': { token: 'TOK_A', user: user('ana-a'), orgs: ['orga'], orgs_ts: Date.now() } } } } }, s.base);
    assert.strictEqual(c.tokenPara('github.com', 'OrgB'), 'TOK_B');
    assert.strictEqual(c.tokenPara('github.com', 'OrgA'), 'TOK_A', 'la cuenta de A sigue intacta');
    const cs = JSON.parse(fs.readFileSync(fichero, 'utf8')).tokens['github.com'].cuentas;
    assert.deepStrictEqual(Object.keys(cs).sort(), ['ana-a', 'ana-b']);
    assert.strictEqual(cs['ana-a'].token, 'TOK_A');
  } finally { s.cerrar(); }
});

test('almacen antiguo (solo primer nivel): un login nuevo identifica y conserva el token anterior', async () => {
  const s = await api(CUENTAS);
  try {
    const { c } = await cred({ token: 'TOK_A', tokens: { 'github.com': { token: 'TOK_A', forja: 'github' } } }, s.base);
    c.guardarToken('github.com', { token: 'TOK_B', user: user('ana-b'), forja: 'github' });
    assert.strictEqual(c.tokenPara('github.com', 'OrgA'), 'TOK_A');
    assert.strictEqual(c.tokenPara('github.com', 'OrgB'), 'TOK_B');
  } finally { s.cerrar(); }
});

test('sin cuenta para esa org: primer nivel, y no se reconsulta la API en cada llamada', async () => {
  const s = await api(CUENTAS);
  try {
    const { c } = await cred({}, s.base);
    c.guardarToken('github.com', { token: 'TOK_A', user: user('ana-a'), forja: 'github' });
    assert.strictEqual(c.tokenPara('github.com', 'OtraOrg'), 'TOK_A');
    const n = s.peticiones().length;
    assert.strictEqual(c.tokenPara('github.com', 'OtraOrg'), 'TOK_A');
    assert.strictEqual(s.peticiones().length, n, 'las orgs se reconsultan como mucho cada hora');
  } finally { s.cerrar(); }
});

test('API caida: no rompe, se usa el primer nivel', async () => {
  const { c } = await cred({ tokens: { 'github.com': { token: 'TOK_X', forja: 'github' } } }, 'http://127.0.0.1:9/');
  assert.strictEqual(c.tokenPara('github.com', 'OrgA'), 'TOK_X');
});

test('gitlab: la cuenta del grupo caducada se renueva en SU entrada; el primer nivel (otra cuenta) no se toca', async () => {
  const s = await api(CUENTAS);
  try {
    process.env.FARO_OAUTH_TOKEN_URL = s.base + 'oauth/token';
    process.env.FARO_GITLAB_TOKEN = ''; process.env.GITLAB_TOKEN = '';
    const viejo = { token: 'VIEJO_B', refresh_token: 'R1', expira: Date.now() - 1000, client_id: 'app', forja: 'gitlab', user: { username: 'ana-b' }, orgs: ['grupo-b'], orgs_ts: Date.now() };
    const { c, fichero } = await cred({ tokens: { 'gitlab.com': { token: 'TOK_A', forja: 'gitlab', cuentas: { 'ana-a': { token: 'TOK_A', orgs: ['grupo-a'], orgs_ts: Date.now() }, 'ana-b': viejo } } } }, s.base);
    assert.strictEqual(c.tokenPara('gitlab.com', 'grupo-b'), 'NUEVO_B');
    const e = JSON.parse(fs.readFileSync(fichero, 'utf8')).tokens['gitlab.com'];
    assert.strictEqual(e.cuentas['ana-b'].token, 'NUEVO_B');
    assert.strictEqual(e.cuentas['ana-b'].refresh_token, 'R2');
    assert.strictEqual(e.token, 'TOK_A', 'el ultimo login sigue siendo el de A');
  } finally { s.cerrar(); delete process.env.FARO_OAUTH_TOKEN_URL; }
});
