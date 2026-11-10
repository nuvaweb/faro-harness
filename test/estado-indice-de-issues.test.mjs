// REPARTO de responsabilidades entre ESTADO.md y la forja, para que el detalle viva en UN solo sitio:
//
//   ESTADO.md  -> RESUMEN: que se pretende en la fase + una linea por entregable con su id y quien lo hace
//   issue      -> TODO el detalle: objetivo, contexto, alcance, fuera de alcance, subtareas, criterios
//
// Hoy el detalle se duplica en los dos, y lo duplicado se desincroniza: un checkbox marcado en
// ESTADO.md mientras su issue sigue abierto (paso de verdad). Si ESTADO.md solo REFERENCIA, no hay
// nada que desincronizar — el estado real lo dice la forja.
//
// El titulo de cada entregable es GENERAL ("Personalizacion e identidad"), nunca atomico
// ("Traducir subtitle"): dice QUE ENTREGA, y el detalle de QUE HACER va dentro del issue.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { refDeTarea, tituloAtomico } = require(path.join(HOOKS, 'lib', 'ciclo.js'));

// ---------- la linea de ESTADO.md referencia su issue ----------

test('refDeTarea: saca el id y el responsable de la linea de resumen', () => {
  const r = refDeTarea('#4 Personalizacion e identidad — @ana-dev');
  assert.strictEqual(r.issue, '4');
  assert.strictEqual(r.quien, 'ana-dev');
  assert.match(r.titulo, /Personalizacion e identidad/);
});

test('refDeTarea: sin responsable declarado sigue leyendo el id', () => {
  const r = refDeTarea('#12 Pantallas del informe');
  assert.strictEqual(r.issue, '12');
  assert.strictEqual(r.quien, null);
});

test('refDeTarea: una tarea SIN issue (formato viejo) no rompe, solo no tiene id', () => {
  const r = refDeTarea('Configurar el wrangler.jsonc de la app');
  assert.strictEqual(r.issue, null);
  assert.match(r.titulo, /wrangler/);
});

test('refDeTarea: acepta el marcador [gh:N] / [gl:N] ademas de #N', () => {
  // Convencion equivalente, al estilo del '[cu:...]' de ClickUp: no tiene sentido pelearse con ella.
  assert.strictEqual(refDeTarea('Despliegue y entrega a produccion [gh:9] — @fer').issue, '9');
  assert.strictEqual(refDeTarea('Algo [gl:21] — @fer').issue, '21');
  assert.doesNotMatch(refDeTarea('Despliegue y entrega [gh:9] — @fer').titulo, /gh:/, 'el marcador no debe quedar en el titulo');
});

test('refDeTarea: acepta tambien "[resp: email]", el formato que ya existia', () => {
  const r = refDeTarea('#7 Integracion con la API [resp: fer@example.com]');
  assert.strictEqual(r.issue, '7');
  assert.strictEqual(r.quien, 'fer@example.com');
});

// ---------- titulos atomicos: el sintoma de haber troceado de mas ----------

test('tituloAtomico: un verbo de paso suelto delata atomizacion', () => {
  for (const t of ['Traducir common.subtitle', 'Renombrar la marca', 'Configurar navigation.ts', 'Anadir el favicon']) {
    assert.ok(tituloAtomico(t), `'${t}' deberia detectarse como atomico`);
  }
});

test('tituloAtomico: un entregable general NO se marca', () => {
  for (const t of ['Personalizacion e identidad del portal', 'Pantallas del informe', 'Integracion con la API de planta']) {
    assert.ok(!tituloAtomico(t), `'${t}' es un entregable, no un paso`);
  }
});

test('tituloAtomico: un verbo generico con alcance amplio no se marca', () => {
  // 'Implementar el mockup completo del informe' empieza por verbo pero entrega un bloque entero.
  assert.ok(!tituloAtomico('Implementar el mockup completo del informe partner'));
});

test('tituloAtomico: un BUG esta EXENTO — llega como llega, no se agrupa', () => {
  // Agrupar solo tiene sentido en lo que se PLANIFICA (el troceo es una decision). Un bug que
  // aparece tiene el alcance que tiene: se arregla y se cierra.
  for (const tipo of ['bug', 'hotfix', 'infra', 'pregunta']) {
    assert.ok(!tituloAtomico('Corregir el login roto', tipo), `'${tipo}' no debe exigir titulo amplio`);
  }
  // pero un tipo que planifica sigue avisando
  assert.ok(tituloAtomico('Traducir common.subtitle', 'tarea'));
});

test('tituloAtomico: vacio o nulo no revienta', () => {
  assert.ok(!tituloAtomico(''));
  assert.ok(!tituloAtomico(null));
});
