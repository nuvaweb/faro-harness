// La fecha OBJETIVO de una fase viaja al hito (due_on).
//
// ESTADO.md ya permite una linea 'Objetivo: AAAA-MM-DD' por fase, y el harness ya la parsea
// (lib/estado.js -> f.objetivo). 'hito crear --vence' ya sabia poner due_on. Lo que faltaba era
// unir las dos mitades: 'hito sync' creaba los hitos SIN fecha, tirando un dato que ya estaba
// escrito. Con due_on, la forja muestra el vencimiento y avisa de hitos pasados de fecha — sin que
// nadie tenga que mantener la fecha en dos sitios.
//
// Regla: ESTADO.md MANDA. Si la fecha del fichero cambia, el hito se actualiza; si la fase no tiene
// objetivo, el hito se queda sin fecha (no se inventa ninguna).
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
    ghApi: async (p, opts) => {
      const r = await fetch(`https://api.github.com/${p}`, opts || {});
      const body = r.status < 500 ? await r.json().catch(() => null) : null;
      return { ok: r.ok, status: r.status, body };
    },
    ghRepo: () => ({ org: 'org', repo: 'repo' }),
    sinToken: () => 'SIN_TOKEN',
    git: () => '',
    fases: () => fasesList,
    isDone: (e) => e === 'done',
  });
}

test('hito sync: una fase CON objetivo crea su hito con due_on en esa fecha', async () => {
  const llamadas = apiFalsa([
    R(/^repos\/org\/repo\/milestones\?state=all/, () => ({ status: 200, body: [] })),
    R(/^repos\/org\/repo\/milestones$/, (_m, b) => ({ status: 201, body: { number: 1, open_issues: 0, ...b } }), 'POST'),
  ]);
  const g = await adaptador([{ num: 1, nombre: 'Fundamentos', estado: 'in_progress', objetivo: '2026-11-30' }]);
  await g.syncHitos();
  // Se busca el hito DE LA FASE por su titulo: syncHitos crea tambien el 'Backlog' (0.35.0), y ese
  // no lleva fecha nunca — coger la primera creacion a secas miraria el Backlog, no la fase.
  const crea = llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/milestones' && /^Fase 1/.test(c.body.title));
  assert.ok(crea, 'debe crear el hito de la fase');
  assert.match(String(crea.body.due_on), /^2026-11-30/, `due_on deberia venir de la fase: ${JSON.stringify(crea.body)}`);
});

test('hito sync: una fase SIN objetivo crea su hito sin fecha (no se inventa ninguna)', async () => {
  const llamadas = apiFalsa([
    R(/^repos\/org\/repo\/milestones\?state=all/, () => ({ status: 200, body: [] })),
    R(/^repos\/org\/repo\/milestones$/, (_m, b) => ({ status: 201, body: { number: 1, open_issues: 0, ...b } }), 'POST'),
  ]);
  const g = await adaptador([{ num: 1, nombre: 'Fundamentos', estado: 'in_progress', objetivo: null }]);
  await g.syncHitos();
  // Igual que arriba: por titulo, para medir el hito de la FASE y no el Backlog (que nunca lleva fecha
  // y haria pasar el test por casualidad, sin comprobar lo que dice comprobar).
  const crea = llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/milestones' && /^Fase 1/.test(c.body.title));
  assert.ok(crea, 'debe crear el hito de la fase');
  assert.strictEqual(crea.body.due_on, undefined, 'sin objetivo no se pone fecha');
});

test('hito sync: si la fecha de ESTADO.md CAMBIA, el hito existente se actualiza (ESTADO.md manda)', async () => {
  const llamadas = apiFalsa([
    R(/^repos\/org\/repo\/milestones\?state=all/, () => ({ status: 200, body: [{ number: 5, title: 'Fase 1 — Fundamentos', state: 'open', open_issues: 0, due_on: '2026-10-01T00:00:00Z' }] })),
    R(/^repos\/org\/repo\/milestones\/5$/, (_m, b) => ({ status: 200, body: { number: 5, state: 'open', ...b } }), 'PATCH'),
    R(/^repos\/org\/repo\/milestones\/5$/, () => ({ status: 200, body: { number: 5, state: 'open' } })),
  ]);
  const g = await adaptador([{ num: 1, nombre: 'Fundamentos', estado: 'in_progress', objetivo: '2026-12-15' }]);
  const out = await g.syncHitos();
  const patch = llamadas.find((c) => c.metodo === 'PATCH' && c.ruta === 'repos/org/repo/milestones/5');
  assert.ok(patch, `debe actualizar la fecha del hito:\n${out.join('\n')}`);
  assert.match(String(patch.body.due_on), /^2026-12-15/);
});

test('hito sync: si la fecha ya COINCIDE, no se toca el hito (idempotente, sin llamadas de mas)', async () => {
  const llamadas = apiFalsa([
    R(/^repos\/org\/repo\/milestones\?state=all/, () => ({ status: 200, body: [{ number: 5, title: 'Fase 1 — Fundamentos', state: 'open', open_issues: 0, due_on: '2026-12-15T00:00:00Z' }] })),
    R(/^repos\/org\/repo\/milestones\/5$/, (_m, b) => ({ status: 200, body: { number: 5, ...b } }), 'PATCH'),
  ]);
  const g = await adaptador([{ num: 1, nombre: 'Fundamentos', estado: 'in_progress', objetivo: '2026-12-15' }]);
  await g.syncHitos();
  assert.ok(!llamadas.some((c) => c.metodo === 'PATCH'), 'no debe hacer PATCH si la fecha ya es la correcta');
});

test('hito sync: quitar el objetivo de ESTADO.md NO borra la fecha del hito (no se destruye dato por omision)', async () => {
  const llamadas = apiFalsa([
    R(/^repos\/org\/repo\/milestones\?state=all/, () => ({ status: 200, body: [{ number: 5, title: 'Fase 1 — Fundamentos', state: 'open', open_issues: 0, due_on: '2026-12-15T00:00:00Z' }] })),
    R(/^repos\/org\/repo\/milestones\/5$/, (_m, b) => ({ status: 200, body: { number: 5, ...b } }), 'PATCH'),
  ]);
  const g = await adaptador([{ num: 1, nombre: 'Fundamentos', estado: 'in_progress', objetivo: null }]);
  await g.syncHitos();
  assert.ok(!llamadas.some((c) => c.metodo === 'PATCH'), 'sin objetivo en el fichero, la fecha del hito se deja como esta');
});
