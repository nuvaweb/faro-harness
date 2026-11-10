// El bloqueo de 'stop-check' tiene que decir COMO SALIR, y la salida depende de la rama.
//
// Caso real que lo motivo: al arrancar un repo LEGACY, FARO genera ESTADO.md estando en 'develop'.
// Entonces stop-check bloqueaba el turno exigiendo commitearlo... y el propio motor PROHIBE commitear
// en develop. Callejon sin salida: el motor crea el fichero, exige el commit, y lo impide donde
// estas. Y el mensaje no mencionaba la rama, asi que el agente lo intentaba y chocaba con el OTRO
// bloqueo.
//
// Matiz que costo un fallo: la lista buena es isNoWrite (main/master/develop + las de .faro.json),
// NO isProtected — 'protegida' son solo main/master, que sirven para detectar cual es la principal.
// Con isProtected el mensaje nuevo NO salia en develop, que es justo el caso que lo motivo.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'harness.js');

// Repo con ESTADO.md generado y SIN commitear, en la rama que se indique.
function repo(rama, faroJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-stop-'));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'base.txt'), 'x');
  if (faroJson) fs.writeFileSync(path.join(dir, '.faro.json'), JSON.stringify(faroJson));
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  if (rama !== 'main') git('switch', '-q', '-c', rama);
  // Lo que genera FARO al arrancar, aun sin commitear: esto es lo que dispara el bloqueo.
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), '---\niniciativa: T\n---\n### Fase 1 · X — in_progress\n');
  return dir;
}
const stopCheck = (dir) => spawnSync(process.execPath, [HARNESS, 'stop-check'], {
  cwd: dir, encoding: 'utf8', timeout: 60000, input: '{"stop_hook_active":false}',
  env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
});

test('en develop, el bloqueo dice que hay que CREAR RAMA (no solo "commitealos")', () => {
  const r = stopCheck(repo('develop'));
  assert.strictEqual(r.status, 2, 'sigue bloqueando: el artefacto generado esta suelto');
  assert.match(r.stderr, /develop/, r.stderr);
  assert.match(r.stderr, /NO deja commitear|no deja commitear/i, `debe decir por que no vale commitear aqui: ${r.stderr}`);
  assert.match(r.stderr, /switch -c|harness\.js rama/, `y debe dar el comando exacto: ${r.stderr}`);
});

test('en main tambien: es rama de publicacion, tampoco se commitea ahi', () => {
  const r = stopCheck(repo('main'));
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /switch -c|harness\.js rama/, r.stderr);
});

// Una rama de entorno declarada por el repo recibe el mismo trato que develop: el motor le rechaza
// el commit igual, asi que el mensaje tiene que contarlo igual.
test('una rama de entorno de .faro.json recibe el mismo mensaje', () => {
  const r = stopCheck(repo('pre', { ramas_protegidas: ['pre'] }));
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /switch -c|harness\.js rama/, `'pre' esta declarada sin escritura: ${r.stderr}`);
});

// Y no al reves: en una rama de trabajo, hablar de crear rama seria ruido — ya estas donde toca.
test('en una rama de trabajo el mensaje es el normal, sin hablar de crear rama', () => {
  const r = stopCheck(repo('docs/estado-inicial'));
  assert.strictEqual(r.status, 2, 'el bloqueo sigue: el fichero sigue suelto');
  assert.ok(!/switch -c/.test(r.stderr), `ya estas en rama de trabajo, sobra: ${r.stderr}`);
  assert.match(r.stderr, /commit del trabajo en curso|commit documental/i, r.stderr);
});

// La guarda que impide el bucle: si ya venimos de un bloqueo, no se repite.
test('con stop_hook_active no vuelve a bloquear (no se queda en bucle)', () => {
  const dir = repo('develop');
  const r = spawnSync(process.execPath, [HARNESS, 'stop-check'], {
    cwd: dir, encoding: 'utf8', timeout: 60000, input: '{"stop_hook_active":true}',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  assert.strictEqual(r.status, 0, `no puede bloquear dos veces seguidas:\n${r.stderr}`);
});
