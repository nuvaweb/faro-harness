// integrarPorPeticion (#194): cuando la forja rechaza el push a una rama protegida (main), el harness
// integra por la API con el token que ya guarda — abre (o reutiliza) la peticion head -> base y la
// fusiona — en vez de mandar al usuario a "subir a mano" o a la web. Misma intencion en las dos forjas.
// API simulada: sin red.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${n}-`));

function apiFalsa(base, rutas) {
  const llamadas = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url).replace(base, ''); const metodo = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null; llamadas.push({ metodo, ruta: u, body });
    for (const [re, fn] of rutas) { const m = u.match(re); if (m && (!fn.metodo || fn.metodo === metodo)) { const r = fn.resp(m, body); return { ok: r.status < 400, status: r.status, json: async () => r.body }; } }
    return { ok: false, status: 404, json: async () => ({ message: '404 ' + u }) };
  };
  return llamadas;
}
const R = (re, resp, metodo) => [re, { resp, metodo }];

async function github() {
  const mod = await import(`file://${path.join(HOOKS, 'lib', 'github.js').replace(/\\/g, '/')}`);
  const cfg = path.join(tmp('home'), '.faro.json');
  fs.writeFileSync(cfg, JSON.stringify({ tokens: { 'github.com': { token: 'tok', forja: 'github', user: { login: 'fer' } } } }));
  process.env.FARO_CONFIG_PATH = cfg; process.env.FARO_GITHUB_TOKEN = ''; process.env.GITHUB_TOKEN = '';
  return mod.default({
    ROOT: tmp('root'), IS_TEMPLATE: false, specBase: 'gestion/cambios',
    git: (...a) => (a[0] === 'remote' ? 'https://github.com/org/repo.git' : ''),
    forge: () => ({ forge: 'github', host: 'github.com', owner: 'org', project: 'repo', path: 'org/repo' }),
    fases: () => [], isDone: () => false, isActive: () => false,
  });
}
async function gitlab() {
  const mod = await import(`file://${path.join(HOOKS, 'lib', 'forge-gitlab.js').replace(/\\/g, '/')}`);
  process.env.FARO_CONFIG_PATH = path.join(tmp('home'), '.faro.json');
  return mod.default({ ROOT: tmp('root'), git: () => '', specBase: 'x', forge: () => ({ forge: 'gitlab', host: 'gitlab.com', owner: 'g', project: 'p', path: 'g/p' }), tokenPara: () => 'tok', guardarToken: () => {}, faroSchema: () => ({}), fases: () => [], isDone: () => false, isActive: () => false });
}

