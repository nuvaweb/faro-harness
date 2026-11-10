// Renovacion automatica del token OAuth (0.21.0): tokenPara(host) canjea el refresh_token cuando el
// token esta caducado o a punto, de forma SINCRONA, y lo persiste. El servidor OAuth falso corre en
// OTRO proceso: una llamada sincrona bloquea el bucle de eventos del proceso que la hace, asi que un
// servidor en el mismo proceso jamas responderia (reproducido). HOME aislado: no se toca el real.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks', 'lib', 'credenciales.js');
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${n}-`));

// Servidor OAuth falso en proceso aparte. 'respuestas': [{status, body}] por orden de llamada (la
// ultima se repite). Deja cada peticion recibida en un fichero para poder afirmar sobre ella.
const SERVIDOR = `
const http = require('http'); const fs = require('fs');
const respuestas = JSON.parse(process.argv[1]); const fichero = process.argv[2]; let n = 0;
http.createServer((q, s) => { let b = ''; q.on('data', (d) => (b += d)); q.on('end', () => {
  fs.appendFileSync(fichero, JSON.stringify(Object.fromEntries(new URLSearchParams(b))) + '\\n');
  const r = respuestas[Math.min(n++, respuestas.length - 1)];
  s.writeHead(r.status, { 'Content-Type': 'application/json' }); s.end(JSON.stringify(r.body));
}); }).listen(0, '127.0.0.1', function () { process.stdout.write('PORT:' + this.address().port + '\\n'); });`;
async function servidor(respuestas) {
  const fichero = path.join(tmp('reqs'), 'peticiones.jsonl');
  const hijo = spawn(process.execPath, ['-e', SERVIDOR, JSON.stringify(respuestas), fichero], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((ok, ko) => {
    let buf = ''; hijo.stdout.on('data', (d) => { buf += d; const m = buf.match(/PORT:(\d+)/); if (m) ok(m[1]); });
    hijo.on('exit', (c) => ko(new Error('servidor falso termino con ' + c)));
  });
  return {
    url: `http://127.0.0.1:${port}/oauth/token`,
    peticiones: () => { try { return fs.readFileSync(fichero, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } },
    cerrar: () => hijo.kill(),
  };
}
// Credenciales con HOME aislado y una entrada de gitlab.com con la forma que deja el wizard.
async function cred(entrada, urlOAuth) {
  const home = tmp('home');
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.FARO_CONFIG_PATH = path.join(home, '.faro.json');
  process.env.FARO_GITLAB_TOKEN = ''; process.env.GITLAB_TOKEN = '';
  if (urlOAuth) process.env.FARO_OAUTH_TOKEN_URL = urlOAuth; else delete process.env.FARO_OAUTH_TOKEN_URL;
  fs.writeFileSync(path.join(home, '.faro.json'), JSON.stringify({ tokens: { 'gitlab.com': entrada } }));
  const mod = await import(`file://${LIB.replace(/\\/g, '/')}?t=${Date.now()}`);
  return { c: mod.default(), fichero: path.join(home, '.faro.json') };
}
const leer = (f) => JSON.parse(fs.readFileSync(f, 'utf8')).tokens['gitlab.com'];

test('token CADUCADO con refresh_token: se renueva, devuelve el nuevo y persiste refresh rotado + expira', async () => {
  const s = await servidor([{ status: 200, body: { access_token: 'NUEVO', refresh_token: 'REFRESH2', expires_in: 7200, created_at: Math.floor(Date.now() / 1000) } }]);
  try {
    const { c, fichero } = await cred({ token: 'VIEJO', refresh_token: 'REFRESH1', expira: Date.now() - 1000, client_id: 'app1', forja: 'gitlab' }, s.url);
    assert.strictEqual(c.tokenPara('gitlab.com'), 'NUEVO');
    const p = s.peticiones();
    assert.strictEqual(p.length, 1);
    assert.strictEqual(p[0].grant_type, 'refresh_token'); assert.strictEqual(p[0].refresh_token, 'REFRESH1'); assert.strictEqual(p[0].client_id, 'app1');
    const e = leer(fichero);
    assert.strictEqual(e.token, 'NUEVO'); assert.strictEqual(e.refresh_token, 'REFRESH2', 'el refresh es rotatorio: hay que guardar el nuevo');
    assert.ok(e.expira > Date.now() + 7000 * 1000, 'expira debe quedar ~2h en el futuro');
    assert.ok(e.renovado, 'debe dejar constancia de cuando se renovo');
  } finally { s.cerrar(); }
});

test('token VIGENTE (lejos de caducar): NO se toca la red y se devuelve tal cual', async () => {
  const s = await servidor([{ status: 200, body: { access_token: 'NO-DEBERIA' } }]);
  try {
    const { c } = await cred({ token: 'VIGENTE', refresh_token: 'R', expira: Date.now() + 3600 * 1000, client_id: 'app1' }, s.url);
    assert.strictEqual(c.tokenPara('gitlab.com'), 'VIGENTE');
    assert.strictEqual(s.peticiones().length, 0, 'sin llamada: no tocaba renovar');
  } finally { s.cerrar(); }
});

test('a MENOS de 5 minutos de caducar: se renueva de forma preventiva', async () => {
  const s = await servidor([{ status: 200, body: { access_token: 'ANTICIPADO', refresh_token: 'R2', expires_in: 7200 } }]);
  try {
    const { c } = await cred({ token: 'CASI', refresh_token: 'R', expira: Date.now() + 2 * 60 * 1000, client_id: 'app1' }, s.url);
    assert.strictEqual(c.tokenPara('gitlab.com'), 'ANTICIPADO'); assert.strictEqual(s.peticiones().length, 1);
  } finally { s.cerrar(); }
});

test('CADUCADO y la renovacion FALLA: devuelve null (SIN_TOKEN honesto), no un token muerto', async () => {
  const s = await servidor([{ status: 401, body: { error: 'invalid_grant' } }]);
  try {
    const { c, fichero } = await cred({ token: 'MUERTO', refresh_token: 'R', expira: Date.now() - 1000, client_id: 'app1' }, s.url);
    assert.strictEqual(c.tokenPara('gitlab.com'), null);
    assert.strictEqual(s.peticiones().length, 1, 'debe haberlo intentado');
    assert.strictEqual(leer(fichero).token, 'MUERTO', 'un fallo de renovacion no debe corromper lo guardado');
  } finally { s.cerrar(); }
});

test('token PERSONAL (sin refresh_token): no cambia nada, se devuelve aunque tenga expira', async () => {
  const { c } = await cred({ token: 'PAT', expira: Date.now() - 1000, forja: 'gitlab' }, null);
  assert.strictEqual(c.tokenPara('gitlab.com'), 'PAT');
});

test('tras una renovacion FALLIDA no se reintenta en cada llamada: 10 min de espera (sin proceso hijo por prompt)', async () => {
  const s = await servidor([{ status: 401, body: { error: 'invalid_grant' } }]);
  try {
    const { c, fichero } = await cred({ token: 'MUERTO', refresh_token: 'R', expira: Date.now() - 1000, client_id: 'app1' }, s.url);
    assert.strictEqual(c.tokenPara('gitlab.com'), null);
    assert.strictEqual(c.tokenPara('gitlab.com'), null);
    assert.strictEqual(c.tokenPara('gitlab.com'), null);
    assert.strictEqual(s.peticiones().length, 1, 'solo el primer intento debe tocar la red');
    assert.ok(leer(fichero).renovacion_fallida, 'debe quedar registrado el fallo para el backoff');
  } finally { s.cerrar(); }
});
