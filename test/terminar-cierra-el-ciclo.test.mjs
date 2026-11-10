// 'harness.js terminar': UNA orden que cierra el ciclo del trabajo de esta rama, en vez de cuatro
// comandos que alguien tiene que encadenar de memoria.
//
// El hueco que tapa: el harness MARCABA [x] y se paraba ahi, pidiendo al humano que "revisara
// ESTADO.md y cerrara la fase". En un repo real las 11 tareas de la Fase 1 quedaron marcadas, la rama
// nunca salio, y el issue siguio abierto con la fase sin cerrar. Nadie lo noto.
//
// Aqui se fija el PLAN: que pasos tocan segun el estado en que estes. La ejecucion (commit, PR,
// validate) la hace el comando; lo que se prueba es que DECIDE bien, incluido cuando debe negarse.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { planTerminar } = require(path.join(HOOKS, 'lib', 'ciclo.js'));

const base = {
  rama: 'feat/4-mockup', sucio: '', integrada: false, publicada: true,
  fase: { num: 1, nombre: 'Maqueta', done: 11, open: 0 }, prAbierto: null,
};

// ---------- cuando NO debe hacer nada ----------

test('terminar: en una rama protegida se niega (no hay ciclo de rama que cerrar)', () => {
  const p = planTerminar({ ...base, rama: 'develop' });
  assert.strictEqual(p.ok, false);
  assert.match(p.motivo, /develop|protegida|rama de trabajo/i, p.motivo);
});

test('terminar: con tareas de la fase ABIERTAS avisa, pero deja seguir (el bloque puede ser parcial)', () => {
  // Una rama puede cerrar SU tarea sin que la fase entera acabe: se avisa, no se bloquea.
  const p = planTerminar({ ...base, fase: { num: 1, nombre: 'Maqueta', done: 5, open: 6 } });
  assert.strictEqual(p.ok, true);
  assert.ok(p.avisos.some((a) => /6 .*abiert|abiert.*6/i.test(a)), `debe avisar de las que quedan: ${JSON.stringify(p.avisos)}`);
});

test('terminar: si la rama YA esta integrada, no repite el ciclo', () => {
  const p = planTerminar({ ...base, integrada: true });
  assert.strictEqual(p.ok, false);
  assert.match(p.motivo, /ya .*integrad/i, p.motivo);
});

test('terminar: "integrada" con trabajo SIN COMMITEAR no cuenta como ciclo cerrado', () => {
  // git compara COMMITS: una rama recien creada (o ya mergeada sobre la que se sigue trabajando)
  // apunta al mismo sitio que develop y sale "integrada". Si hay cambios sin guardar, el ciclo
  // sigue abierto — dar esto por cerrado bloqueaba el cierre de trabajo real.
  const p = planTerminar({ ...base, integrada: true, sucio: 'M documentos/f.md' });
  assert.strictEqual(p.ok, true, p.motivo);
  assert.deepStrictEqual(p.pasos.map((x) => x.tipo), ['commit', 'validate', 'pr']);
});

test('terminar: si ya hay peticion abierta para esta rama, no abre otra', () => {
  const p = planTerminar({ ...base, prAbierto: 'https://github.com/o/r/pull/7' });
  assert.strictEqual(p.ok, false);
  assert.match(p.motivo, /ya .*abiert/i, p.motivo);
  assert.match(p.motivo, /pull\/7/, 'y dice cual es');
});

// ---------- el plan normal ----------

test('terminar: trabajo listo -> valida, publica y abre la peticion', () => {
  const p = planTerminar(base);
  assert.strictEqual(p.ok, true);
  assert.deepStrictEqual(p.pasos.map((x) => x.tipo), ['validate', 'pr']);
});

test('terminar: con cambios sin commitear, el commit va PRIMERO (nada se queda fuera)', () => {
  const p = planTerminar({ ...base, sucio: 'M src/app.ts\nM ESTADO.md' });
  assert.strictEqual(p.ok, true);
  assert.deepStrictEqual(p.pasos.map((x) => x.tipo), ['commit', 'validate', 'pr']);
  assert.ok(p.pasos[0].ficheros.length === 2, 'debe saber cuantos ficheros entran');
});

test('terminar: el titulo de la peticion sale de la rama y cita su tarea', () => {
  const p = planTerminar(base);
  const pr = p.pasos.find((x) => x.tipo === 'pr');
  assert.match(pr.titulo, /mockup/i, `el titulo debe describir el trabajo: ${pr.titulo}`);
  assert.strictEqual(pr.issue, '4', 'y conocer la tarea que cierra');
});

test('terminar: una rama SIN tarea anclada sigue adelante, pero avisa de que no cerrara nada', () => {
  const p = planTerminar({ ...base, rama: 'feat/sin-numero' });
  assert.strictEqual(p.ok, true);
  assert.ok(p.avisos.some((a) => /no .*cerrar|sin .*tarea/i.test(a)), `debe avisar: ${JSON.stringify(p.avisos)}`);
  assert.strictEqual(p.pasos.find((x) => x.tipo === 'pr').issue, null);
});

test('terminar: si la rama no esta publicada, el plan lo contempla igual (pr crear la publica)', () => {
  const p = planTerminar({ ...base, publicada: false });
  assert.strictEqual(p.ok, true);
  assert.ok(p.pasos.some((x) => x.tipo === 'pr'), 'el paso de peticion sigue ahi');
});
