// 'hito cerrar' valida igual que 'hito sync': un hito NO se cierra con issues abiertos dentro.
//
// El cierre forzoso (0.31.2) vivia SOLO en syncHitos(). 'hito cerrar <titulo>' cerraba el hito
// aunque tuviera 20 tareas abiertas — se saltaba el control por la puerta de al lado. La regla es
// critica y estricta: si queda trabajo abierto en la fase, la fase no se cierra. Punto.
//
// Igual que en sync, el motor DETECTA y se niega; nunca cierra las tareas en cascada (cerrar un
// issue es afirmar "esto esta hecho", y eso no lo decide el motor por nadie).
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
    const u = String(url).replace('https://api.github.com/', ''); const metodo = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : null;
    llamadas.push({ metodo, ruta: u, body });
    for (const [re, fn] of rutas) { const m = u.match(re); if (m && (!fn.metodo || fn.metodo === metodo)) { const r = fn.resp(m, body); return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body), json: async () => r.body }; } }
    return { ok: false, status: 404, text: async () => '{}', json: async () => ({ message: 'Not Found' }) };
  };
  return llamadas;
}
const R = (re, resp, metodo) => [re, { resp, metodo }];

async function adaptador() {
  const mod = await import(`file://${path.join(HOOKS, 'lib', 'github-gestion.js').replace(/\\/g, '/')}`);
  return mod.default({
    ghApi: async (p, opts) => {
      const r = await fetch(`https://api.github.com/${p}`, opts || {});
      const body = r.status < 500 ? await r.json().catch(() => null) : null;
      return { ok: r.ok, status: r.status, body };
    },
    ghRepo: () => ({ org: 'org', repo: 'repo' }),
    sinToken: () => 'SIN_TOKEN',
    git: () => '',
    fases: () => [],
    isDone: (e) => e === 'done',
  });
}
async function correr(fn, argv) {
  const out = []; const log = console.log; const wr = process.stdout.write.bind(process.stdout);
  const exit = process.exit; let codigo = null;
  console.log = (...a) => out.push(a.join(' '));
  process.stdout.write = (s) => { out.push(String(s).replace(/\n$/, '')); return true; };
  process.exit = (c) => { codigo = c; throw new Error('__exit__'); };
  process.argv = ['node', 'harness.js', ...argv];
  try { await fn(); } catch (e) { if (e.message !== '__exit__') throw e; } finally { console.log = log; process.stdout.write = wr; process.exit = exit; }
  return { out: out.join('\n'), codigo };
}

const HITO_CON_ABIERTAS = { number: 3, title: 'Fase 1 — Fundamentos', state: 'open', open_issues: 4, closed_issues: 6, html_url: 'u' };
const HITO_LIMPIO = { number: 3, title: 'Fase 1 — Fundamentos', state: 'open', open_issues: 0, closed_issues: 10, html_url: 'u' };

test('hito cerrar: con issues ABIERTOS dentro se NIEGA y no toca la forja', async () => {
  const llamadas = apiFalsa([R(/^repos\/org\/repo\/milestones\?/, () => ({ status: 200, body: [HITO_CON_ABIERTAS] }))]);
  const g = await adaptador();
  const r = await correr(g.cmdHito, ['hito', 'cerrar', 'Fase 1 — Fundamentos']);
  assert.match(r.out, /4 tarea\(s\) abierta\(s\)/, r.out);
  assert.ok(!llamadas.some((c) => c.metodo === 'PATCH'), 'no debe cerrar el hito');
  assert.strictEqual(r.codigo, 1, 'debe salir con error: es un gate, no un aviso');
});

test('hito cerrar: el mensaje dice COMO resolverlo (no solo que no se puede)', async () => {
  apiFalsa([R(/^repos\/org\/repo\/milestones\?/, () => ({ status: 200, body: [HITO_CON_ABIERTAS] }))]);
  const g = await adaptador();
  const r = await correr(g.cmdHito, ['hito', 'cerrar', 'Fase 1 — Fundamentos']);
  assert.match(r.out, /cerrar-tarea|mover-tarea|descartar-tarea/, `debe ofrecer la salida:\n${r.out}`);
});

