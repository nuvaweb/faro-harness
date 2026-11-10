// Las FASES de ESTADO.md tienen que llegar al adaptador de la forja — en las DOS, no solo en GitLab.
//
// Bug real: ghMod() construia github.js con { ROOT, git, IS_TEMPLATE, specBase, forge } y NADA MAS.
// La rama de GitLab de forjaMod() si inyectaba `fases`, `isDone` e `isActive`; la de GitHub no. Como
// github.js los reenvia a github-gestion.js (hitos = fases) y a github-tareas.js (asignar-tarea
// --fase), en GitHub:
//   - `hito sync` decia "ESTADO.md sin fases: nada que sincronizar" con 7 fases en el fichero.
//   - `asignar-tarea --fase N` no encontraba NINGUNA fase -> rechazaba cualquier numero como
//     inexistente, y un tipo de PLAN quedaba sin poder anclarse.
// Este test es de CABLEADO (igual que 0.30.1): comprueba que el contrato que github.js espera es el
// que harness.js le entrega, sin depender de la API ni de la red.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const HARNESS_SRC = fs.readFileSync(path.join(HOOKS, 'harness.js'), 'utf8');

// Lo que github.js LEE del contexto que recibe (ctx.X) y reenvia a sus submodulos.
function ctxUsadoPorGithub() {
  const src = fs.readFileSync(path.join(HOOKS, 'lib', 'github.js'), 'utf8');
  const usados = new Set();
  for (const m of src.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) usados.add(m[1]);
  return usados;
}

// Lo que ghMod() le PASA de verdad. El objeto puede tener callbacks con llaves anidadas, asi que se
// acota por extremos textuales (desde '_ghMod = ' hasta el 'return _ghMod') en vez de emparejar
// llaves con una regex, y se recogen las claves de nivel superior que aparezcan.
function ctxEntregadoPorGhMod() {
  const ini = HARNESS_SRC.indexOf('_ghMod = fs.existsSync(mod)');
  assert.ok(ini > 0, 'no encuentro la construccion de github.js en ghMod()');
  const bloque = HARNESS_SRC.slice(ini, HARNESS_SRC.indexOf('return _ghMod;', ini));
  const entregado = new Set();
  // 'clave:' (con valor) o 'clave,' / 'clave\n' (atajo): ambas formas cuentan como entregadas.
  for (const m of bloque.matchAll(/(?:^|[{,\s])([A-Za-z_$][\w$]*)\s*[:,\n]/g)) entregado.add(m[1]);
  return entregado;
}

test('ghMod() entrega TODO lo que github.js lee de ctx (cableado completo)', () => {
  const usados = ctxUsadoPorGithub();
  const entregado = ctxEntregadoPorGhMod();
  const faltan = [...usados].filter((k) => !entregado.has(k)).sort();
  assert.deepStrictEqual(faltan, [],
    `github.js lee ctx.${faltan.join(', ctx.')} pero ghMod() no se lo pasa — en runtime llega undefined`);
});

test('fases/isDone/isActive llegan a GitHub, no solo a GitLab (hito sync y asignar-tarea --fase los necesitan)', () => {
  const entregado = ctxEntregadoPorGhMod();
  for (const clave of ['fases', 'isDone', 'isActive']) {
    assert.ok(entregado.has(clave), `ghMod() no inyecta '${clave}': 'hito sync' diria "sin fases" y '--fase' rechazaria toda fase`);
  }
});

test('la rama de GitLab sigue inyectando lo suyo (no se rompe la paridad al arreglar GitHub)', () => {
  // El bloque de GitLab tiene llaves anidadas (callbacks), asi que se acota por sus extremos
  // textuales en vez de intentar emparejar llaves con una regex.
  // Ancla al require() real, no a la primera mencion del fichero (que es un comentario mas arriba,
  // y el 'return _forjaMod;' del cache cortaria el bloque antes de llegar al codigo).
  const ini = HARNESS_SRC.indexOf("require(mod)({", HARNESS_SRC.indexOf("'forge-gitlab.js'"));
  assert.ok(ini > 0, 'no encuentro la construccion de forge-gitlab.js en forjaMod()');
  const bloque = HARNESS_SRC.slice(ini, HARNESS_SRC.indexOf('return _forjaMod;', ini));
  for (const clave of ['fases', 'isDone', 'isActive']) {
    assert.ok(new RegExp(`\\b${clave}\\b`).test(bloque), `la rama de GitLab perdio '${clave}'`);
  }
});
