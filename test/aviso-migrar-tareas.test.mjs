// AVISO PROACTIVO de tareas sin migrar: un repo con ESTADO.md ya actualizado a 0.31.2+ (con
// asignar-tarea --fase disponible) pero cuyas tareas siguen escritas a mano en checkboxes no se
// entera de que deberia migrar hasta que alguien tropieza con el bloqueo de --fase al crear una
// tarea nueva. El detector es LOCAL (solo lee ESTADO.md, sin red) y vive en el mismo punto donde
// ya se avisa de ESTADO.md ausente (onboardingDirective) — no bloquea nada, solo sugiere.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${name}-`));
const run = (args, cwd) => spawnSync(process.execPath, [HARNESS, ...args], { cwd, encoding: 'utf8', timeout: 120000, env: { ...process.env, CLAUDE_PROJECT_DIR: cwd } });

async function cargarHarnessFn(nombre) {
  // harness.js no exporta modulo (es un CLI): se prueba la funcion pura extraida a lib/ para poder
  // testearla sin montar todo el dispatcher. Ver lib/tareas-legacy.js.
  const mod = await import(`file://${path.join(HOOKS, 'lib', 'tareas-legacy.js').replace(/\\/g, '/')}`);
  return mod[nombre] || mod.default[nombre];
}

const faseConDetalle = (num, nombre, estado, nAbiertas) => ({
  num, nombre, estado,
  tareas: Array.from({ length: nAbiertas }, (_, i) => ({
    done: false,
    // texto LARGO con referencias tipicas de tarea de gestion real (no un placeholder corto)
    text: `Definir el modelo de datos numero ${i}: entidades, relaciones y estado — registrado en el ADR-00${i} correspondiente`,
  })),
});

test('tareasLegacySinMigrar: fase con varias tareas de texto LARGO y abiertas -> sugiere migrar', async () => {
  const fn = await cargarHarnessFn('tareasLegacySinMigrar');
  const fases = [faseConDetalle(1, 'Fundamentos', 'in_progress', 5)];
  const r = fn(fases);
  assert.ok(r.length > 0, 'debe detectar la fase con detalle operativo');
  assert.match(r.join('\n'), /Fase 1/, r.join('\n'));
  assert.match(r.join('\n'), /migrar-tareas/, 'debe apuntar al comando/skill que resuelve esto');
});

test('tareasLegacySinMigrar: fase con tareas CORTAS (placeholder tipo "- [ ] algo") -> NO avisa', async () => {
  const fn = await cargarHarnessFn('tareasLegacySinMigrar');
  const fases = [{ num: 1, nombre: 'Piloto', estado: 'in_progress', tareas: [{ done: false, text: 'algo' }, { done: false, text: 'otra cosa' }] }];
  const r = fn(fases);
  assert.deepStrictEqual(r, [], 'tareas cortas no son necesariamente detalle operativo real; no molestar sin evidencia');
});

test('tareasLegacySinMigrar: fase SIN tareas abiertas (todas [x]) -> NO avisa, no hay nada que migrar', async () => {
  const fn = await cargarHarnessFn('tareasLegacySinMigrar');
  const fases = [{ num: 2, nombre: 'Repositorio', estado: 'done', tareas: [{ done: true, text: 'Migraciones del esquema de entidades, relaciones, estado, glosario, linaje y Documento/Chunk — Alembic, 15 tablas' }] }];
  const r = fn(fases);
  assert.deepStrictEqual(r, []);
});

test('tareasLegacySinMigrar: ESTADO.md ya adelgazado (pocas o cero tareas por fase) -> NO avisa (idempotente)', async () => {
  const fn = await cargarHarnessFn('tareasLegacySinMigrar');
  const fases = [{ num: 1, nombre: 'Fundamentos', estado: 'in_progress', tareas: [] }];
  const r = fn(fases);
  assert.deepStrictEqual(r, []);
});

test('tareasLegacySinMigrar: sin fases (repo nivel 0 o sin ESTADO.md) -> array vacio, no revienta', async () => {
  const fn = await cargarHarnessFn('tareasLegacySinMigrar');
  assert.deepStrictEqual(fn([]), []);
  assert.deepStrictEqual(fn(null), []);
  assert.deepStrictEqual(fn(undefined), []);
});

test('tareasLegacySinMigrar: varias fases con detalle -> las agrupa en UN solo aviso, no uno por fase', async () => {
  const fn = await cargarHarnessFn('tareasLegacySinMigrar');
  const fases = [faseConDetalle(1, 'Fundamentos', 'done', 3), faseConDetalle(3, 'Ingesta', 'pending', 4)];
  const r = fn(fases);
  assert.strictEqual(r.length, 1, 'un solo bloque de aviso, no uno por fase (evitar ruido)');
  assert.match(r[0], /Fase 1/); assert.match(r[0], /Fase 3/);
});

// De extremo a extremo: 'harness.js session' es lo que de verdad recibe el agente al arrancar.
test("harness.js session: ESTADO.md con tareas de texto largo -> sugiere /faro:migrar-tareas", () => {
  const dir = tmp('session-legacy');
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), `---
nombre: proyecto
clave: PRU
objetivo: Prueba
estado: in_progress
fases_total: 1
fase_actual: 1
owner: tester
---
### Fase 1 · Fundamentos — in_progress
- [ ] Definir el modelo de datos del nucleo: entidades, relaciones, estado y linaje — con su diagrama versionado
- [ ] Definir los metadatos comunes a todo documento que el proceso de entrada debe exigir y persistir
`);
  const r = run(['session'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /TAREAS SIN MIGRAR/, r.stdout);
  assert.match(r.stdout, /faro:migrar-tareas/, r.stdout);
});

test("harness.js session: ESTADO.md YA adelgazado (sin checkboxes largos) -> NO sugiere migrar", () => {
  const dir = tmp('session-adelgazado');
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), `---
nombre: proyecto
clave: PRU
objetivo: Prueba
estado: in_progress
fases_total: 1
fase_actual: 1
owner: tester
---
### Fase 1 · Fundamentos — in_progress
Objetivo: fijar el modelo de datos del nucleo.
- [ ] ver hito
`);
  const r = run(['session'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /TAREAS SIN MIGRAR/, r.stdout);
});
