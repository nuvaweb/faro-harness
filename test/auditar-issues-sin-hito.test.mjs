// AUDITORIA: recorrer TODOS los issues del repo y decir cuales no tienen hito.
//
// Distinto de lo que ya existia: la vigilancia (plan_sin_hito) solo da un NUMERO barato
// (total_count), y 'hito verificar' mira UN hito concreto. Nada listaba de golpe TODOS los issues
// sin hito, sea cual sea su tipo o su antiguedad — critico para el pasado: issues creados antes de
// que el anclaje existiera (0.35.0), o creados desde la web sin pasar por el harness.
//
// Regla: los de tipo CIERRE (duplicado/descartado) no cuentan como huerfanos aunque no tengan hito
// — cerrar no es planificar. Todo lo demas, abierto y sin hito, es una alerta CRITICA.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');

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
    ghRepo: () => ({ org: 'org', repo: 'repo' }), sinToken: () => 'SIN_TOKEN', git: () => '',
    fases: () => [], isDone: (e) => e === 'done',
  });
}
async function correr(fn, argv) {
  const out = []; const log = console.log; const exit = process.exit; let codigo = null;
  console.log = (...a) => out.push(a.join(' '));
  process.exit = (c) => { codigo = c; throw new Error('__exit__'); };
  process.argv = ['node', 'harness.js', ...argv];
  try { await fn(); } catch (e) { if (e.message !== '__exit__') throw e; } finally { console.log = log; process.exit = exit; }
  return { out: out.join('\n'), codigo };
}

// updated_at reciente por defecto: el caso base es "tocado hoy", ni huerfano por antiguo ni
// olvidado. Los tests que necesitan un issue viejo (estancado) lo pasan explicito.
const issue = (n, labels, milestone, state = 'open', state_reason = null) => ({
  number: n, title: `Tarea ${n}`, state, state_reason, milestone,
  labels: labels.map((l) => ({ name: l })), html_url: 'u', updated_at: new Date().toISOString(),
});

