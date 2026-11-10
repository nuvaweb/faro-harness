// 'rama' ACOMPAÑA al desarrollador: le dice donde esta y que hace falta, en vez de crear la rama
// en silencio y dejar el trabajo fuera del sistema.
//
// Regla de fondo: ninguna rama nace suelta — nace de un issue, y todo issue cuelga de un hito.
// Pero el harness no bloquea al crear (bloquear ahi hace que la gente trabaje fuera del sistema):
// crea la rama, dice que falta el issue, y da el comando exacto para crearlo con su tipo y su fase.
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
fases_total: 2
fase_actual: 1
owner: tester
---
### Fase 1 · Fundamentos — in_progress
- [ ] algo

### Fase 2 · Construccion — pending
- [ ] otra cosa
`;

function repo(nombre, conEstado = true) {
  const dir = tmp(nombre);
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  if (conEstado) fs.writeFileSync(path.join(dir, 'ESTADO.md'), ESTADO);
  fs.writeFileSync(path.join(dir, 'a.txt'), '1');
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'base');
  git(dir, 'switch', '-c', 'develop');
  return dir;
}

// 0.36.0: se endurecio de aviso a BLOQUEO — una rama solo existe si hay un issue detras. Primero se
// define QUE se quiere (el issue, con su tipo y su fase) y luego se abre la rama para atenderlo.
test('rama sin issue: se BLOQUEA y la rama NO se crea', () => {
  const dir = repo('rama-bloquea');
  const r = correr(['rama', 'feat', 'colorear el boton de guardar'], dir);
  assert.notStrictEqual(r.status, 0, `debe fallar:\n${r.stdout}${r.stderr}`);
  const ramas = git(dir, 'branch', '--format=%(refname:short)').stdout;
  assert.doesNotMatch(ramas, /feat\/colorear/, 'la rama NO debe existir');
});

test('rama: da el COMANDO exacto para crear el issue, con el tipo que corresponde al prefijo', () => {
  const dir = repo('rama-comando');
  const r = correr(['rama', 'fix', 'el login no valida el email'], dir);
  assert.match(r.stdout, /asignar-tarea/, `debe dar el comando:\n${r.stdout}`);
  assert.match(r.stdout, /--tipo bug/, 'una rama fix/ corresponde a un issue de tipo bug');
  assert.match(r.stdout, /--hito/, 'y el issue debe colgar de una fase: todo issue lleva hito');
});

test('rama hotfix: es un bug Y urgente — el prefijo ya lo dice, no hay que acordarse de marcarlo', () => {
  const dir = repo('rama-hotfix');
  const r = correr(['rama', 'hotfix', 'caida en produccion'], dir);
  assert.match(r.stdout, /--tipo bug/, r.stdout);
  assert.match(r.stdout, /--extra urgente/, `un hotfix es urgente por definicion:\n${r.stdout}`);
});

test('rama fix: es un bug pero NO urgente (un fix normal no bloquea a nadie)', () => {
  const dir = repo('rama-fix-normal');
  const r = correr(['rama', 'fix', 'un texto mal escrito'], dir);
  assert.match(r.stdout, /--tipo bug/, r.stdout);
  assert.doesNotMatch(r.stdout, /--extra urgente/, 'no todo arreglo es una urgencia');
});

test('rama docs / spike / perf: cada prefijo propone SU tipo, no un cajon de sastre', () => {
  const casos = [['docs', /--tipo documentacion/], ['spike', /--tipo investigacion/], ['perf', /--tipo mejora/]];
  for (const [prefijo, esperado] of casos) {
    const dir = repo(`rama-tipo-${prefijo}`);
    const r = correr(['rama', prefijo, 'algo que hacer'], dir);
    assert.match(r.stdout, esperado, `rama ${prefijo}/ deberia proponer ese tipo:\n${r.stdout}`);
  }
});

test('rama feat: propone el tipo de PLAN que le toca, no "bug"', () => {
  const dir = repo('rama-feat-tipo');
  const r = correr(['rama', 'feat', 'exportar informes a pdf'], dir);
  assert.match(r.stdout, /--tipo (requerimiento|mejora)/, `una rama feat/ no es un bug:\n${r.stdout}`);
});

test('rama: sugiere la FASE ACTIVA por defecto (lo normal: se trabaja en la fase en curso)', () => {
  const dir = repo('rama-fase-activa');
  const r = correr(['rama', 'feat', 'algo nuevo'], dir);
  assert.match(r.stdout, /--hito 1\b/, `la fase 1 es la activa en ESTADO.md:\n${r.stdout}`);
});

test('rama: sin ESTADO.md (repo nivel 0) no inventa fases ni exige lo que no puede cumplirse', () => {
  const dir = repo('rama-sin-estado', false);
  const r = correr(['rama', 'feat', 'algo'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /--hito \d/, `sin faseo no se sugiere ninguna fase:\n${r.stdout}`);
});

test('rama --issue <N>: no avisa de nada, la rama ya nace anclada', () => {
  const dir = repo('rama-con-issue');
  const r = correr(['rama', 'feat', 'algo', '--issue', '42'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /FALTA|falta (el|la) (issue|tarea)/i, `con issue no hay nada que avisar:\n${r.stdout}`);
  assert.match(r.stdout, /#42/, 'debe dejar constancia del issue al que responde');
});

// Trabajo DUPLICADO: si el issue ya tiene una rama publicada, alguien esta (o estuvo) en ello. No se
// impide crear otra —puede ser legitimo— pero hay que decirlo ANTES de empezar, con quien y cuando.
// Lo que NO se puede saber es si alguien la tiene abierta AHORA sin haber subido nada: el trabajo
// local ajeno es invisible hasta que se publica.
test('rama --issue: avisa si ese issue YA tiene una rama publicada, con quien y cuando', () => {
  const dir = repo('rama-duplicada');
  const bare = tmp('rama-duplicada-remoto');
  git(bare, 'init', '--bare', '-b', 'main');
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-u', 'origin', 'develop');
  // Otra persona ya abrio la rama del issue 42 y la publico.
  git(dir, 'switch', '-c', 'feat/42-lo-que-sea');
  fs.writeFileSync(path.join(dir, 'suyo.txt'), '1');
  git(dir, 'add', '-A');
  spawnSync('git', ['-c', 'user.name=Maria', '-c', 'user.email=m@m', 'commit', '-m', 'feat: lo suyo'], { cwd: dir, encoding: 'utf8' });
  git(dir, 'push', '-u', 'origin', 'feat/42-lo-que-sea');
  git(dir, 'switch', 'develop');

  const r = correr(['rama', 'feat', 'otra cosa del mismo issue', '--issue', '42'], dir);
  assert.match(r.stdout, /42/, r.stdout);
  assert.match(r.stdout, /ya (tiene|existe)|Maria/i, `debe avisar de que ese issue ya tiene rama:\n${r.stdout}`);
});

test('rama --issue: si el issue NO tiene rama previa, no inventa avisos', () => {
  const dir = repo('rama-sin-duplicar');
  const bare = tmp('rama-sin-duplicar-remoto');
  git(bare, 'init', '--bare', '-b', 'main');
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-u', 'origin', 'develop');
  const r = correr(['rama', 'feat', 'algo nuevo', '--issue', '99'], dir);
  assert.doesNotMatch(r.stdout, /ya (tiene|existe) (una )?rama/i, r.stdout);
});

test('rama --issue: el nombre de la rama incluye el numero, para saber a que responde de un vistazo', () => {
  const dir = repo('rama-nombre-issue');
  correr(['rama', 'feat', 'exportar informes', '--issue', '42'], dir);
  const actual = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  assert.match(actual, /42/, `la rama deberia citar el issue: ${actual}`);
});
