// EARS: la CONDICION de un requisito normativo va delante y con palabra fija.
// Lo que de verdad detecta el chequeo no es "empieza por CUANDO" (eso lo cumple quien copia la
// plantilla) sino la CONDICION ENTERRADA detras del verbo normativo, que es donde se cae la
// ambiguedad. Y no debe confundirse con el "si" de PREGUNTA INDIRECTA del espanol.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'harness.js');
const EARS = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'ears.js');
const cargar = (schema = null) => import(`file://${EARS.replace(/\\/g, '/')}`)
  .then((m) => m.default({ faroSchema: () => schema }));

test('EARS: las cinco formas con la condicion DELANTE se aceptan', async () => {
  const e = await cargar();
  const casos = [
    ['ubicua', 'El harness DEBE denegar la ejecucion.'],
    ['evento', 'CUANDO se cierra una fase, el harness DEBE exigir su informe.'],
    ['estado', 'MIENTRAS la rama sea protegida, el harness DEBE bloquear la escritura.'],
    ['opcional', 'DONDE el repo tenga codigo, el harness DEBE correr los gates.'],
    ['no_deseada', 'SI el commit contiene un secreto, ENTONCES el harness DEBE denegarlo.'],
  ];
  for (const [forma, texto] of casos) {
    const r = e.clasificar(texto);
    assert.ok(r.ok, `${forma} deberia aceptarse: ${texto} -> ${r.motivo}`);
    assert.strictEqual(r.forma, forma);
  }
});

test('EARS: la condicion ENTERRADA detras del verbo normativo se avisa, con la forma que toca', async () => {
  const e = await cargar();
  const r1 = e.clasificar('El harness DEBE rechazar el commit si contiene un secreto.');
  assert.strictEqual(r1.ok, false);
  assert.match(r1.sugerencia, /^SI /, 'un "si" enterrado se corrige con la forma de no deseado');

  const r2 = e.clasificar('El harness DEBE avisar cuando la fase quede sin informe.');
  assert.strictEqual(r2.ok, false);
  assert.match(r2.sugerencia, /^CUANDO /, 'un "cuando" enterrado se corrige con la forma de evento');

  const r3 = e.clasificar('El harness DEBE bloquear el push mientras la rama sea protegida.');
  assert.strictEqual(r3.ok, false);
  assert.match(r3.sugerencia, /^MIENTRAS /);
});

test('EARS: el "si" de PREGUNTA INDIRECTA no es una condicion y NO se avisa', async () => {
  // Sin esto el aviso seria ruido, y un aviso que es ruido acaba desactivando el gate entero.
  const e = await cargar();
  for (const texto of [
    'El harness DEBE comprobar si la rama esta integrada.',
    'El harness DEBE resolver, a partir de la URL de origin, si el proyecto vive en GitHub o en GitLab.',
    'El informe DEBE indicar si hubo squash.',
    'El sistema DEBE determinar si el documento esta aprobado.',
  ]) {
    assert.ok(e.clasificar(texto).ok, `falso positivo con pregunta indirecta: ${texto}`);
  }
});

test('EARS: la forma de no deseado exige el ENTONCES que separa condicion de respuesta', async () => {
  const e = await cargar();
  const r = e.clasificar('SI el commit contiene un secreto, el harness DEBE denegarlo.');
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /ENTONCES/);
});

test('EARS: por defecto AVISA; el repo puede exigirlo como gate desde su contrato', async () => {
  assert.strictEqual((await cargar()).modo(), 'aviso', 'por defecto no puede romper specs ya escritas');
  assert.strictEqual((await cargar({ enums: { ears: { modo: 'gate' } } })).modo(), 'gate');
});

// --- integracion: el modo del contrato decide si es aviso o error de validate ---

function repoConRequisito(texto, schema) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-ears-'));
  const w = (rel, t) => {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), t);
  };
  w('gestion/cambios/changes/c1/proposal.md', `---
titulo: C
descripcion: x
estado: aprobada
fase: 1
owner: T
responsable: t@t
tareas: []
aprobada_por: T
---
## Por qué
Motivo suficientemente largo para el gate del harness, con contexto real.
## Qué cambia
- Algo
`);
  w('gestion/cambios/changes/c1/specs/cap/spec.md',
    `## Requisitos AÑADIDOS\n\n### Requisito: Uno\n${texto}\n\n#### Escenario: caso\n- CUANDO pasa\n- ENTONCES ocurre\n`);
  if (schema) w('.claude/faro-schema.json', JSON.stringify(schema));
  return dir;
}
const validar = (dir) => spawnSync(process.execPath, [HARNESS, 'specs', 'validar'], {
  cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
});

test('EARS en modo aviso: sale en la lista de avisos y NO tumba la validacion', () => {
  const dir = repoConRequisito('El harness DEBE rechazar el commit si contiene un secreto.');
  const r = validar(dir);
  assert.strictEqual(r.status, 0, 'en modo aviso no debe fallar');
  assert.match(r.stdout, /condicion.*DETRAS|Forma EARS/i, `esperaba el aviso EARS:\n${r.stdout}`);
});

test('EARS en modo gate: el mismo requisito TUMBA la validacion', () => {
  const dir = repoConRequisito(
    'El harness DEBE rechazar el commit si contiene un secreto.',
    { enums: { ears: { modo: 'gate' } } },
  );
  const r = validar(dir);
  assert.notStrictEqual(r.status, 0, `en modo gate deberia fallar:\n${r.stdout}`);
});

test('EARS: un requisito bien escrito pasa en modo GATE', () => {
  const dir = repoConRequisito(
    'SI el commit contiene un secreto, ENTONCES el harness DEBE rechazarlo.',
    { enums: { ears: { modo: 'gate' } } },
  );
  const r = validar(dir);
  assert.strictEqual(r.status, 0, `un requisito EARS correcto no debe fallar:\n${r.stdout}`);
});
