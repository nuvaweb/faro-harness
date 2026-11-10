// CERRAR UNA FASE es una ceremonia, y hasta ahora eran cuatro pasos manuales que nadie ataba:
// marcar los checkbox, escribir el informe, editar ESTADO.md (estado done + avanzar fase_actual) y
// tagear. Todo el resto del ciclo esta cableado punta a punta (rama -> terminar -> consolidar ->
// publicar); esto era el unico hueco, y 'publicar' terminaba literalmente pidiendo al humano que lo
// hiciera a mano.
//
// 'planCerrarFase' decide SI se puede cerrar y QUE falta. Es pura —el estado se inyecta, no se lee
// del disco ni de la red— para poder fijar el criterio con tests deterministas.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { planCerrarFase } = require(path.join(HOOKS, 'lib', 'ciclo.js'));

const fase = (extra = {}) => ({
  num: 1, nombre: 'Mockup UI', estado: 'in_progress',
  descripcion: 'Las tres pantallas.', objetivo: '2026-12-01',
  tareas: [{ text: '#4 · Pantallas — @fer', done: true }],
  done: 1, open: 0,
  ...extra,
});
const ok = { informe: true, desajustes: [], siguiente: 2 };

// ---------- cuando SI se puede ----------

test('fase completa con informe: se puede cerrar', () => {
  const p = planCerrarFase({ fase: fase(), ...ok });
  assert.strictEqual(p.ok, true, JSON.stringify(p));
  assert.deepStrictEqual(p.faltan, []);
});

test('al cerrar, dice a que fase pasa fase_actual', () => {
  const p = planCerrarFase({ fase: fase(), ...ok });
  assert.strictEqual(p.faseActual, 2, 'avanza a la siguiente fase abierta');
});

test('si era la ULTIMA fase, fase_actual no avanza a ninguna parte', () => {
  const p = planCerrarFase({ fase: fase(), ...ok, siguiente: null });
  assert.strictEqual(p.ok, true, 'cerrar la ultima fase es legitimo');
  assert.strictEqual(p.faseActual, null);
});

// ---------- cuando NO, y por que ----------

test('con tareas abiertas NO se cierra, y dice cuantas', () => {
  const p = planCerrarFase({ fase: fase({ open: 2, done: 1 }), ...ok });
  assert.strictEqual(p.ok, false);
  assert.ok(p.faltan.some((f) => /2 tarea/.test(f)), JSON.stringify(p.faltan));
});

test('sin informe NO se cierra, y dice el nombre de fichero que espera', () => {
  const p = planCerrarFase({ fase: fase(), ...ok, informe: false });
  assert.strictEqual(p.ok, false);
  const msg = p.faltan.join(' ');
  assert.match(msg, /informe/i, msg);
  assert.match(msg, /fase-1-informe\.md/, `debe decir COMO se llama: ${msg}`);
});

// El checkbox marcado no es evidencia de que el trabajo saliera: la forja manda.
test('si la forja dice que una tarea sigue abierta, NO se cierra aunque el checkbox este marcado', () => {
  const p = planCerrarFase({
    fase: fase(),
    informe: true,
    desajustes: ["Fase 1: #4 'Pantallas' esta marcada [x] pero su tarea sigue ABIERTA en la forja."],
    siguiente: 2,
  });
  assert.strictEqual(p.ok, false);
  assert.ok(p.faltan.some((f) => /#4/.test(f)), JSON.stringify(p.faltan));
});

test('acumula TODO lo que falta, no solo lo primero', () => {
  const p = planCerrarFase({ fase: fase({ open: 3 }), informe: false, desajustes: [], siguiente: 2 });
  assert.strictEqual(p.ok, false);
  assert.ok(p.faltan.length >= 2, `debe decirlo todo de una vez: ${JSON.stringify(p.faltan)}`);
});

// ---------- lo que no se toca ----------

// Una fase cerrada es historico: reescribirla falsearia lo que paso (mismo criterio que huecosDeFase).
test('una fase YA cerrada no se vuelve a cerrar', () => {
  const p = planCerrarFase({ fase: fase({ estado: 'done' }), ...ok });
  assert.strictEqual(p.ok, false);
  assert.ok(p.faltan.some((f) => /ya.*cerrada|done/i.test(f)), JSON.stringify(p.faltan));
});

test('sin fase no hay nada que cerrar', () => {
  const p = planCerrarFase({ fase: null, ...ok });
  assert.strictEqual(p.ok, false);
  assert.ok(p.faltan.length > 0);
});

// Sin red no se inventan desajustes (desajustesDelFaseo ya devuelve [] en ese caso): cerrar debe
// seguir siendo posible, o quedarse sin conexion impediria gobernar el faseo.
test('sin datos de la forja (sin desajustes que mirar) se puede cerrar igual', () => {
  const p = planCerrarFase({ fase: fase(), informe: true, desajustes: [], siguiente: 2 });
  assert.strictEqual(p.ok, true, 'no poder consultar no es motivo para bloquear el cierre');
});
