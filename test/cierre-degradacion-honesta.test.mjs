// "No pude consultar" NO es "ya esta cerrada". Son dos cosas distintas y el cierre activo las
// trataba igual: 'if (est !== "open") continue', con un comentario que reconocia la ambiguedad y la
// aceptaba. Sin red, con el token caducado o con el rate limit agotado, la tarea se quedaba ABIERTA
// y nadie decia nada — trabajo ya integrado con su tarea viva indefinidamente, en silencio.
//
// 'planCierreDeTarea' separa los tres casos y dice que hacer con cada uno. Es pura: el estado se
// INYECTA, no se consulta aqui, para poder fijar el criterio con tests deterministas.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { planCierreDeTarea } = require(path.join(HOOKS, 'lib', 'ciclo.js'));

// ---------- los tres casos ----------

test("tarea ABIERTA: se cierra (su trabajo ya esta en develop)", () => {
  const p = planCierreDeTarea({ issue: '4', estado: 'open', rama: 'feat/4-mockup' });
  assert.strictEqual(p.accion, 'cerrar');
  assert.match(p.motivo, /develop|integrad/i, p.motivo);
});

test("tarea YA CERRADA: no se toca, y en silencio (es lo normal, la cerro su Closes #N)", () => {
  const p = planCierreDeTarea({ issue: '4', estado: 'closed', rama: 'feat/4-mockup' });
  assert.strictEqual(p.accion, 'nada');
  assert.strictEqual(p.aviso, null, 'lo normal no se anuncia: seria ruido');
});

// EL FALLO QUE ESTO ARREGLA: antes este caso caia en el mismo 'continue' que 'closed' y no decia nada.
test("NO se pudo consultar: NO se da por cerrada, y SE AVISA", () => {
  const p = planCierreDeTarea({ issue: '4', estado: null, rama: 'feat/4-mockup' });
  assert.strictEqual(p.accion, 'avisar', 'no se puede cerrar lo que no se pudo ni mirar');
  assert.ok(p.aviso, 'tiene que decirlo: el silencio es el fallo');
  assert.match(p.aviso, /#4/, `debe nombrar la tarea: ${p.aviso}`);
  assert.match(p.aviso, /no pude|no se pudo/i, `debe decir que no pudo consultarla: ${p.aviso}`);
});

test("el aviso de 'no pude consultar' dice QUE hacer, no solo que fallo", () => {
  const p = planCierreDeTarea({ issue: '7', estado: null, rama: 'feat/7-algo' });
  assert.match(p.aviso, /cerrar-tarea 7/, `debe dar la salida a mano: ${p.aviso}`);
});

// ---------- casos limite ----------

test("sin issue no hay nada que cerrar (la rama no estaba anclada a ninguna tarea)", () => {
  const p = planCierreDeTarea({ issue: null, estado: 'open', rama: 'feat/sin-anclar' });
  assert.strictEqual(p.accion, 'nada');
  assert.strictEqual(p.aviso, null, 'ya se avisa al abrir la peticion: no se repite aqui');
});

test("un estado que la forja no reconoce se trata como 'no pude consultar', no como cerrada", () => {
  // Prudencia: ante algo inesperado, NUNCA dar la tarea por cerrada — ese es el error caro.
  const p = planCierreDeTarea({ issue: '4', estado: 'loquesea', rama: 'feat/4-x' });
  assert.notStrictEqual(p.accion, 'nada');
  assert.ok(p.aviso, 'ante la duda, se dice');
});

test("el plan nombra la rama, para saber de que trabajo se habla", () => {
  const p = planCierreDeTarea({ issue: '4', estado: 'open', rama: 'feat/4-mockup-ui' });
  assert.match(p.motivo, /feat\/4-mockup-ui/, p.motivo);
});
