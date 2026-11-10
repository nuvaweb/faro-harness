// LIGADURA cambio <-> decision (ADR). Dos piezas que ya existian y no se hablaban:
//
//   gestion/cambios/changes/<x>/proposal.md   el QUE            (titulo, fase, tareas, issue)
//           ⇅  sin enlace
//   gestion/decisions/AAAA-MM-DD-<y>.md       el POR QUE tecnico (status, deciders, linaje)
//
// Un cambio que toca src/ con una decision de arquitectura detras no dejaba rastro de CUAL, y un ADR
// aceptado no sabia que cambio lo implemento. El razonamiento tecnico ("por que asi y no de otra
// forma") se perdia entre los dos — y quien retoma el trabajo, persona o agente, lo reinventa.
//
// RIGIDO: si el cambio toca codigo, la decision es OBLIGATORIA. Si es documental/organizativo, no
// aplica — no toda edicion arrastra una decision de arquitectura.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { coherenciaCambioDecision } = require(path.join(HOOKS, 'lib', 'ciclo.js'));

const base = { slug: 'mockup-ui', decision: null, tocaCodigo: true, decisionesExistentes: ['2026-09-19-usar-tanstack.md'] };

// ---------- toca codigo: la decision es OBLIGATORIA ----------

test('un cambio que toca src/ SIN decision citada es un error', () => {
  const r = coherenciaCambioDecision(base);
  assert.ok(r, 'debe exigirla');
  assert.match(r, /decision/i, r);
  assert.match(r, /gestion\/decisions/, 'debe decir donde vive');
});

test('con su decision citada y existente, no protesta', () => {
  assert.strictEqual(
    coherenciaCambioDecision({ ...base, decision: '2026-09-19-usar-tanstack.md' }),
    null,
  );
});

test('cita una decision que NO existe: se senala (enlace roto)', () => {
  const r = coherenciaCambioDecision({ ...base, decision: '2026-01-01-inventada.md' });
  assert.ok(r, 'debe detectar que no esta');
  assert.match(r, /no existe|no encuentro/i, r);
  assert.match(r, /inventada/, 'y nombrar cual');
});

test('acepta la cita sin extension y sin fecha, si resuelve a una sola', () => {
  // Citar 'usar-tanstack' es mas natural que el nombre completo con fecha.
  assert.strictEqual(coherenciaCambioDecision({ ...base, decision: 'usar-tanstack' }), null);
});

// ---------- NO toca codigo: no aplica ----------

test('un cambio documental/organizativo NO necesita decision', () => {
  assert.strictEqual(coherenciaCambioDecision({ ...base, tocaCodigo: false }), null);
});

// ---------- casos limite ----------

test('sin decisiones en el repo todavia, el mensaje dice como crear la primera', () => {
  const r = coherenciaCambioDecision({ ...base, decisionesExistentes: [] });
  assert.ok(r, 'sigue exigiendola');
  assert.match(r, /AAAA-MM-DD/, `debe dar el formato del fichero:\n${r}`);
});

test('una cita ambigua (varias coinciden) se senala en vez de elegir por su cuenta', () => {
  // Mismo slug en dos fechas distintas (se revisito la decision): citarlo sin fecha es ambiguo.
  const r = coherenciaCambioDecision({
    ...base,
    decision: 'usar-tanstack',
    decisionesExistentes: ['2026-09-19-usar-tanstack.md', '2026-09-20-usar-tanstack.md'],
  });
  assert.ok(r, 'no debe adivinar');
  assert.match(r, /coinciden 2|ambigu|varias/i, r);
});
