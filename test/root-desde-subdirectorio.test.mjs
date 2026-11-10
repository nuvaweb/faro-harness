// ROOT desde un SUBDIRECTORIO: el harness debe gobernar el repo, no el directorio donde se teclea.
//
// Bug real: ROOT = CLAUDE_PROJECT_DIR || process.cwd(). Sin esa variable de entorno (invocacion
// manual desde una terminal, un hook que no la propaga, un script), trabajar desde src/ hacia que
// el harness buscase ESTADO.md en src/ y no lo encontrase -> reportaba 'fases: []' y todo a null
// con un ESTADO.md perfectamente valido en la raiz. Silencioso y confuso: el faseo, validate y el
// gobierno entero quedaban ciegos sin que nada dijera por que.
//
// Regla: si no hay CLAUDE_PROJECT_DIR, se sube hasta la raiz del repo git (la que tiene .git), que
// es donde vive ESTADO.md por convencion FARO. Si no hay repo git, se cae a cwd (comportamiento
// previo, para no romper usos fuera de un repo).
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
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000 });

// Sin CLAUDE_PROJECT_DIR a proposito: es justo el caso que fallaba.
function correr(args, cwd) {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  return spawnSync(process.execPath, [HARNESS, ...args], { cwd, encoding: 'utf8', timeout: 120000, env });
}

const ESTADO = `---
nombre: proyecto
clave: PRU
objetivo: Prueba
estado: in_progress
fases_total: 2
fase_actual: 1
owner: tester
---
### Fase 1 · Fundamentos — in_progress
- [ ] una tarea

### Fase 2 · Cierre — pending
- [ ] otra tarea
`;

function repoConSubdirectorio(nombre) {
  const dir = tmp(nombre);
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), ESTADO);
  const sub = path.join(dir, 'src', 'anidado');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'x.txt'), 'x');
  return { dir, sub };
}

test('estado-json desde la RAIZ: lee las fases (caso que ya funcionaba)', () => {
  const { dir } = repoConSubdirectorio('root-raiz');
  const r = correr(['estado-json'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.fases.length, 2, r.stdout);
  assert.strictEqual(j.nombre, 'proyecto');
});

test('estado-json desde un SUBDIRECTORIO sin CLAUDE_PROJECT_DIR: sigue leyendo el ESTADO.md de la raiz', () => {
  const { sub } = repoConSubdirectorio('root-sub');
  const r = correr(['estado-json'], sub);
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.fases.length, 2, `desde src/anidado deberia ver las 2 fases de la raiz:\n${r.stdout}`);
  assert.strictEqual(j.nombre, 'proyecto');
});

test('CLAUDE_PROJECT_DIR sigue MANDANDO cuando esta puesta (no se pisa con la raiz git)', () => {
  const { dir, sub } = repoConSubdirectorio('root-env');
  const r = spawnSync(process.execPath, [HARNESS, 'estado-json'], {
    cwd: sub, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.fases.length, 2);
});

test('fuera de un repo git: cae a cwd sin reventar (comportamiento previo intacto)', () => {
  const dir = tmp('root-sin-git');   // sin git init
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), ESTADO);
  const r = correr(['estado-json'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.fases.length, 2, r.stdout);
});
