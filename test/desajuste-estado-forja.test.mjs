// ESTADO.md dice una cosa y la forja dice otra: un checkbox marcado [x] cuyo issue sigue ABIERTO es
// trabajo que se dio por hecho sin salir; un issue CERRADO sin marcar es trabajo hecho que el faseo
// no refleja. Las dos direcciones enganan a quien lee el estado.
//
// 'contabilidadFase' ya detectaba esto y tenia sus tests, pero NINGUN comando la invocaba: era codigo
// muerto. La deteccion existia, estaba probada, y no llegaba a nadie.
//
// 'desajustesDelFaseo' es la pieza que faltaba: recorre las fases ABIERTAS (las cerradas son
// historico, no se auditan) y agrupa lo que no cuadra, para que 'consolidar' y 'publicar' —los dos
// momentos donde aun se puede corregir— lo digan. Es pura: los estados se INYECTAN, no se leen de la
// red aqui, para poder fijarla con tests deterministas.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { desajustesDelFaseo } = require(path.join(HOOKS, 'lib', 'ciclo.js'));

const fase = (num, estado, tareas) => ({ num, nombre: `F${num}`, estado, tareas });
const t = (text, done) => ({ text, done });

// ---------- lo que delata ----------

test('checkbox [x] con su issue ABIERTO en la forja: se delata', () => {
  const fases = [fase(1, 'in_progress', [t('#4 · Mockup del informe — @fer', true)])];
  const r = desajustesDelFaseo(fases, { 4: 'open' });
  assert.strictEqual(r.length, 1, JSON.stringify(r));
  assert.match(r[0], /#4/, r[0]);
  assert.match(r[0], /abierta/i, r[0]);
});

test('issue CERRADO en la forja sin marcar [x]: tambien se delata (la otra direccion)', () => {
  const fases = [fase(1, 'in_progress', [t('#5 · Pantallas — @fer', false)])];
  const r = desajustesDelFaseo(fases, { 5: 'closed' });
  assert.strictEqual(r.length, 1, JSON.stringify(r));
  assert.match(r[0], /#5/, r[0]);
  assert.match(r[0], /cerrada/i, r[0]);
});

test('lo que cuadra no genera ruido', () => {
  const fases = [fase(1, 'in_progress', [
    t('#4 · Hecha y cerrada — @fer', true),
    t('#5 · Abierta y sin marcar — @fer', false),
  ])];
  assert.deepStrictEqual(desajustesDelFaseo(fases, { 4: 'closed', 5: 'open' }), []);
});

// ---------- que NO audita ----------

// Una fase cerrada es historico: reescribirla seria falsear lo que paso (mismo criterio que
// huecosDeFase). Ademas sus issues ya no se tocan, asi que el aviso no serviria para nada.
test('las fases DONE no se auditan: son historico', () => {
  const fases = [fase(1, 'done', [t('#4 · Algo — @fer', true)])];
  assert.deepStrictEqual(desajustesDelFaseo(fases, { 4: 'open' }), []);
});

test('una tarea SIN issue no puede desajustarse (no hay con que comparar)', () => {
  const fases = [fase(1, 'in_progress', [t('Algo sin id', true)])];
  assert.deepStrictEqual(desajustesDelFaseo(fases, {}), []);
});

// ---------- degradacion sin forja ----------

// Sin token, sin red o sin forja no se puede consultar nada. Convertir "no pude mirar" en "esta mal"
// dejaria el trabajo parado por estar sin conexion: sin estados, no se inventa ningun desajuste.
test('sin estados de la forja no se inventa nada', () => {
  const fases = [fase(1, 'in_progress', [t('#4 · Algo — @fer', true)])];
  assert.deepStrictEqual(desajustesDelFaseo(fases, null), []);
  assert.deepStrictEqual(desajustesDelFaseo(fases, undefined), []);
});

test('un issue que no se pudo consultar (sin entrada en estados) no cuenta como desajuste', () => {
  const fases = [fase(1, 'in_progress', [t('#4 · Algo — @fer', true), t('#9 · Otra — @fer', true)])];
  const r = desajustesDelFaseo(fases, { 4: 'open' });   // #9 no se pudo consultar
  assert.strictEqual(r.length, 1, `solo #4 esta desajustada: ${JSON.stringify(r)}`);
  assert.match(r[0], /#4/, r[0]);
});

test('sin fases no hay nada que auditar', () => {
  assert.deepStrictEqual(desajustesDelFaseo([], { 4: 'open' }), []);
  assert.deepStrictEqual(desajustesDelFaseo(null, { 4: 'open' }), []);
});

// ---------- agrupacion ----------

test('varias fases abiertas: el aviso dice de que fase es cada desajuste', () => {
  const fases = [
    fase(1, 'in_progress', [t('#4 · Una — @fer', true)]),
    fase(2, 'pending', [t('#7 · Otra — @fer', false)]),
  ];
  const r = desajustesDelFaseo(fases, { 4: 'open', 7: 'closed' });
  assert.strictEqual(r.length, 2, JSON.stringify(r));
  assert.ok(r.some((x) => /Fase 1/.test(x) && /#4/.test(x)), JSON.stringify(r));
  assert.ok(r.some((x) => /Fase 2/.test(x) && /#7/.test(x)), JSON.stringify(r));
});

// Los ids llegan de la API como NUMEROS y del texto del checkbox como STRING: si el lookup no
// normaliza, ningun desajuste se detecta jamas y el aviso queda mudo para siempre.
test('los ids cuadran vengan como numero o como string (la API da numeros)', () => {
  const fases = [fase(1, 'in_progress', [t('#4 · Algo — @fer', true)])];
  assert.strictEqual(desajustesDelFaseo(fases, { 4: 'open' }).length, 1, 'clave numerica');
  assert.strictEqual(desajustesDelFaseo(fases, { '4': 'open' }).length, 1, 'clave string');
});
