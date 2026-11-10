// CIERRE FORZOSO de fase: una fase 'done' NO puede cerrar su hito con tareas abiertas dentro.
//
// Mismo principio que 'validate' ya aplica al ciclo spec<->tasks<->fase: el harness DETECTA y
// CANCELA, nunca mueve trabajo por su cuenta (mover una tarea entre fases es un cambio de alcance,
// una decision de gestion, no algo que el motor deba decidir en silencio). Antes de este cambio,
// syncHitos() cerraba el hito de una fase 'done' sin mirar si le quedaban issues abiertos: el
// contador de open_issues seguia positivo con el hito ya cerrado, y esas tareas se perdian de vista
// -- exactamente el backlog zombi que 'asignar-tarea --fase' (0.31.1) empezo a evitar en la entrada.
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

async function adaptador(fasesList) {
  const mod = await import(`file://${path.join(HOOKS, 'lib', 'github-gestion.js').replace(/\\/g, '/')}`);
  return mod.default({
    ghApi: async (path, opts) => {
      const url = `https://api.github.com/${path}`;
      const r = await fetch(url, opts || {});
      const body = r.ok || r.status < 500 ? await r.json().catch(() => null) : null;
      return { ok: r.ok, status: r.status, body };
    },
    ghRepo: () => ({ org: 'org', repo: 'repo' }),
    sinToken: () => 'SIN_TOKEN',
    git: () => '',
    fases: () => fasesList,
    isDone: (e) => e === 'done',
  });
}

// El BACKLOG es la sala de espera del trabajo aceptado sin fecha. Si solo naciera cuando alguien usa
// '--fase backlog', no estaria disponible cuando hace falta ofrecerlo. Es el UNICO hito que no
// caduca —por eso no lleva fecha ni se cierra nunca—; todos los demas son fases.
test('syncHitos: crea el hito Backlog si no existe (siempre disponible, no solo bajo demanda)', async () => {
  const llamadas = apiFalsa([
    R(/^repos\/org\/repo\/milestones\?state=all/, () => ({ status: 200, body: [] })),
    R(/^repos\/org\/repo\/milestones$/, (_m, b) => ({ status: 201, body: { number: 1, open_issues: 0, ...b } }), 'POST'),
  ]);
  const g = await adaptador([{ num: 1, nombre: 'Fundamentos', estado: 'in_progress' }]);
  const out = (await g.syncHitos()).join('\n');
  assert.match(out, /Backlog/, out);
  const creaBacklog = llamadas.find((c) => c.metodo === 'POST' && c.body && c.body.title === 'Backlog');
  assert.ok(creaBacklog, 'debe crearse el Backlog');
  assert.strictEqual(creaBacklog.body.due_on, undefined, 'el Backlog NO caduca: nunca lleva fecha');
});

test('syncHitos: si el Backlog YA existe no se duplica', async () => {
  const llamadas = apiFalsa([
    R(/^repos\/org\/repo\/milestones\?state=all/, () => ({ status: 200, body: [{ number: 9, title: 'Backlog', state: 'open', open_issues: 3 }] })),
    R(/^repos\/org\/repo\/milestones$/, (_m, b) => ({ status: 201, body: { number: 99, ...b } }), 'POST'),
  ]);
  const g = await adaptador([{ num: 1, nombre: 'Fundamentos', estado: 'in_progress' }]);
  await g.syncHitos();
  const creaBacklog = llamadas.filter((c) => c.metodo === 'POST' && c.body && c.body.title === 'Backlog');
  assert.deepStrictEqual(creaBacklog, [], 'ya estaba: no se crea otro');
});

