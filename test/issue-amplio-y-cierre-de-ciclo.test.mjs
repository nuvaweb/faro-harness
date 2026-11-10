// Dos piezas del mismo problema: el trabajo es AGENTICO (un agente se come un bloque grande de una
// sentada), asi que la unidad natural es el issue AMPLIO con sus subtareas dentro — y cuando ese
// bloque termina, el ciclo tiene que cerrarse sin depender de que alguien encadene cuatro comandos
// de memoria.
//
// Caso real: la Fase 1 de un repo quedo con sus 11 tareas en [x], pero la rama nunca salio. El issue
// siguio abierto, la fase sin cerrar y el hito sin reflejar nada. El harness MARCABA pero no LIMPIABA:
// su ultimo mensaje tras aprobar era "revisa ESTADO.md y cierra la fase" — pidiendoselo al humano.
//
//   1. subtareasEnCuerpo: el issue nace con sus subtareas como checkboxes (estructura dentro).
//   2. ampliarCuerpo: cuando salen cosas nuevas (siempre salen), se AMPLIA el issue existente.
//   3. cicloPendiente: detecta trabajo terminado que no ha salido de su rama.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { subtareasEnCuerpo, ampliarCuerpo, cicloPendiente } = require(path.join(HOOKS, 'lib', 'ciclo.js'));

// ---------- 1. el issue nace AMPLIO, con su estructura dentro ----------

test('subtareasEnCuerpo: las subtareas van como checkboxes bajo un encabezado', () => {
  const r = subtareasEnCuerpo('Maquetar el informe.', ['Pantalla Planta', 'Pantalla Servicios']);
  assert.match(r, /^Maquetar el informe\./, 'conserva el cuerpo');
  assert.match(r, /- \[ \] Pantalla Planta/, r);
  assert.match(r, /- \[ \] Pantalla Servicios/, r);
});

test('subtareasEnCuerpo: sin subtareas deja el cuerpo tal cual', () => {
  assert.strictEqual(subtareasEnCuerpo('Solo esto.', []), 'Solo esto.');
  assert.strictEqual(subtareasEnCuerpo('Solo esto.', null), 'Solo esto.');
});

test('subtareasEnCuerpo: un issue AMPLIO admite muchas subtareas sin trocearse', () => {
  // El punto de todo esto: 11 subtareas son UN issue, no 11 issues.
  const muchas = Array.from({ length: 11 }, (_, i) => `Subtarea ${i + 1}`);
  const r = subtareasEnCuerpo('Mockup UI completo.', muchas);
  assert.strictEqual((r.match(/- \[ \]/g) || []).length, 11, r);
});

// ---------- 2. AMPLIAR el issue existente en vez de crear otro ----------

test('ampliarCuerpo: anade las subtareas nuevas al bloque que ya existe', () => {
  const previo = subtareasEnCuerpo('Maquetar.', ['Pantalla Planta']);
  const r = ampliarCuerpo(previo, ['Pantalla Evolucion']);
  assert.match(r, /- \[ \] Pantalla Planta/, 'no pierde las que habia');
  assert.match(r, /- \[ \] Pantalla Evolucion/, 'anade la nueva');
  assert.strictEqual((r.match(/## Subtareas/g) || []).length, 1, 'un solo bloque, no dos');
});

test('ampliarCuerpo: NO duplica una subtarea que ya estaba (aunque cambie la caja)', () => {
  const previo = subtareasEnCuerpo('Maquetar.', ['Pantalla Planta']).replace('- [ ] Pantalla Planta', '- [x] Pantalla Planta');
  const r = ampliarCuerpo(previo, ['Pantalla Planta']);
  assert.strictEqual((r.match(/Pantalla Planta/g) || []).length, 1, `no debe duplicarla:\n${r}`);
  assert.match(r, /- \[x\] Pantalla Planta/, 'y respeta que ya estaba hecha');
});

test('ampliarCuerpo: un cuerpo SIN bloque de subtareas lo estrena', () => {
  const r = ampliarCuerpo('Solo texto.', ['Algo nuevo']);
  assert.match(r, /## Subtareas/, r);
  assert.match(r, /- \[ \] Algo nuevo/, r);
  assert.match(r, /^Solo texto\./, 'conserva lo que habia');
});

// ---------- 3. trabajo terminado que no ha salido de su rama ----------

test('cicloPendiente: fase al 100% en rama de trabajo sin integrar = hay que cerrar el ciclo', () => {
  const r = cicloPendiente({ rama: 'feat/4-mockup', fase: { num: 1, done: 11, open: 0 }, integrada: false });
  assert.ok(r, 'debe detectar que falta cerrar');
  assert.match(r, /#4/, 'nombra la tarea de la rama');
  assert.match(r, /terminar/i, `debe decir como cerrarlo:\n${r}`);
});

test('cicloPendiente: con tareas ABIERTAS todavia no hay nada que cerrar', () => {
  assert.strictEqual(cicloPendiente({ rama: 'feat/4-mockup', fase: { num: 1, done: 5, open: 6 }, integrada: false }), null);
});

test('cicloPendiente: si la rama YA esta integrada, no insiste', () => {
  assert.strictEqual(cicloPendiente({ rama: 'feat/4-mockup', fase: { num: 1, done: 11, open: 0 }, integrada: true }), null);
});

test('cicloPendiente: en una rama protegida no aplica (no hay ciclo que cerrar)', () => {
  assert.strictEqual(cicloPendiente({ rama: 'develop', fase: { num: 1, done: 11, open: 0 }, integrada: false }), null);
});

test('cicloPendiente: sin fase no inventa nada', () => {
  assert.strictEqual(cicloPendiente({ rama: 'feat/4-mockup', fase: null, integrada: false }), null);
});
