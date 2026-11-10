// CIERRE DETERMINISTA (#71): una sola regla decide el estado de cada tarea a partir de HECHOS de la
// forja (issue, ramas, PRs, merge) y todos los comandos la usan. Antes habia cinco sitios con su
// propia logica y los issues se quedaban abiertos: 'Closes #N' solo cierra si el PR va a la rama por
// defecto, y 'consolidar' solo cerraba lo que el mismo fusionaba.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { issuesDePr, evaluarTarea, reconciliar, comentarioDeCierre, marcarEnEstado } = require(path.join(HOOKS, 'lib', 'tarea.js'));

const issue = (number, extra = {}) => ({ number, state: 'open', state_reason: null, labels: [], milestone: { title: 'Fase 1 — Base' }, ...extra });
const pr = (number, extra = {}) => ({ number, title: 'algo', body: '', head: { ref: 'feat/x' }, base: { ref: 'develop' }, merged_at: null, merge_commit_sha: null, state: 'open', html_url: `https://x/pull/${number}`, ...extra });
const fusionado = (number, extra = {}) => pr(number, { state: 'closed', merged_at: '2026-09-24T10:00:00Z', merge_commit_sha: 'abc1234def', ...extra });

test('issuesDePr: numero de la rama y palabras de cierre, NO menciones sueltas', () => {
  assert.deepStrictEqual([...issuesDePr(pr(1, { head: { ref: 'fix/12-login' } }))], [12]);
  assert.deepStrictEqual([...issuesDePr(pr(1, { body: 'Closes #7\nfixes #8, resolves #9' }))].sort(), [7, 8, 9]);
  assert.deepStrictEqual([...issuesDePr(pr(1, { body: 'Relacionado con #5 y ver #6' }))], [], 'una mencion no cierra');
});

test('HECHA: PR fusionado en develop que la referencia -> se propone cerrar', () => {
  const e = evaluarTarea(issue(12), [fusionado(40, { head: { ref: 'fix/12-login' } })]);
  assert.strictEqual(e.estado, 'hecha');
  assert.strictEqual(e.accion, 'cerrar');
  assert.strictEqual(e.evidencia.pr, 40);
  assert.strictEqual(e.evidencia.commit, 'abc1234');
});

test('HECHA pero en el BACKLOG: no se cierra desde la sala de espera, se avisa', () => {
  const e = evaluarTarea(issue(12, { milestone: { title: 'Backlog' } }), [fusionado(40, { body: 'Closes #12' })]);
  assert.strictEqual(e.estado, 'hecha');
  assert.strictEqual(e.accion, 'mover-a-fase');
});

test('PR fusionado a una rama que NO es develop/main no cuenta', () => {
  const e = evaluarTarea(issue(12), [fusionado(40, { body: 'Closes #12', base: { ref: 'feat/otra' } })]);
  assert.notStrictEqual(e.estado, 'hecha');
});

test('en revision (PR abierto), en curso (rama), abierta', () => {
  assert.strictEqual(evaluarTarea(issue(3), [pr(9, { body: 'Closes #3' })]).estado, 'en-revision');
  assert.strictEqual(evaluarTarea(issue(3), [], { ramas: ['origin/feat/3-algo'] }).estado, 'en-curso');
  assert.strictEqual(evaluarTarea(issue(3), []).estado, 'abierta');
  assert.strictEqual(evaluarTarea(issue(3), []).accion, null);
});

test('cerradas: descartada (not_planned), cerrada con evidencia, y cerrada SIN evidencia', () => {
  assert.strictEqual(evaluarTarea(issue(4, { state: 'closed', state_reason: 'not_planned' }), []).estado, 'descartada');
  const ok = evaluarTarea(issue(4, { state: 'closed', state_reason: 'completed' }), [fusionado(5, { body: 'Closes #4' })]);
  assert.strictEqual(ok.estado, 'hecha');
  assert.strictEqual(ok.accion, null, 'ya cerrada: nada que hacer');
  const sin = evaluarTarea(issue(4, { state: 'closed', state_reason: 'completed' }), []);
  assert.strictEqual(sin.estado, 'cerrada-sin-evidencia');
});

