// 'Refs #N' en el PR manda sobre el numero de la rama (#91).
//
// Caso real que lo motiva: en un repo de trabajo habia que meter dos lineas en ESTADO.md que
// AVANZABAN las tareas #96 y #97 sin terminarlas. Una rama 'docs/96-...' las habria cerrado al
// integrarse aunque el PR dijera 'Refs #96': tres caminos (pr crear, reconciliar y el cierre activo
// de consolidar) leian el numero de la rama como "resuelve" sin mirar el PR. La salida fue anclar la
// rama a una tarea ya cerrada (#79), y la trazabilidad quedo apuntando a la tarea equivocada.
//
// Regla: si el PR cita SU numero sin palabra de cierre ('Refs', 'Ref', 'Parte de', 'Part of',
// 'Relates to'), el numero de la rama NO cierra. Una palabra de cierre explicita gana siempre.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { issuesDePr, evaluarTarea, soloReferencia } = require(path.join(HOOKS, 'lib', 'tarea.js'));
const { conCierreDeIssue } = require(path.join(HOOKS, 'lib', 'git.js'));
const { planCierreDeTarea } = require(path.join(HOOKS, 'lib', 'ciclo.js'));

const pr = (extra = {}) => ({ number: 99, title: 'docs: anotar #96 en el faseo', body: '', head: { ref: 'docs/96-faseo' }, base: { ref: 'develop' }, state: 'closed', merged_at: '2026-10-01T10:00:00Z', merge_commit_sha: 'abc1234def', ...extra });

test('soloReferencia: Refs/Ref/Parte de/Part of/Relates to sobre SU numero', () => {
  for (const body of ['Refs #96', 'Ref: #96', 'Parte de #96', 'Part of #96', 'Relates to #96', 'refs #96, #97']) {
    assert.strictEqual(soloReferencia(pr({ body }), 96), true, body);
  }
});

test('soloReferencia: una palabra de cierre explicita gana', () => {
  assert.strictEqual(soloReferencia(pr({ body: 'Refs #96\n\nCloses #96' }), 96), false);
});

test('soloReferencia: citar OTRO numero no cambia nada', () => {
  assert.strictEqual(soloReferencia(pr({ body: 'Refs #7' }), 96), false);
  assert.strictEqual(soloReferencia(pr({ body: 'Refs #960' }), 96), false, '#960 no es #96');
  assert.strictEqual(soloReferencia(pr({ body: '' }), 96), false);
});

test('issuesDePr: con Refs #N el numero de la rama NO cuenta como resuelto', () => {
  assert.deepStrictEqual([...issuesDePr(pr({ body: 'Refs #96' }))], []);
  assert.deepStrictEqual([...issuesDePr(pr({ body: 'Refs #96\nCloses #12' }))], [12], 'el cierre explicito de otra sigue contando');
});

test('issuesDePr: sin Refs, el numero de la rama sigue cerrando (sin regresion)', () => {
  assert.deepStrictEqual([...issuesDePr(pr({ body: 'Resumen.' }))], [96]);
  assert.deepStrictEqual([...issuesDePr(pr({ body: 'Refs #7' }))], [96]);
});

test('evaluarTarea: PR integrado de docs/96-x con Refs #96 deja la #96 abierta', () => {
  const e = evaluarTarea({ number: 96, state: 'open', labels: [], milestone: { title: 'Fase 2' } }, [pr({ body: 'Refs #96' })]);
  assert.strictEqual(e.accion, null, 'no se propone cerrar');
  assert.notStrictEqual(e.estado, 'hecha');
});

test('conCierreDeIssue: no anade Closes #N si el cuerpo dice Refs #N', () => {
  assert.strictEqual(conCierreDeIssue('Refs #96', 'docs/96-faseo'), 'Refs #96');
  assert.match(conCierreDeIssue('Refs #7', 'docs/96-faseo'), /Closes #96/, 'Refs de otra no cuenta');
});

test('planCierreDeTarea: si su PR solo la referencia, consolidar no la cierra', () => {
  const p = planCierreDeTarea({ issue: '96', estado: 'open', rama: 'docs/96-faseo', soloReferencia: true });
  assert.strictEqual(p.accion, 'nada');
  assert.match(p.nota, /Refs #96/);
  assert.strictEqual(planCierreDeTarea({ issue: '96', estado: 'open', rama: 'docs/96-faseo' }).accion, 'cerrar', 'sin Refs, igual que antes');
});

test('consolidar consulta los PRs de la rama antes del cierre activo, y pr crear acepta Refs como ancla', () => {
  const src = fs.readFileSync(path.join(HOOKS, 'harness.js'), 'utf8');
  const ini = src.indexOf('async function cmdConsolidar');
  const consolidar = src.slice(ini, src.indexOf('\nasync function ', ini + 1)); // la función entera, no una ventana fija que se queda corta al crecer
  assert.match(consolidar, /prsDeRama/);
  assert.match(consolidar, /soloReferencia/);
  const prCrear = src.slice(src.indexOf('async function cmdPrCrear'), src.indexOf('async function cmdTerminar'));
  assert.match(prCrear, /soloReferencia/);
  const gh = fs.readFileSync(path.join(HOOKS, 'lib', 'github.js'), 'utf8');
  assert.match(gh, /async function prsDeRama/);
});
