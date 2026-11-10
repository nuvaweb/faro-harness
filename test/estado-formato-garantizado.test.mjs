// ESTADO.md no es un documento de estilo libre: es la fuente del faseo, y su formato debe estar
// GARANTIZADO por validacion, no confiado a que alguien recuerde la convencion.
//
// Lo que cada fase debe traer:
//   ### Fase N · <nombre> — <estado>      (cabecera)
//   <descripcion: que trae esta fase>     (2-3 lineas, no opcional: sin esto la fase es un titulo)
//   - [ ] #<id> · <titulo GENERAL> — @<quien>
//         <resumen de que abarca>
//
// El detalle completo vive en el issue; aqui va lo justo para leer la fase de un vistazo y saber
// quien hace que. Y con eso se puede CONTABILIZAR: cuantos entregables trae la fase, cuantos tienen
// id (estan en la forja), cuantos tienen dueno, cuantos van hechos.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { huecosDeFase, contabilidadFase } = require(path.join(HOOKS, 'lib', 'ciclo.js'));

const faseOk = {
  num: 1,
  nombre: 'Mockup UI',
  estado: 'in_progress',
  descripcion: 'Maquetar las tres pantallas del informe con datos de ejemplo, sobre el DS Acme.',
  objetivo: '2026-10-15',
  tareas: [
    { text: '#4 · Personalizacion e identidad — @fer', done: false, resumen: 'Marca, colores y traducciones.' },
    { text: '#5 · Pantallas del informe — @fer', done: true, resumen: 'Planta, Servicios y Evolucion.' },
  ],
};

// ---------- que le falta a una fase ----------

test('huecosDeFase: una fase bien formada no tiene huecos', () => {
  assert.deepStrictEqual(huecosDeFase(faseOk), []);
});

test('huecosDeFase: una fase SIN descripcion es solo un titulo', () => {
  const h = huecosDeFase({ ...faseOk, descripcion: '' });
  assert.ok(h.some((x) => /descripcion/i.test(x)), JSON.stringify(h));
});

// La fecha objetivo NO es rigida en su VALOR (se reajusta libremente si cambia el alcance — 'hito
// sync' la actualiza en el hito cuando difiere), pero SI es obligatoria que EXISTA: sin ella nadie
// sabe cuando se espera la fase, y el vencimiento del hito de la forja se queda vacio en silencio.
test("huecosDeFase: una fase SIN 'Objetivo:' no tiene fecha que reflejar en su hito", () => {
  const h = huecosDeFase({ ...faseOk, objetivo: null });
  assert.ok(h.some((x) => /objetivo|fecha/i.test(x)), JSON.stringify(h));
});

test("huecosDeFase: una fase CON 'Objetivo:' no protesta por fecha (se reajusta libremente despues)", () => {
  const h = huecosDeFase(faseOk);
  assert.ok(!h.some((x) => /objetivo|fecha/i.test(x)), JSON.stringify(h));
});