const GH = 'https://api.github.com/';
test('GitHub: sin peticion abierta develop -> main, la abre y la fusiona (merge, no squash)', async () => {
  const ll = apiFalsa(GH, [
    R(/^repos\/org\/repo\/pulls\?state=open&head=org:develop&base=main/, () => ({ status: 200, body: [] }), 'GET'),
    R(/^repos\/org\/repo\/pulls$/, () => ({ status: 201, body: { number: 9, html_url: 'u9' } }), 'POST'),
    R(/^user$/, () => ({ status: 200, body: { login: 'fer' } })),
    R(/^repos\/org\/repo\/pulls\/9\/merge$/, () => ({ status: 200, body: { merged: true, sha: 'abc1234' } }), 'PUT'),
  ]);
  const a = await github();
  const r = await a.integrarPorPeticion({ head: 'develop', base: 'main', titulo: 'Publicar 1.2.0', cuerpo: 'x' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.numero, 9); assert.strictEqual(r.sha, 'abc1234');
  const merge = ll.find((l) => l.metodo === 'PUT');
  assert.strictEqual(merge.body.merge_method, 'merge', 'develop -> main conserva la historia (no squash)');
  assert.ok(!ll.some((l) => l.metodo === 'DELETE'), 'NUNCA borra develop tras fusionar');
});

test('GitHub: si ya hay peticion abierta develop -> main, la reutiliza (no abre otra)', async () => {
  const ll = apiFalsa(GH, [
    R(/^repos\/org\/repo\/pulls\?state=open&head=org:develop&base=main/, () => ({ status: 200, body: [{ number: 4, html_url: 'u4' }] }), 'GET'),
    R(/^repos\/org\/repo\/pulls\/4\/merge$/, () => ({ status: 200, body: { merged: true, sha: 'def5678' } }), 'PUT'),
  ]);
  const a = await github();
  const r = await a.integrarPorPeticion({ head: 'develop', base: 'main', titulo: 'T' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.numero, 4);
  assert.ok(!ll.some((l) => l.metodo === 'POST'), 'no abre una segunda peticion');
});

test('GitHub: si la forja no fusiona (checks pendientes, conflicto), lo dice con su motivo y la peticion', async () => {
  apiFalsa(GH, [
    R(/^repos\/org\/repo\/pulls\?state=open/, () => ({ status: 200, body: [{ number: 4, html_url: 'u4' }] }), 'GET'),
    R(/^repos\/org\/repo\/pulls\/4\/merge$/, () => ({ status: 405, body: { message: 'Required status check "test" is expected.' } }), 'PUT'),
  ]);
  const a = await github();
  const r = await a.integrarPorPeticion({ head: 'develop', base: 'main', titulo: 'T' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.numero, 4);
  assert.match(r.msg, /Required status check/);
  assert.match(r.msg, /u4/, 'deja el enlace a la peticion abierta');
});

test('GitHub: sin token no inventa nada', async () => {
  apiFalsa(GH, []);
  const a = await github();
  process.env.FARO_CONFIG_PATH = path.join(tmp('vacio'), '.faro.json');
  const r = await a.integrarPorPeticion({ head: 'develop', base: 'main', titulo: 'T' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.sinToken, JSON.stringify(r));
});

const GL = 'https://gitlab.com/api/v4/';
test('GitLab: abre la peticion SIN borrar la rama origen (develop) y la fusiona', async () => {
  const ll = apiFalsa(GL, [
    R(/^projects\/g%2Fp\/merge_requests\?state=opened&source_branch=develop&target_branch=main/, () => ({ status: 200, body: [] }), 'GET'),
    R(/^projects\/g%2Fp\/merge_requests$/, () => ({ status: 201, body: { iid: 3, web_url: 'm3' } }), 'POST'),
    R(/^projects\/g%2Fp\/merge_requests\/3\/merge$/, () => ({ status: 200, body: { state: 'merged', merge_commit_sha: 'aaa1111' } }), 'PUT'),
  ]);
  const a = await gitlab();
  const r = await a.integrarPorPeticion({ head: 'develop', base: 'main', titulo: 'T' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.numero, 3); assert.strictEqual(r.sha, 'aaa1111');
  const crea = ll.find((l) => l.metodo === 'POST');
  assert.strictEqual(crea.body.remove_source_branch, false, 'develop NO se borra');
  const merge = ll.find((l) => l.metodo === 'PUT');
  assert.strictEqual(merge.body.should_remove_source_branch, false);
  assert.notStrictEqual(merge.body.squash, true);
});

test('GitHub: recien abierta, si la forja aun calcula la fusionabilidad (405), reintenta y fusiona', async () => {
  let intentos = 0;
  apiFalsa(GH, [
    R(/^repos\/org\/repo\/pulls\?state=open/, () => ({ status: 200, body: [{ number: 4, html_url: 'u4' }] }), 'GET'),
    R(/^repos\/org\/repo\/pulls\/4\/merge$/, () => (++intentos < 3 ? { status: 405, body: { message: 'Pull Request is not mergeable' } } : { status: 200, body: { merged: true, sha: 'abc' } }), 'PUT'),
  ]);
  const a = await github();
  const r = await a.integrarPorPeticion({ head: 'develop', base: 'main', titulo: 'T', esperaMs: 0 });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(intentos, 3);
});

test('GitLab: la MR recien abierta responde 405 mientras GitLab calcula; reintenta y fusiona', async () => {
  let intentos = 0;
  apiFalsa(GL, [
    R(/^projects\/g%2Fp\/merge_requests\?state=opened/, () => ({ status: 200, body: [{ iid: 3, web_url: 'm3' }] }), 'GET'),
    R(/^projects\/g%2Fp\/merge_requests\/3\/merge$/, () => (++intentos < 2 ? { status: 405, body: { message: '405 Method Not Allowed' } } : { status: 200, body: { state: 'merged', merge_commit_sha: 'bbb' } }), 'PUT'),
  ]);
  const a = await gitlab();
  const r = await a.integrarPorPeticion({ head: 'develop', base: 'main', titulo: 'T', esperaMs: 0 });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(intentos, 2);
});

// #262: la fusion por API manda el SHA de cabeza de la peticion (GitLab lo exige con require_sha_for_merge).
test('GitHub: integrarPorPeticion manda el SHA de cabeza de la peticion', async () => {
  const ll = apiFalsa(GH, [
    R(/^repos\/org\/repo\/pulls\?state=open/, () => ({ status: 200, body: [{ number: 4, html_url: 'u4', head: { sha: 'cafe1234' } }] }), 'GET'),
    R(/^repos\/org\/repo\/pulls\/4$/, () => ({ status: 200, body: { number: 4, head: { sha: 'cafe1234' } } }), 'GET'),
    R(/^repos\/org\/repo\/pulls\/4\/merge$/, () => ({ status: 200, body: { merged: true, sha: 'abc' } }), 'PUT'),
  ]);
  const a = await github();
  const r = await a.integrarPorPeticion({ head: 'develop', base: 'main', titulo: 'T' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(ll.find((l) => l.metodo === 'PUT').body.sha, 'cafe1234');
});

test('GitLab: integrarPorPeticion manda el SHA de cabeza de la MR (require_sha_for_merge)', async () => {
  const ll = apiFalsa(GL, [
    R(/^projects\/g%2Fp\/merge_requests\?state=opened/, () => ({ status: 200, body: [{ iid: 3, web_url: 'm3', sha: 'cafe1234' }] }), 'GET'),
    R(/^projects\/g%2Fp\/merge_requests\/3$/, () => ({ status: 200, body: { iid: 3, sha: 'cafe1234', diff_refs: { head_sha: 'cafe1234' } } }), 'GET'),
    R(/^projects\/g%2Fp\/merge_requests\/3\/merge$/, () => ({ status: 200, body: { state: 'merged', merge_commit_sha: 'aaa' } }), 'PUT'),
  ]);
  const a = await gitlab();
  const r = await a.integrarPorPeticion({ head: 'develop', base: 'main', titulo: 'T' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(ll.find((l) => l.metodo === 'PUT').body.sha, 'cafe1234');
});

// #262: recien creada, GitLab puede no haber calculado aun el SHA de la MR. Quien llama sabe que commit
// acaba de subir: ese manda (y si la forja tiene otro, 409 en vez de fusionar algo distinto).
test('GitLab: con el SHA esperado del que llama, lo manda aunque la MR aun no lo traiga', async () => {
  const ll = apiFalsa(GL, [
    R(/^projects\/g%2Fp\/merge_requests\?state=opened/, () => ({ status: 200, body: [] }), 'GET'),
    R(/^projects\/g%2Fp\/merge_requests$/, () => ({ status: 201, body: { iid: 3, web_url: 'm3' } }), 'POST'),
    R(/^projects\/g%2Fp\/merge_requests\/3$/, () => ({ status: 200, body: { iid: 3, sha: null } }), 'GET'),
    R(/^projects\/g%2Fp\/merge_requests\/3\/merge$/, () => ({ status: 200, body: { state: 'merged', merge_commit_sha: 'aaa' } }), 'PUT'),
  ]);
  const a = await gitlab();
  const r = await a.integrarPorPeticion({ head: 'develop', base: 'main', titulo: 'T', sha: 'beef5678' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(ll.find((l) => l.metodo === 'PUT').body.sha, 'beef5678');
});

test('GitHub: con el SHA esperado del que llama, lo manda', async () => {
  const ll = apiFalsa(GH, [
    R(/^repos\/org\/repo\/pulls\?state=open/, () => ({ status: 200, body: [{ number: 4, html_url: 'u4' }] }), 'GET'),
    R(/^repos\/org\/repo\/pulls\/4\/merge$/, () => ({ status: 200, body: { merged: true, sha: 'abc' } }), 'PUT'),
  ]);
  const a = await github();
  const r = await a.integrarPorPeticion({ head: 'develop', base: 'main', titulo: 'T', sha: 'beef5678' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(ll.find((l) => l.metodo === 'PUT').body.sha, 'beef5678');
});