test('sin issue (no se pudo consultar) -> desconocido, nunca se cierra', () => {
  assert.strictEqual(evaluarTarea(null, []).estado, 'desconocido');
});

test('reconciliar agrupa: por cerrar, hechas en Backlog y cerradas sin evidencia', () => {
  const r = reconciliar({
    issues: [issue(1), issue(2, { milestone: { title: 'Backlog' } }), issue(3, { state: 'closed', state_reason: 'completed' }), issue(4)],
    prs: [fusionado(10, { head: { ref: 'fix/1-a' } }), fusionado(11, { body: 'Closes #2' })],
  });
  assert.deepStrictEqual(r.porCerrar.map((e) => e.numero), [1]);
  assert.deepStrictEqual(r.enBacklog.map((e) => e.numero), [2]);
  assert.deepStrictEqual(r.sinEvidencia.map((e) => e.numero), [3]);
  assert.deepStrictEqual(r.resumen, { hechasSinCerrar: [1, 2], sinEvidencia: [3], mencionadas: [] });
});

test('comentario de cierre: trazabilidad siempre; en un BUG, Causa · Arreglo · Test del PR', () => {
  const e = evaluarTarea(issue(12, { labels: [{ name: 'bug' }] }), [fusionado(40, {
    title: 'fix: login con mayusculas', head: { ref: 'fix/12-login' },
    body: '## Causa\n\nNo se normalizaba el email.\n\n## Arreglo\n\nlowercase antes de comparar.\n\n## Test\n\ntest/login.test.mjs',
  })]);
  const c = comentarioDeCierre(e);
  assert.match(c, /PR #40/);
  assert.match(c, /abc1234/);
  assert.match(c, /develop/);
  assert.match(c, /Causa:.*No se normalizaba el email/);
  assert.match(c, /Arreglo:.*lowercase/);
  assert.match(c, /Test:.*test\/login\.test\.mjs/);
  const t = comentarioDeCierre(evaluarTarea(issue(13), [fusionado(41, { body: 'Closes #13' })]));
  assert.doesNotMatch(t, /Causa/, 'solo los bugs llevan Causa/Arreglo/Test');
});

test('comentario de un bug sin secciones en su PR: lo dice, no se lo inventa', () => {
  const c = comentarioDeCierre(evaluarTarea(issue(12, { labels: [{ name: 'faro:bug' }] }), [fusionado(40, { body: 'Closes #12' })]));
  assert.match(c, /Causa: \(sin describir en el PR #40\)/);
});

test('marcarEnEstado: [x] solo en las lineas #N cerradas; el resto byte a byte', () => {
  const doc = '---\nnombre: x\n---\n### Fase 1 · Base — in_progress\nDesc.\nObjetivo: 2026-10-30\n\n- [ ] #12 · Login — @ana\r\n- [ ] #13 · Otra — @luis\n- [x] #14 · Hecha — @ana\n- [ ] sin numero\n';
  const r = marcarEnEstado(doc, new Set([12, 14, 99]));
  assert.deepStrictEqual(r.marcadas, [12]);
  assert.strictEqual(r.texto, doc.replace('- [ ] #12', '- [x] #12'));
});

test('MENCIONADA: un PR integrado la cita sin palabra de cierre -> se avisa, NO se cierra', () => {
  const e = evaluarTarea(issue(62), [fusionado(63, { head: { ref: 'chore/migrar' }, body: 'Toca #61 y #62 de pasada' })]);
  assert.strictEqual(e.estado, 'mencionada');
  assert.strictEqual(e.accion, null, 'una mencion no demuestra que este resuelta');
  assert.strictEqual(e.evidencia.pr, 63);
  const r = reconciliar({ issues: [issue(62)], prs: [fusionado(63, { body: 'ver #62' })] });
  assert.deepStrictEqual(r.resumen.mencionadas, [62]);
  assert.deepStrictEqual(r.porCerrar, []);
});

test('MENCIONADA: #62 no casa con #621', () => {
  assert.strictEqual(evaluarTarea(issue(62), [fusionado(63, { body: 'ver #621' })]).estado, 'abierta');
});