test('syncHitos: el Backlog NO se cierra aunque tenga tareas dentro (no es una fase, no caduca)', async () => {
  const llamadas = apiFalsa([
    R(/^repos\/org\/repo\/milestones\?state=all/, () => ({ status: 200, body: [{ number: 9, title: 'Backlog', state: 'open', open_issues: 5 }] })),
    R(/^repos\/org\/repo\/milestones\/9$/, (_m, b) => ({ status: 200, body: { number: 9, ...b } }), 'PATCH'),
  ]);
  const g = await adaptador([{ num: 1, nombre: 'Fundamentos', estado: 'done' }]);
  await g.syncHitos();
  const tocaBacklog = llamadas.filter((c) => c.metodo === 'PATCH' && c.ruta === 'repos/org/repo/milestones/9');
  assert.deepStrictEqual(tocaBacklog, [], 'el Backlog no se cierra ni se toca al cerrar fases');
});

test('syncHitos: fase done con issues abiertos en su hito -> NO cierra el hito, avisa cuantas quedan', async () => {
  apiFalsa([
    R(/^repos\/org\/repo\/milestones\?state=all/, () => ({ status: 200, body: [{ number: 3, title: 'Fase 1 — Fundamentos', state: 'open', open_issues: 2, closed_issues: 5 }] })),
  ]);
  const g = await adaptador([{ num: 1, nombre: 'Fundamentos', estado: 'done' }]);
  const out = await g.syncHitos();
  assert.match(out.join('\n'), /Fase 1 — Fundamentos/, out.join('\n'));
  assert.match(out.join('\n'), /2 tarea\(s\) abierta\(s\)/, 'debe decir cuantas quedan abiertas');
  assert.doesNotMatch(out.join('\n'), /cerrado \(fase terminada\)/, 'NO debe reportar como cerrado');
});

test('syncHitos: fase done SIN issues abiertos en su hito -> cierra normalmente (comportamiento previo intacto)', async () => {
  const llamadas = apiFalsa([
    R(/^repos\/org\/repo\/milestones\?state=all/, () => ({ status: 200, body: [{ number: 3, title: 'Fase 1 — Fundamentos', state: 'open', open_issues: 0, closed_issues: 7 }] })),
    R(/^repos\/org\/repo\/milestones\/3$/, () => ({ status: 200, body: { number: 3, state: 'closed' } }), 'PATCH'),
    R(/^repos\/org\/repo\/milestones\/3$/, () => ({ status: 200, body: { number: 3, state: 'closed' } })),
  ]);
  const g = await adaptador([{ num: 1, nombre: 'Fundamentos', estado: 'done' }]);
  const out = await g.syncHitos();
  assert.match(out.join('\n'), /cerrado \(fase terminada\)/, out.join('\n'));
  assert.ok(llamadas.some((c) => c.metodo === 'PATCH' && c.ruta === 'repos/org/repo/milestones/3'), 'debe intentar cerrar el hito');
});

test('syncHitos: fase NO terminada con hito abierto -> sigue sin tocar (no aplica el bloqueo a lo que no se cierra)', async () => {
  const llamadas = apiFalsa([
    R(/^repos\/org\/repo\/milestones\?state=all/, () => ({ status: 200, body: [{ number: 3, title: 'Fase 1 — Fundamentos', state: 'open', open_issues: 4, closed_issues: 1 }] })),
  ]);
  const g = await adaptador([{ num: 1, nombre: 'Fundamentos', estado: 'in_progress' }]);
  const out = await g.syncHitos();
  assert.match(out.join('\n'), /ya coherente/, out.join('\n'));
  assert.ok(!llamadas.some((c) => c.metodo === 'PATCH'), 'no debe intentar ningun cambio de estado');
});

test('syncHitos: fase done que ya tenia el hito CERRADO pero le añadieron issues abiertos despues -> avisa (no lo ignora por ya estar closed)', async () => {
  apiFalsa([
    R(/^repos\/org\/repo\/milestones\?state=all/, () => ({ status: 200, body: [{ number: 3, title: 'Fase 1 — Fundamentos', state: 'closed', open_issues: 1, closed_issues: 5 }] })),
  ]);
  const g = await adaptador([{ num: 1, nombre: 'Fundamentos', estado: 'done' }]);
  const out = await g.syncHitos();
  assert.match(out.join('\n'), /1 tarea\(s\) abierta\(s\)/, out.join('\n'));
});