test('huecosDeFase: una tarea SIN id de issue se senala (no esta en la forja)', () => {
  const h = huecosDeFase({ ...faseOk, tareas: [{ text: 'Personalizacion e identidad — @fer', done: false }] });
  assert.ok(h.some((x) => /id|#/i.test(x)), JSON.stringify(h));
});

test('huecosDeFase: una tarea SIN responsable se senala (nadie la hace)', () => {
  const h = huecosDeFase({ ...faseOk, tareas: [{ text: '#4 · Personalizacion e identidad', done: false }] });
  assert.ok(h.some((x) => /quien|responsable/i.test(x)), JSON.stringify(h));
});

test('huecosDeFase: un titulo ATOMICO se senala aunque tenga id y dueno', () => {
  const h = huecosDeFase({ ...faseOk, tareas: [{ text: '#9 · Traducir subtitle — @fer', done: false }] });
  assert.ok(h.some((x) => /paso|atomic|general/i.test(x)), JSON.stringify(h));
});

test('huecosDeFase: una fase SIN tareas no puede planificarse', () => {
  const h = huecosDeFase({ ...faseOk, tareas: [] });
  assert.ok(h.some((x) => /tarea/i.test(x)), JSON.stringify(h));
});

test('huecosDeFase: una fase CERRADA no se audita (es historico, no se reescribe)', () => {
  assert.deepStrictEqual(huecosDeFase({ ...faseOk, estado: 'done', descripcion: '', tareas: [] }), []);
});

// RIGIDO en los estados: el formato de una fase ABIERTA no se negocia. La flexibilidad esta en el
// CONTENIDO del issue (el agente amplia lo que encuentre), no en como se gobierna el faseo.
test('huecosDeFase: aplica a TODA fase abierta, tambien a las futuras (backlog/pending)', () => {
  for (const estado of ['in_progress', 'pending', 'backlog', 'testing']) {
    const h = huecosDeFase({ ...faseOk, estado, tareas: [{ text: 'Algo sin id ni dueno', done: false }] });
    assert.ok(h.length > 0, `'${estado}' es una fase abierta: debe auditarse`);
  }
});

// 'draft': la fase existe en el papel pero su hito TODAVIA no se ha creado en la forja (onboarding,
// antes de 'hito sync'). Exigir #N ahi es una dependencia circular: el onboarding pide escribir el
// faseo sin ids, y esos ids solo existen DESPUES de integrar esa misma rama y correr 'hito sync'.
test("huecosDeFase: 'draft' exime #N y @quien (el hito aun no existe) pero SIGUE exigiendo descripcion y tareas", () => {
  const base = { ...faseOk, estado: 'draft', tareas: [{ text: 'Personalizacion e identidad', done: false }] };
  assert.deepStrictEqual(huecosDeFase(base), []);
  const sinDescripcion = huecosDeFase({ ...base, descripcion: '' });
  assert.ok(sinDescripcion.some((x) => /descripcion/i.test(x)), JSON.stringify(sinDescripcion));
  const sinTareas = huecosDeFase({ ...base, tareas: [] });
  assert.ok(sinTareas.some((x) => /tarea/i.test(x)), JSON.stringify(sinTareas));
});

test("huecosDeFase: 'draft' SI exige 'Objetivo:' (la fecha NO depende del hito, la decide el equipo antes)", () => {
  const h = huecosDeFase({ ...faseOk, estado: 'draft', objetivo: null, tareas: [{ text: 'Personalizacion e identidad', done: false }] });
  assert.ok(h.some((x) => /objetivo|fecha/i.test(x)), JSON.stringify(h));
});

test("huecosDeFase: 'draft' SI senala un titulo ATOMICO (eso no depende de la forja)", () => {
  const h = huecosDeFase({ ...faseOk, estado: 'draft', tareas: [{ text: 'Traducir subtitle', done: false }] });
  assert.ok(h.some((x) => /paso|atomic|general/i.test(x)), JSON.stringify(h));
});

test('huecosDeFase: agrupa por fase, no escupe dos lineas por tarea', () => {
  // Un ESTADO.md con 5 tareas sueltas daba 10 avisos y el ruido tapaba el mensaje.
  const cinco = Array.from({ length: 5 }, (_, i) => ({ text: `Cosa ${i}`, done: false }));
  const h = huecosDeFase({ ...faseOk, tareas: cinco });
  assert.ok(h.length <= 3, `deberia agrupar, no listar una por tarea: ${h.length} avisos`);
  assert.ok(h.some((x) => /5\/5/.test(x)), `y decir el recuento: ${JSON.stringify(h)}`);
});

// ---------- contabilidad: que trae la fase ----------

test('contabilidadFase: cuenta entregables, cuantos van hechos y cuantos estan en la forja', () => {
  const c = contabilidadFase(faseOk);
  assert.strictEqual(c.total, 2);
  assert.strictEqual(c.hechas, 1);
  assert.strictEqual(c.conIssue, 2);
  assert.strictEqual(c.conResponsable, 2);
});

test('contabilidadFase: distingue las que NO estan en la forja (sin id)', () => {
  const c = contabilidadFase({ ...faseOk, tareas: [
    { text: '#4 · Algo — @fer', done: false },
    { text: 'Otra cosa sin id', done: false },
  ] });
  assert.strictEqual(c.total, 2);
  assert.strictEqual(c.conIssue, 1);
  assert.deepStrictEqual(c.sinIssue, ['Otra cosa sin id']);
});

test('contabilidadFase: una fase vacia cuenta cero, no revienta', () => {
  const c = contabilidadFase({ ...faseOk, tareas: [] });
  assert.strictEqual(c.total, 0);
  assert.strictEqual(c.hechas, 0);
});

// La fase ES el hito: su contabilidad debe poder leerse contra el estado REAL de la forja
// (cuantos issues creados, cuantos abiertos, cuantos cerrados), no solo contra los checkboxes del
// fichero — que es justo lo que se desincroniza.
test('contabilidadFase: con el estado real de la forja, separa abiertos de cerrados', () => {
  const c = contabilidadFase(faseOk, { 4: 'open', 5: 'closed' });
  assert.strictEqual(c.abiertos, 1);
  assert.strictEqual(c.cerrados, 1);
});

test('contabilidadFase: delata el DESAJUSTE entre el checkbox y la forja', () => {
  // '#5' esta marcado [x] en ESTADO.md pero su issue sigue abierto: el caso real que motivo todo.
  const c = contabilidadFase(faseOk, { 4: 'open', 5: 'open' });
  assert.ok(c.desajustes.length >= 1, JSON.stringify(c.desajustes));
  assert.ok(c.desajustes.some((d) => /#5/.test(d)), JSON.stringify(c.desajustes));
});

test('contabilidadFase: sin datos de la forja no inventa abiertos ni cerrados', () => {
  const c = contabilidadFase(faseOk);
  assert.strictEqual(c.abiertos, null);
  assert.strictEqual(c.cerrados, null);
  assert.deepStrictEqual(c.desajustes, []);
});
