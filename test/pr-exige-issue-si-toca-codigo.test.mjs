// El gate de "falta issue" vive al abrir el PR, que es cuando HAY DIFF que mirar.
//
// Al crear la rama solo se sabe el prefijo, y el prefijo miente: un 'chore/' puede acabar tocando
// src/ (y entonces es trabajo), y un 'docs/' puede ser solo un informe de cierre de fase (y entonces
// no lo es). Lo que decide no es como se llamo la rama, sino QUE cambia.
//
// Regla: si el diff toca CODIGO o documentos controlados, la rama necesita issue. Si solo toca
// artefactos de GESTION (gestion/, CHANGELOG.md, ESTADO.md, la version), es cierre de ciclo y no.
//
// Los tests usan un repo git REAL en disco: git() es interna al modulo (no se inyecta por ctx), asi
// que la unica forma honesta de probar esto es con commits de verdad.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${n}-`));
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', timeout: 60000 });

// Crea un repo con 'develop' y una rama de trabajo que toca exactamente los ficheros dados.
function repoConCambios(nombre, ficheros) {
  const dir = tmp(nombre);
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'base.txt'), 'x');
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'base');
  git(dir, 'switch', '-c', 'develop');
  git(dir, 'switch', '-c', 'rama/de-prueba');
  for (const f of ficheros) {
    const p = path.join(dir, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'contenido\n');
  }
  if (ficheros.length) { git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'cambios'); }
  return dir;
}
async function cargar(root) {
  const mod = await import(`file://${path.join(HOOKS, 'lib', 'git.js').replace(/\\/g, '/')}`);
  return mod.default({ ROOT: root, fs, path });
}

test('solo gestion (archivar un cambio): NO exige issue — es cierre de ciclo', async () => {
  const dir = repoConCambios('solo-gestion', [
    'gestion/cambios/changes/archive/mi-cambio/proposal.md',
    'gestion/cambios/specs/capacidad/spec.md',
  ]);
  const g = await cargar(dir);
  assert.strictEqual(g.ramaEsSoloGestion('develop'), true);
});

test('solo version + changelog (publicar): NO exige issue', async () => {
  const dir = repoConCambios('solo-version', ['CHANGELOG.md', 'package.json']);
  const g = await cargar(dir);
  assert.strictEqual(g.ramaEsSoloGestion('develop'), true);
});

test('solo ESTADO.md (cerrar fase tras aprobar): NO exige issue', async () => {
  const dir = repoConCambios('solo-estado', ['ESTADO.md']);
  const g = await cargar(dir);
  assert.strictEqual(g.ramaEsSoloGestion('develop'), true);
});

test('toca src/: SI exige issue, aunque el resto sea gestion', async () => {
  const dir = repoConCambios('toca-src', ['gestion/risks.md', 'src/api/handler.js']);
  const g = await cargar(dir);
  assert.strictEqual(g.ramaEsSoloGestion('develop'), false, 'un solo fichero de codigo ya lo convierte en trabajo');
});

test('toca documentos/ (entregable controlado): SI exige issue', async () => {
  const dir = repoConCambios('toca-docs', ['documentos/funcional/PRU-FUN-001-algo.md']);
  const g = await cargar(dir);
  assert.strictEqual(g.ramaEsSoloGestion('develop'), false, 'un entregable es trabajo, no cierre de ciclo');
});

test('toca los hooks del motor: SI exige issue (es codigo, aunque viva fuera de src/)', async () => {
  const dir = repoConCambios('toca-hooks', ['plugins/faro/hooks/harness.js']);
  const g = await cargar(dir);
  assert.strictEqual(g.ramaEsSoloGestion('develop'), false);
});

test('toca tests: SI exige issue (es trabajo verificable, no gestion)', async () => {
  const dir = repoConCambios('toca-tests', ['test/algo.test.mjs']);
  const g = await cargar(dir);
  assert.strictEqual(g.ramaEsSoloGestion('develop'), false);
});

test('rama sin cambios frente a la base: no se afirma que sea gestion (no hay evidencia)', async () => {
  const dir = repoConCambios('sin-cambios', []);
  const g = await cargar(dir);
  assert.strictEqual(g.ramaEsSoloGestion('develop'), false, 'sin diff no se concluye nada: no se exime');
});

// ---------- que este ENCHUFADA ----------
//
// Durante varias versiones 'ramaEsSoloGestion' existio, estaba bien hecha y tenia 8 tests en verde
// ... y NADIE la llamaba. Una regla que nadie aplica no es una regla: es codigo que promete algo y
// no lo cumple, y los tests verdes lo tapan. Estos dos tests miran el CABLEADO, no la logica.
test('el harness la importa de git.js (sin el destructuring seria ReferenceError en ejecucion)', () => {
  const src = fs.readFileSync(path.join(HOOKS, 'harness.js'), 'utf8');
  const linea = src.split('\n').find((l) => l.includes('} = _gitlib'));
  assert.ok(linea, 'no encuentro el destructuring de git.js en el harness');
  assert.match(linea, /ramaEsSoloGestion/,
    'usarla sin importarla da ReferenceError, y eso no lo ve ningun "node -c": solo salta al ejecutar');
});

// Desde 0.55.1 (#71) no es un aviso: 'pr crear' se NIEGA si el cambio toca trabajo y la peticion no
// esta anclada a una tarea. La regla vive en harness.js (comun a GitHub y GitLab), ANTES de publicar
// la rama: no se sube algo a lo que luego se le niega la peticion.
const HARNESS = path.join(HOOKS, 'harness.js');
const prCrear = (dir, ...extra) => spawnSync(process.execPath, [HARNESS, 'pr', 'crear', '--titulo', 'cambio', ...extra], {
  cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
});
function conRemotoFicticio(dir) { git(dir, 'remote', 'add', 'origin', 'https://github.com/org-ficticia/repo-ficticio.git'); return dir; }

test('pr crear con codigo y SIN tarea: se niega, y no publica la rama', () => {
  const dir = conRemotoFicticio(repoConCambios('pr-sin-tarea', ['src/app.js']));
  const r = prCrear(dir);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /No abro la peticion/);
  assert.match(r.stdout, /asignar-tarea/);
  assert.doesNotMatch(r.stdout, /publicada en origin/, 'se niega ANTES de publicar');
});

test('pr crear: una mencion suelta (#5) no ancla — solo el numero de la rama o Closes #N', () => {
  const dir = conRemotoFicticio(repoConCambios('pr-mencion', ['src/app.js']));
  const r = prCrear(dir, '--cuerpo', 'relacionado con #5');
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stdout, /No abro la peticion/);
});

test('la regla vive en pr crear (comun a las forjas) y usa la MISMA referencia que el reconciliador', () => {
  const harness = fs.readFileSync(HARNESS, 'utf8');
  const ini = harness.indexOf('async function cmdPrCrear');
  const cuerpo = harness.slice(ini, harness.indexOf('\n}', ini));
  assert.match(cuerpo, /ramaEsSoloGestion/);
  assert.match(cuerpo, /issuesDePr/);
  assert.ok(cuerpo.indexOf('issuesDePr') < cuerpo.indexOf('publicarRamaSiHaceFalta'), 'se comprueba antes de publicar');
});
