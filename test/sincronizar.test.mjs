// Tests de `harness.js sincronizar` (0.30.0) — pone el LOCAL al dia con el remoto con criterio.
//
// El motor sabia comparar ramas (gitFlow/ramas.js) pero SIEMPRE contra refs locales cacheadas: sin
// un `fetch` previo, sus respuestas pueden estar obsoletas ("estas al dia" cuando llevas 12 commits
// de retraso). Y no habia NINGUN comando que trajera el estado del remoto: las unicas menciones a
// `git fetch` en el motor eran mensajes que mandaban al usuario a hacerlo A MANO.
//
// FRONTERA DE SEGURIDAD (el corazon de este comando): solo se aplica lo que NO puede perder trabajo
//   - fetch: SIEMPRE (solo trae informacion, no toca el arbol)
//   - fast-forward: solo si el arbol esta LIMPIO y la rama NO ha divergido (solo avanza el puntero)
//   - merge/rebase/conflictos: NUNCA se aplican solos — se PROPONEN
// La deteccion de conflictos es EN SECO (merge-tree): dice que chocaria sin tocar el arbol, que es
// lo que permite responder "¿mi rama choca con develop?" ANTES de abrir la peticion de integracion.
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
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120000 });
const run = (args, cwd) =>
  spawnSync(process.execPath, [HARNESS, ...args], {
    cwd, encoding: 'utf8', timeout: 120000, env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });

