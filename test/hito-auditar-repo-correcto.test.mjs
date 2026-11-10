// 'hito auditar' (y cualquier comando de gestion) opera SIEMPRE sobre el remoto del directorio
// desde el que se ejecuta — nunca sobre otro repo, ni por argumento, ni por estado arrastrado de
// una invocacion anterior en la misma sesion.
//
// El repo se resuelve leyendo 'git remote get-url origin' del CWD real en cada llamada (forge.js
// detect() + ghRepo()); no hay cache entre comandos ni parametro que permita apuntar a otro sitio.
// Esto fija esa garantia con un test, para que un cambio futuro no la rompa sin que algo lo note.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);

function apiFalsa(rutas) {
  const llamadas = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url).replace('https://api.github.com/', ''); const metodo = (opts.method || 'GET').toUpperCase();
    llamadas.push({ metodo, ruta: u });
    for (const [re, fn] of rutas) { const m = u.match(re); if (m && (!fn.metodo || fn.metodo === metodo)) { const r = fn.resp(); return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body), json: async () => r.body }; } }
    return { ok: false, status: 404, text: async () => '{}', json: async () => ({}) };
  };
  return llamadas;
}
const R = (re, resp, metodo) => [re, { resp, metodo }];

async function adaptadorPara(remoteUrl) {
  const mod = await import(`file://${path.join(HOOKS, 'lib', 'github-gestion.js').replace(/\\/g, '/')}`);
  return mod.default({
    ghApi: async (p, opts) => { const r = await fetch(`https://api.github.com/${p}`, opts || {}); return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) }; },
    // ghRepo() real de github.js deriva SIEMPRE de esta llamada a git — nunca de un parametro.
    ghRepo: () => {
      const f = require(path.join(HOOKS, 'lib', 'forge.js')).detect(() => remoteUrl);
      if (f.forge !== 'github' || !f.owner || !f.project) return null;
      return { org: f.owner, repo: f.project };
    },
    sinToken: () => 'SIN_TOKEN', git: () => '', fases: () => [], isDone: () => false,
  });
}
async function correr(fn) {
  const out = []; const log = console.log;
  console.log = (...a) => out.push(a.join(' '));
  try { await fn(); } finally { console.log = log; }
  return out.join('\n');
}

test('hito auditar en el repo A: la llamada va a A, nunca a B', async () => {
  const llamadas = apiFalsa([
    R(/^repos\/org-a\/repo-a\/issues\?state=open&per_page=100&page=1$/, () => ({ status: 200, body: [] })),
  ]);
  process.argv = ['node', 'harness.js', 'hito', 'auditar'];
  const g = await adaptadorPara('git@github.com:org-a/repo-a.git');
  await correr(g.cmdHito);
  assert.ok(llamadas.some((c) => c.ruta.includes('org-a/repo-a')), 'debe consultar el repo A');
  assert.ok(!llamadas.some((c) => c.ruta.includes('org-b') || c.ruta.includes('repo-b')), 'NO debe tocar ningun otro repo');
});

test('la MISMA sesion, apuntando despues a otro remoto: audita B, no arrastra A', async () => {
  // Simula dos invocaciones consecutivas del harness (como dos llamadas de un agente en la misma
  // conversacion) con remotos DISTINTOS — nada debe quedar pegado de la primera a la segunda.
  const llamadasA = apiFalsa([R(/^repos\/org-a\/repo-a\/issues/, () => ({ status: 200, body: [] }))]);
  process.argv = ['node', 'harness.js', 'hito', 'auditar'];
  const gA = await adaptadorPara('git@github.com:org-a/repo-a.git');
  await correr(gA.cmdHito);

  const llamadasB = apiFalsa([R(/^repos\/org-b\/repo-b\/issues/, () => ({ status: 200, body: [] }))]);
  const gB = await adaptadorPara('git@github.com:org-b/repo-b.git');
  await correr(gB.cmdHito);

  assert.ok(llamadasB.some((c) => c.ruta.includes('org-b/repo-b')), 'la segunda invocacion debe ir a B');
  assert.ok(!llamadasB.some((c) => c.ruta.includes('org-a') || c.ruta.includes('repo-a')), 'NADA de la invocacion anterior (A) debe colarse en esta (B)');
});

test('ghRepo() (forge.detect) se recalcula en CADA llamada: no memoriza el remoto anterior', () => {
  let remoto = 'git@github.com:org-a/repo-a.git';
  const detect = () => require(path.join(HOOKS, 'lib', 'forge.js')).detect(() => remoto);
  assert.strictEqual(detect().owner, 'org-a', 'primera lectura: org-a');
  remoto = 'git@github.com:org-c/repo-c.git';   // el remoto "cambia" (como al cambiar de directorio)
  assert.strictEqual(detect().owner, 'org-c', 'debe seguir al remoto NUEVO, no quedarse en org-a');
});