test('hito cerrar: SIN issues abiertos se cierra normalmente', async () => {
  const llamadas = apiFalsa([
    R(/^repos\/org\/repo\/milestones\?/, () => ({ status: 200, body: [HITO_LIMPIO] })),
    R(/^repos\/org\/repo\/milestones\/3$/, (_m, b) => ({ status: 200, body: { ...HITO_LIMPIO, ...b } }), 'PATCH'),
    R(/^repos\/org\/repo\/milestones\/3$/, () => ({ status: 200, body: { ...HITO_LIMPIO, state: 'closed' } })),
  ]);
  const g = await adaptador();
  const r = await correr(g.cmdHito, ['hito', 'cerrar', 'Fase 1 — Fundamentos']);
  assert.match(r.out, /cerrado/, r.out);
  assert.ok(llamadas.some((c) => c.metodo === 'PATCH'), 'un hito sin tareas abiertas si se cierra');
});

// LIMITE REAL: el harness NO corre en el servidor. Si alguien cierra el hito desde la WEB, no hay
// forma de impedirlo — y tampoco hace falta: cerrarlo ahi puede ser perfectamente correcto si el
// trabajo se hizo. Lo que toca es VERIFICAR si ese cierre fue adecuado, con evidencia DETERMINISTA:
// cada tarea que siga abierta, ¿tiene un PR fusionado que la cierre, o quedo colgando de verdad?
// El comando 'hito verificar <titulo>' hace ese contraste y lo dice tarea a tarea.
test('hito verificar: un hito cerrado con tareas abiertas SIN evidencia -> las senala como colgadas', async () => {
  apiFalsa([
    R(/^repos\/org\/repo\/milestones\?/, () => ({ status: 200, body: [{ ...HITO_CON_ABIERTAS, state: 'closed' }] })),
    R(/^repos\/org\/repo\/issues\?milestone=3/, () => ({ status: 200, body: [
      { number: 11, title: 'Sin terminar', state: 'open', html_url: 'u' },
    ] })),
    // Sin PR que la cierre: la busqueda no devuelve nada.
    R(/^search\/issues\?q=/, () => ({ status: 200, body: { total_count: 0, items: [] } })),
  ]);
  const g = await adaptador();
  const r = await correr(g.cmdHito, ['hito', 'verificar', 'Fase 1 — Fundamentos']);
  assert.match(r.out, /#11/, r.out);
  assert.match(r.out, /sin evidencia|colgad|NO/i, `debe decir que esa tarea no tiene respaldo:\n${r.out}`);
});

test('hito verificar: una tarea abierta CON PR fusionado que la cierra -> el cierre del hito fue correcto', async () => {
  apiFalsa([
    R(/^repos\/org\/repo\/milestones\?/, () => ({ status: 200, body: [{ ...HITO_CON_ABIERTAS, state: 'closed' }] })),
    R(/^repos\/org\/repo\/issues\?milestone=3/, () => ({ status: 200, body: [
      { number: 11, title: 'Hecha pero sin cerrar', state: 'open', html_url: 'u' },
    ] })),
    // Hay un PR FUSIONADO en develop que la cierra ('Closes #11'): evidencia determinista (#71, misma
    // regla que consolidar y publicar — ya no se busca el numero como texto libre).
    R(/^repos\/org\/repo\/pulls\?/, () => ({ status: 200, body: [{ number: 77, title: 'feat: lo de la 11', body: 'Closes #11', head: { ref: 'feat/x' }, base: { ref: 'develop' }, state: 'closed', merged_at: '2026-09-10T00:00:00Z', merge_commit_sha: 'abc1234' }] })),
  ]);
  const g = await adaptador();
  const r = await correr(g.cmdHito, ['hito', 'verificar', 'Fase 1 — Fundamentos']);
  assert.match(r.out, /#11/, r.out);
  assert.match(r.out, /#77|PR/i, 'debe citar el PR que la respalda');
  assert.match(r.out, /cerrar-tarea/, 'y ofrecer cerrarla, que es lo que faltaba');
});

test('hito verificar: un hito sin tareas abiertas -> confirma que el cierre fue limpio', async () => {
  apiFalsa([
    R(/^repos\/org\/repo\/milestones\?/, () => ({ status: 200, body: [{ ...HITO_LIMPIO, state: 'closed' }] })),
    R(/^repos\/org\/repo\/issues\?milestone=3/, () => ({ status: 200, body: [] })),
  ]);
  const g = await adaptador();
  const r = await correr(g.cmdHito, ['hito', 'verificar', 'Fase 1 — Fundamentos']);
  assert.match(r.out, /correcto|limpio|sin tareas abiertas/i, r.out);
});

// El caso SIMETRICO: un ISSUE cerrado a mano en la web. ¿Se cerro con un PR detras, o lo cerro
// alguien sin mas? No se impide —cerrarlo puede ser legitimo— pero no puede quedar SIN VERIFICAR.
test('hito verificar: un issue CERRADO sin PR que lo respalde se senala (cerrado a mano, sin evidencia)', async () => {
  apiFalsa([
    R(/^repos\/org\/repo\/milestones\?/, () => ({ status: 200, body: [{ ...HITO_LIMPIO, state: 'closed' }] })),
    R(/^repos\/org\/repo\/issues\?milestone=3/, () => ({ status: 200, body: [
      { number: 20, title: 'Cerrada a mano', state: 'closed', state_reason: 'completed', html_url: 'u' },
    ] })),
    R(/^search\/issues\?q=/, () => ({ status: 200, body: { total_count: 0, items: [] } })),
  ]);
  const g = await adaptador();
  const r = await correr(g.cmdHito, ['hito', 'verificar', 'Fase 1 — Fundamentos']);
  assert.match(r.out, /#20/, r.out);
  assert.match(r.out, /sin evidencia|sin PR|a mano/i, `un cierre sin respaldo debe salir en la verificacion:\n${r.out}`);
});

test('hito verificar: un issue cerrado como DESCARTADO no pide evidencia (no se hizo, y esta dicho)', async () => {
  apiFalsa([
    R(/^repos\/org\/repo\/milestones\?/, () => ({ status: 200, body: [{ ...HITO_LIMPIO, state: 'closed' }] })),
    R(/^repos\/org\/repo\/issues\?milestone=3/, () => ({ status: 200, body: [
      { number: 21, title: 'Descartada', state: 'closed', state_reason: 'not_planned', html_url: 'u' },
    ] })),
    R(/^search\/issues\?q=/, () => ({ status: 200, body: { total_count: 0, items: [] } })),
  ]);
  const g = await adaptador();
  const r = await correr(g.cmdHito, ['hito', 'verificar', 'Fase 1 — Fundamentos']);
  assert.doesNotMatch(r.out, /#21.*sin evidencia/i, 'un descarte es una decision explicita, no un cierre sin respaldo');
});

// PROACTIVO: la verificacion no espera a que alguien la pida. 'hito sync' —que corre en
// /faro:publicar— la dispara y deja el aviso donde se ve.
test('hito sync: avisa PROACTIVAMENTE de un hito cerrado que dejo tareas abiertas dentro', async () => {
  apiFalsa([
    R(/^repos\/org\/repo\/milestones\?state=all/, () => ({ status: 200, body: [{ ...HITO_CON_ABIERTAS, state: 'closed' }] })),
  ]);
  const mod = await import(`file://${path.join(HOOKS, 'lib', 'github-gestion.js').replace(/\\/g, '/')}`);
  const g = mod.default({
    ghApi: async (p, opts) => { const r = await fetch(`https://api.github.com/${p}`, opts || {}); return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) }; },
    ghRepo: () => ({ org: 'org', repo: 'repo' }), sinToken: () => 'SIN_TOKEN', git: () => '',
    fases: () => [{ num: 1, nombre: 'Fundamentos', estado: 'done' }],
    isDone: (e) => e === 'done',
  });
  const out = (await g.syncHitos()).join('\n');
  assert.match(out, /4 tarea\(s\) abierta\(s\)/, `el aviso debe salir solo, sin pedirlo:\n${out}`);
  assert.match(out, /hito verificar|verificar/i, 'y apuntar a como comprobar si el cierre fue correcto');
});

test('hito REABRIR no valida nada: reabrir nunca oculta trabajo (solo cerrar es el gate)', async () => {
  const llamadas = apiFalsa([
    R(/^repos\/org\/repo\/milestones\?/, () => ({ status: 200, body: [{ ...HITO_CON_ABIERTAS, state: 'closed' }] })),
    R(/^repos\/org\/repo\/milestones\/3$/, (_m, b) => ({ status: 200, body: { ...HITO_CON_ABIERTAS, ...b } }), 'PATCH'),
    R(/^repos\/org\/repo\/milestones\/3$/, () => ({ status: 200, body: { ...HITO_CON_ABIERTAS, state: 'open' } })),
  ]);
  const g = await adaptador();
  const r = await correr(g.cmdHito, ['hito', 'reabrir', 'Fase 1 — Fundamentos']);
  assert.match(r.out, /reabierto/, r.out);
  assert.ok(llamadas.some((c) => c.metodo === 'PATCH'));
});