const commit = (dir, file, texto, msg) => {
  fs.appendFileSync(path.join(dir, file), `${texto}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', msg);
};

// Un remoto de VERDAD (bare local): `fetch` se ejerce igual que contra GitHub/GitLab, sin red.
function repoConRemoto(name) {
  const bare = tmp(`${name}-remoto`);
  git(bare, 'init', '--bare', '-b', 'main');

  const dir = tmp(name);
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  // Misma razon que en squash-merge.test.mjs: la firma heredada de la config global puede colgar
  // o fallar y dejar el repo de prueba sin commits.
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), '---\niniciativa: Test\nfases_total: 1\nfase_actual: 1\nowner: t\n---\n### Fase 1 · Piloto — in_progress\n- [ ] tarea\n');
  commit(dir, 'base.txt', 'base', 'base');
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-u', 'origin', 'main');
  git(dir, 'switch', '-c', 'develop');
  git(dir, 'push', '-u', 'origin', 'develop');
  return { dir, bare };
}

// Simula que OTRA persona empujo trabajo al remoto: se clona aparte, se commitea y se sube.
function otroEmpuja(bare, rama, file, texto, msg) {
  const otro = tmp('otro');
  git(otro, 'clone', bare, '.');
  git(otro, 'config', 'user.email', 'o@o');
  git(otro, 'config', 'user.name', 'O');
  git(otro, 'config', 'commit.gpgsign', 'false');
  git(otro, 'switch', rama);
  commit(otro, file, texto, msg);
  git(otro, 'push', 'origin', rama);
  return otro;
}

test('sincronizar: trae del remoto lo que no tenias (fetch real, no solo refs cacheadas)', () => {
  const { dir, bare } = repoConRemoto('sync-fetch');
  otroEmpuja(bare, 'develop', 'de-otro.txt', 'trabajo ajeno', 'feat: trabajo de otra persona');

  // Antes de sincronizar el local NO conoce ese commit: es justo el punto ciego que se corrige.
  const antes = git(dir, 'rev-list', '--count', 'develop..origin/develop').stdout.trim();
  assert.strictEqual(antes, '0', 'el repo de prueba deberia empezar sin conocer el commit ajeno');

  const r = run(['sincronizar'], dir);
  assert.strictEqual(r.status, 0, r.stderr);

  const despues = git(dir, 'rev-list', '--count', 'origin/develop').stdout.trim();
  assert.strictEqual(despues, '2', `tras sincronizar, origin/develop deberia tener el commit ajeno:\n${r.stdout}`);
});

test('sincronizar: hace fast-forward de develop cuando el arbol esta limpio (accion SEGURA)', () => {
  const { dir, bare } = repoConRemoto('sync-ff');
  otroEmpuja(bare, 'develop', 'de-otro.txt', 'trabajo ajeno', 'feat: trabajo de otra persona');

  const r = run(['sincronizar'], dir);
  assert.strictEqual(r.status, 0, r.stderr);

  // El puntero LOCAL de develop avanzo: el usuario ya tiene el trabajo, sin pedirselo.
  const pendiente = git(dir, 'rev-list', '--count', 'develop..origin/develop').stdout.trim();
  assert.strictEqual(pendiente, '0', `develop local deberia haber avanzado por fast-forward:\n${r.stdout}`);
  assert.ok(fs.existsSync(path.join(dir, 'de-otro.txt')), 'el fichero del otro deberia estar ya en el arbol');
  assert.ok(/al d[ií]a|avanzad|fast-forward|traj/i.test(r.stdout), `deberia informar de lo que hizo:\n${r.stdout}`);
});

test('sincronizar: con cambios SIN COMMITEAR no toca nada (no puede perder trabajo)', () => {
  const { dir, bare } = repoConRemoto('sync-sucio');
  otroEmpuja(bare, 'develop', 'de-otro.txt', 'trabajo ajeno', 'feat: trabajo de otra persona');

  // Trabajo vivo sin commitear: mover el puntero aqui es exactamente lo que NO debe pasar.
  fs.writeFileSync(path.join(dir, 'borrador.txt'), 'trabajo a medias sin commitear\n');

  const antes = git(dir, 'rev-parse', 'develop').stdout.trim();
  const r = run(['sincronizar'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  const despues = git(dir, 'rev-parse', 'develop').stdout.trim();

  assert.strictEqual(despues, antes, `con el arbol sucio NO debe mover develop:\n${r.stdout}`);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'borrador.txt'), 'utf8'), 'trabajo a medias sin commitear\n');
  assert.ok(/sin commitear|sin guardar|pendiente/i.test(r.stdout), `deberia explicar POR QUE no actuo:\n${r.stdout}`);
});

test('sincronizar: rama DIVERGIDA no se toca sola — se propone (no es fast-forward)', () => {
  const { dir, bare } = repoConRemoto('sync-diverge');
  otroEmpuja(bare, 'develop', 'de-otro.txt', 'ajeno', 'feat: de otra persona');
  // Yo tambien commiteo en MI develop: ya no es fast-forward, hay que fusionar -> decision del usuario.
  commit(dir, 'mio.txt', 'mi trabajo', 'feat: lo mio');

  const antes = git(dir, 'rev-parse', 'develop').stdout.trim();
  const r = run(['sincronizar'], dir);
  assert.strictEqual(r.status, 0, r.stderr);

  assert.strictEqual(git(dir, 'rev-parse', 'develop').stdout.trim(), antes, `una rama divergida NO se fusiona sola:\n${r.stdout}`);
  assert.ok(/diverg|ambas direcciones|tuyo.*sin subir|sin subir/i.test(r.stdout), `deberia avisar de la divergencia:\n${r.stdout}`);
});

test('sincronizar: detecta EN SECO que la rama de trabajo chocaria con develop (antes del PR)', () => {
  const { dir, bare } = repoConRemoto('sync-conflicto');
  // Los dos tocan LA MISMA linea del MISMO fichero -> conflicto real al integrar.
  git(dir, 'switch', 'develop');
  commit(dir, 'compartido.txt', 'version original', 'base compartida');
  git(dir, 'push', 'origin', 'develop');

  git(dir, 'switch', '-c', 'feat/mi-cosa');
  fs.writeFileSync(path.join(dir, 'compartido.txt'), 'MI version\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'feat: mi cambio');

  const otro = otroEmpuja(bare, 'develop', 'x.txt', 'x', 'placeholder');
  fs.writeFileSync(path.join(otro, 'compartido.txt'), 'SU version\n');
  git(otro, 'add', '-A');
  git(otro, 'commit', '-m', 'feat: su cambio');
  git(otro, 'push', 'origin', 'develop');

  const r = run(['sincronizar'], dir);
  assert.strictEqual(r.status, 0, r.stderr);

  assert.ok(/conflicto|chocar/i.test(r.stdout), `deberia avisar del conflicto ANTES de integrar:\n${r.stdout}`);
  assert.ok(/compartido\.txt/.test(r.stdout), `deberia nombrar el fichero que choca:\n${r.stdout}`);
  // Y sobre todo: haberlo averiguado SIN dejar el repo en estado de conflicto.
  assert.strictEqual(git(dir, 'status', '--porcelain').stdout.trim(), '', `la deteccion debe ser EN SECO, sin ensuciar el arbol:\n${r.stdout}`);
  assert.ok(!fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD')), 'no debe quedar un merge a medias');
});

test('sincronizar: rama de trabajo LIMPIA frente a develop se reporta como integrable', () => {
  const { dir, bare } = repoConRemoto('sync-limpio');
  git(dir, 'switch', '-c', 'feat/sin-choque');
  commit(dir, 'solo-mio.txt', 'solo yo toco esto', 'feat: fichero propio');
  otroEmpuja(bare, 'develop', 'solo-suyo.txt', 'solo el toca esto', 'feat: fichero ajeno');

  const r = run(['sincronizar'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/limpio|sin conflicto|no chocan|integrab/i.test(r.stdout), `deberia decir que NO hay conflicto:\n${r.stdout}`);
});

test('sincronizar: sin remoto configurado informa con criterio en vez de reventar', () => {
  const dir = tmp('sync-sin-remoto');
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  commit(dir, 'a.txt', 'a', 'base');

  const r = run(['sincronizar'], dir);
  assert.strictEqual(r.status, 0, `sin remoto NO es un error del usuario: ${r.stderr}`);
  assert.ok(/sin remoto|no hay remoto|origin/i.test(r.stdout), `deberia explicarlo en llano:\n${r.stdout}`);
});

test('sincronizar --json: salida legible por maquina para el resumen de sesion', () => {
  const { dir, bare } = repoConRemoto('sync-json');
  otroEmpuja(bare, 'develop', 'de-otro.txt', 'ajeno', 'feat: de otra persona');

  const r = run(['sincronizar', '--json'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(typeof j.ramas, 'object', `--json debe traer el estado por rama: ${r.stdout}`);
  assert.strictEqual(typeof j.acciones, 'object', `--json debe traer lo que HIZO: ${r.stdout}`);
});

test('sincronizar --solo-informe: NO toca el repo aunque el fast-forward sea seguro', () => {
  const { dir, bare } = repoConRemoto('sync-dry');
  otroEmpuja(bare, 'develop', 'de-otro.txt', 'ajeno', 'feat: de otra persona');

  const antes = git(dir, 'rev-parse', 'develop').stdout.trim();
  const r = run(['sincronizar', '--solo-informe'], dir);
  assert.strictEqual(r.status, 0, r.stderr);

  assert.strictEqual(git(dir, 'rev-parse', 'develop').stdout.trim(), antes, `--solo-informe no debe mover nada:\n${r.stdout}`);
  // Pero SI debe haber traido la informacion (fetch es inofensivo) para poder informar de verdad.
  assert.strictEqual(git(dir, 'rev-list', '--count', 'origin/develop').stdout.trim(), '2', 'aun asi debe hacer fetch: informar exige datos frescos');
});