test('hito auditar: recorre TODOS los issues abiertos y lista los que no tienen hito', async () => {
  apiFalsa([
    R(/^repos\/org\/repo\/issues\?state=open&per_page=100&page=1$/, () => ({ status: 200, body: [
      issue(1, ['faro:bug'], null),
      issue(2, ['faro:requerimiento'], { number: 3, title: 'Fase 1 — X' }),
      issue(3, ['faro:tarea'], null),
    ] })),
    R(/^repos\/org\/repo\/issues\?state=open&per_page=100&page=2$/, () => ({ status: 200, body: [] })),
  ]);
  const g = await adaptador();
  const r = await correr(g.cmdHito, ['hito', 'auditar']);
  assert.match(r.out, /#1\b/, r.out);
  assert.match(r.out, /#3\b/, r.out);
  assert.doesNotMatch(r.out, /#2\b.*sin hito/i, 'el #2 tiene hito, no debe listarse como huerfano');
  assert.match(r.out, /2\b.*sin hito|sin hito.*2\b/i, `debe contar 2 huerfanos:\n${r.out}`);
});

test('hito auditar: un issue de tipo CIERRE (duplicado/descartado) sin hito NO cuenta como huerfano', async () => {
  apiFalsa([
    R(/^repos\/org\/repo\/issues\?state=open&per_page=100&page=1$/, () => ({ status: 200, body: [
      issue(5, ['faro:tarea'], null),
    ] })),
    R(/^repos\/org\/repo\/issues\?state=all&per_page=100&page=1$/, () => ({ status: 200, body: [
      issue(6, ['duplicate'], null, 'closed', 'not_planned'),
    ] })),
    R(/^repos\/org\/repo\/issues\?state=open&per_page=100&page=2$/, () => ({ status: 200, body: [] })),
    R(/^repos\/org\/repo\/issues\?state=all&per_page=100&page=2$/, () => ({ status: 200, body: [] })),
  ]);
  const g = await adaptador();
  const r = await correr(g.cmdHito, ['hito', 'auditar']);
  assert.match(r.out, /#5\b/, r.out);
  assert.doesNotMatch(r.out, /#6\b/, 'un duplicado/descartado no es un huerfano: cerrar no es planificar');
});

test('hito auditar: pagina hasta agotar los issues (repos con mas de 100)', async () => {
  const pagina1 = Array.from({ length: 100 }, (_, i) => issue(i + 1, ['faro:tarea'], null));
  const llamadas = apiFalsa([
    R(/^repos\/org\/repo\/issues\?state=open&per_page=100&page=1$/, () => ({ status: 200, body: pagina1 })),
    R(/^repos\/org\/repo\/issues\?state=open&per_page=100&page=2$/, () => ({ status: 200, body: [issue(101, ['faro:tarea'], null)] })),
    R(/^repos\/org\/repo\/issues\?state=open&per_page=100&page=3$/, () => ({ status: 200, body: [] })),
  ]);
  const g = await adaptador();
  const r = await correr(g.cmdHito, ['hito', 'auditar']);
  assert.match(r.out, /#101\b/, `debe llegar a la pagina 2:\n${r.out.slice(0, 200)}...`);
  const paginas = llamadas.filter((c) => /issues\?state=open/.test(c.ruta));
  // 100 en pagina 1 (llena, sigue) + 1 en pagina 2 (menos de 100, para AHI): 2 llamadas, no 3 — no
  // hace falta pedir una tercera pagina vacia para saber que ya no hay mas.
  assert.strictEqual(paginas.length, 2, `debe parar en cuanto una pagina viene incompleta:\n${paginas.map((p) => p.ruta).join('\n')}`);
});

test('hito auditar: sin huerfanos, lo dice claro (todo esta bien)', async () => {
  apiFalsa([
    R(/^repos\/org\/repo\/issues\?state=open&per_page=100&page=1$/, () => ({ status: 200, body: [
      issue(1, ['faro:tarea'], { number: 3, title: 'Fase 1 — X' }),
    ] })),
    R(/^repos\/org\/repo\/issues\?state=open&per_page=100&page=2$/, () => ({ status: 200, body: [] })),
  ]);
  const g = await adaptador();
  const r = await correr(g.cmdHito, ['hito', 'auditar']);
  assert.match(r.out, /0 issue\(s\) sin hito/i, r.out);
});

test('hito auditar: la lista sale ORDENADA de menor a mayor numero (para tratarlos en orden)', async () => {
  apiFalsa([
    R(/^repos\/org\/repo\/issues\?state=open&per_page=100&page=1$/, () => ({ status: 200, body: [
      issue(50, ['faro:tarea'], null),
      issue(3, ['faro:bug'], null),
      issue(21, ['faro:requerimiento'], null),
    ] })),
    R(/^repos\/org\/repo\/issues\?state=open&per_page=100&page=2$/, () => ({ status: 200, body: [] })),
  ]);
  const g = await adaptador();
  const r = await correr(g.cmdHito, ['hito', 'auditar']);
  const pos3 = r.out.indexOf('#3');
  const pos21 = r.out.indexOf('#21');
  const pos50 = r.out.indexOf('#50');
  assert.ok(pos3 >= 0 && pos21 >= 0 && pos50 >= 0, r.out);
  assert.ok(pos3 < pos21 && pos21 < pos50, `deberia salir 3, 21, 50 en ese orden:\n${r.out}`);
});

// SEGUNDA MITAD de la auditoria: un issue CON hito puede seguir olvidado — nadie lo cierra aunque
// este bien anclado. Reforzar "un issue se debe CERRAR, no olvidarse" exige detectar tambien esto,
// no solo los huerfanos sin hito.
test('hito auditar: un issue CON hito pero ESTANCADO (>30d sin tocar) se lista aparte como olvidado', async () => {
  const vieja = new Date(Date.now() - 45 * 86400000).toISOString();
  apiFalsa([
    R(/^repos\/org\/repo\/issues\?state=open&per_page=100&page=1$/, () => ({ status: 200, body: [
      { ...issue(9, ['faro:tarea'], { number: 2, title: 'Fase 1 — X' }), updated_at: vieja },
    ] })),
    R(/^repos\/org\/repo\/issues\?state=open&per_page=100&page=2$/, () => ({ status: 200, body: [] })),
  ]);
  const g = await adaptador();
  const r = await correr(g.cmdHito, ['hito', 'auditar']);
  assert.match(r.out, /olvidad|estancad/i, `debe haber una seccion de olvidados:\n${r.out}`);
  assert.match(r.out, /#9\b/, r.out);
  assert.match(r.out, /45d|45 d/i, 'debe decir cuanto lleva sin tocarse');
});

test('hito auditar: un issue CON hito y ACTIVO (tocado hace poco) no aparece como olvidado', async () => {
  apiFalsa([
    R(/^repos\/org\/repo\/issues\?state=open&per_page=100&page=1$/, () => ({ status: 200, body: [
      issue(10, ['faro:tarea'], { number: 2, title: 'Fase 1 — X' }),
    ] })),
    R(/^repos\/org\/repo\/issues\?state=open&per_page=100&page=2$/, () => ({ status: 200, body: [] })),
  ]);
  const g = await adaptador();
  const r = await correr(g.cmdHito, ['hito', 'auditar']);
  assert.doesNotMatch(r.out, /#10\b/, `no debe aparecer, se toco hoy:\n${r.out}`);
});

test('hito auditar: da el comando exacto para resolver cada huerfano', async () => {
  apiFalsa([
    R(/^repos\/org\/repo\/issues\?state=open&per_page=100&page=1$/, () => ({ status: 200, body: [issue(7, ['faro:bug'], null)] })),
    R(/^repos\/org\/repo\/issues\?state=open&per_page=100&page=2$/, () => ({ status: 200, body: [] })),
  ]);
  const g = await adaptador();
  const r = await correr(g.cmdHito, ['hito', 'auditar']);
  assert.match(r.out, /mover-tarea 7/, `debe decir como resolverlo:\n${r.out}`);
});
