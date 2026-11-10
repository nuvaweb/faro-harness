// ESCRIBIR en ESTADO.md es nuevo: hasta ahora el harness solo LEIA el faseo (lo unico que lo creaba
// era el onboarding). Y ESTADO.md es la fuente de verdad del trabajo, asi que una reescritura torpe
// —perder una tarea, romper el frontmatter, cambiar de mas— destruye el gobierno entero.
//
// Por eso la reescritura es una funcion PURA sobre el texto, fijada con tests: se cambia UNA cosa y
// se deja TODO lo demas byte a byte como estaba.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { cerrarFaseEnTexto } = require(path.join(HOOKS, 'lib', 'estado.js'));

const DOC = `---
iniciativa: Prueba
fases_total: 2
fase_actual: 1
owner: fer
---

# Prueba

### Fase 1 · Mockup UI — in_progress
Las tres pantallas del informe.
Objetivo: 2026-12-01
- [x] #4 · Pantallas — @fer
      Planta, Servicios y Evolucion.

### Fase 2 · Integracion — pending
Conectar con la API real.
Objetivo: 2027-01-15
- [ ] #7 · Cliente de la API — @fer
`;

// ---------- lo que cambia ----------

test('la fase pasa a done en su cabecera', () => {
  const out = cerrarFaseEnTexto(DOC, 1, 2);
  assert.match(out, /^### Fase 1 · Mockup UI — done$/m, out.slice(0, 400));
});

test('fase_actual avanza a la siguiente', () => {
  const out = cerrarFaseEnTexto(DOC, 1, 2);
  assert.match(out, /^fase_actual: 2$/m);
});

test('cerrar la ULTIMA fase deja fase_actual como estaba (no hay siguiente)', () => {
  const out = cerrarFaseEnTexto(DOC, 2, null);
  assert.match(out, /^### Fase 2 · Integracion — done$/m);
  assert.match(out, /^fase_actual: 1$/m, 'sin siguiente fase, no se inventa un numero');
});

// ---------- lo que NO puede cambiar ----------

test('NO toca la otra fase', () => {
  const out = cerrarFaseEnTexto(DOC, 1, 2);
  assert.match(out, /^### Fase 2 · Integracion — pending$/m, 'la fase 2 se queda como estaba');
});

test('NO toca las tareas, ni sus checkbox, ni sus resumenes', () => {
  const out = cerrarFaseEnTexto(DOC, 1, 2);
  assert.match(out, /- \[x\] #4 · Pantallas — @fer/);
  assert.match(out, /      Planta, Servicios y Evolucion\./);
  assert.match(out, /- \[ \] #7 · Cliente de la API — @fer/);
});

test('NO toca descripciones, objetivos ni el resto del frontmatter', () => {
  const out = cerrarFaseEnTexto(DOC, 1, 2);
  assert.match(out, /^Objetivo: 2026-12-01$/m);
  assert.match(out, /^Objetivo: 2027-01-15$/m);
  assert.match(out, /^iniciativa: Prueba$/m);
  assert.match(out, /^fases_total: 2$/m);
  assert.match(out, /^owner: fer$/m);
});

test('cambia SOLO dos lineas en todo el documento', () => {
  const out = cerrarFaseEnTexto(DOC, 1, 2);
  const antes = DOC.split('\n'), despues = out.split('\n');
  assert.strictEqual(antes.length, despues.length, 'no se anaden ni se pierden lineas');
  const distintas = antes.filter((l, i) => l !== despues[i]);
  assert.strictEqual(distintas.length, 2, `solo la cabecera y fase_actual: ${JSON.stringify(distintas)}`);
});

// ---------- casos limite ----------

test('una fase que no existe deja el texto INTACTO', () => {
  assert.strictEqual(cerrarFaseEnTexto(DOC, 9, null), DOC);
});

test('respeta el formato con [cu:...] de la cabecera', () => {
  const conCu = DOC.replace('### Fase 1 · Mockup UI — in_progress', '### Fase 1 · Mockup UI — in_progress [cu:abc-123]');
  const out = cerrarFaseEnTexto(conCu, 1, 2);
  assert.match(out, /^### Fase 1 · Mockup UI — done \[cu:abc-123\]$/m, 'el id de ClickUp no se pierde');
});

test('no rompe un documento con saltos de linea CRLF', () => {
  const crlf = DOC.replace(/\n/g, '\r\n');
  const out = cerrarFaseEnTexto(crlf, 1, 2);
  assert.match(out, /### Fase 1 · Mockup UI — done/);
  assert.ok(out.includes('\r\n'), 'conserva los CRLF');
});
