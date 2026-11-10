// TRABAJO vs GESTION: no todo lo que pasa por una rama es trabajo que planificar.
//
// Archivar un cambio, bumpear la version o actualizar ESTADO.md tras aprobar son CIERRE DE CICLO:
// no son tareas nuevas, son el final de tareas que ya tuvieron su issue. Exigirles uno seria pedir
// una tarea para cerrar otra tarea — ruido que entrena a ignorar el aviso.
//
// El bloqueo de develop/main NO se toca: esto solo afecta al AVISO de "falta issue", no a por donde
// pasa el trabajo. Todo sigue yendo por rama + merge, tambien la gestion.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${n}-`));
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', timeout: 60000 });
const correr = (args, cwd) => spawnSync(process.execPath, [HARNESS, ...args], { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: cwd } });

const ESTADO = `---
nombre: proyecto
clave: PRU
objetivo: Prueba
estado: in_progress
fases_total: 1
fase_actual: 1
owner: tester
---
### Fase 1 · Fundamentos — in_progress
- [ ] algo
`;

function repo(nombre) {
  const dir = tmp(nombre);
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), ESTADO);
  fs.writeFileSync(path.join(dir, 'a.txt'), '1');
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'base');
  git(dir, 'switch', '-c', 'develop');
  return dir;
}

test('rama chore: NO pide issue — es cierre de ciclo, no trabajo que planificar', () => {
  const dir = repo('chore-sin-issue');
  const r = correr(['rama', 'chore', 'archivar el cambio ya implementado'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /NO tiene tarea asociada/, `archivar no necesita un issue propio:\n${r.stdout}`);
});

test('rama chore: dice POR QUE no lo pide, para que no parezca un olvido del harness', () => {
  const dir = repo('chore-explica');
  const r = correr(['rama', 'chore', 'bump de version'], dir);
  assert.match(r.stdout, /gesti|cierre de ciclo|no (es )?trabajo/i, `debe explicarse:\n${r.stdout}`);
});

// BLOQUEO, no aviso: una rama solo existe si hay un issue detras. Primero se PIDE algo (el issue,
// que define que se quiere y en que fase entra) y luego se abre la rama para atenderlo — asi nada
// se trabaja fuera del sistema, y la rama nace ya con su numero en el nombre.
test('rama feat SIN issue: se BLOQUEA (no se crea la rama)', () => {
  const dir = repo('feat-bloquea');
  const r = correr(['rama', 'feat', 'exportar informes'], dir);
  assert.notStrictEqual(r.status, 0, `debe fallar:\n${r.stdout}${r.stderr}`);
  const ramas = git(dir, 'branch', '--format=%(refname:short)').stdout;
  assert.doesNotMatch(ramas, /feat\/exportar-informes/, 'la rama NO debe haberse creado');
});

test('rama feat SIN issue: el mensaje da el comando exacto para crear la tarea', () => {
  const dir = repo('feat-bloquea-comando');
  const r = correr(['rama', 'feat', 'exportar informes'], dir);
  const todo = `${r.stdout}${r.stderr}`;
  assert.match(todo, /asignar-tarea/, todo);
  assert.match(todo, /--tipo requerimiento/, 'con el tipo que corresponde al prefijo');
  assert.match(todo, /--hito 1\b/, 'y la fase activa');
  assert.match(todo, /--issue/, 'y como relanzar la rama una vez creada la tarea');
});

test('rama fix SIN issue: tambien se bloquea (un bug es trabajo, aunque sea corto)', () => {
  const dir = repo('fix-bloquea');
  const r = correr(['rama', 'fix', 'el login falla'], dir);
  assert.notStrictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
});

test('rama docs SIN issue: tambien se bloquea (documentar es trabajo planificable)', () => {
  const dir = repo('docs-bloquea');
  const r = correr(['rama', 'docs', 'guia de despliegue'], dir);
  assert.notStrictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
});

test('rama feat CON issue: se crea sin problema', () => {
  const dir = repo('feat-con-issue-ok');
  const r = correr(['rama', 'feat', 'exportar informes', '--issue', '42'], dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').stdout, /feat\/42-exportar-informes/);
});

test('sin ESTADO.md (repo nivel 0): NO se bloquea — no hay fases a las que anclar una tarea', () => {
  const dir = tmp('nivel-0');
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1');
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'base');
  git(dir, 'switch', '-c', 'develop');
  const r = correr(['rama', 'feat', 'algo'], dir);
  assert.strictEqual(r.status, 0, `un repo sin faseo no puede cumplir la regla:\n${r.stdout}${r.stderr}`);
});

test('rama chore --issue: si alguien SI le pone issue, se respeta y se ancla igual', () => {
  const dir = repo('chore-con-issue');
  const r = correr(['rama', 'chore', 'algo', '--issue', '42'], dir);
  assert.match(r.stdout, /#42/, r.stdout);
  assert.match(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').stdout, /42/);
});

test('el bloqueo de develop NO se toca: sigue sin poder trabajarse ahi', () => {
  const dir = repo('develop-sigue-bloqueada');
  // 'rama' desde develop crea una rama nueva; lo que se comprueba es que develop siga protegida
  // para escritura directa (el gate de pre-doc/pre-bash), no que 'rama' falle.
  const r = spawnSync(process.execPath, [HARNESS, 'pre-doc'], {
    cwd: dir, encoding: 'utf8', timeout: 60000,
    input: JSON.stringify({ tool_input: { file_path: path.join(dir, 'gestion', 'x.md') } }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  const todo = `${r.stdout}${r.stderr}`;
  assert.match(todo, /develop|rama de trabajo|no se trabaja/i, `develop debe seguir protegida:\n${todo}`);
});
