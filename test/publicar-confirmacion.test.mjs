// Test de confirmacion explicita en 'harness.js publicar' (0.9.5): el comentario del propio codigo
// decia "invocarlo ES tu aprobacion" — un agente con rol de maintainer podia mergear a main sin que
// el USUARIO hubiera confirmado en esa conversacion (el unico gate era el rol de GitHub, no la
// confirmacion humana). Ahora 'aprobar' SIN --confirmo solo MUESTRA que se aprobaria y no ejecuta
// el merge; la skill /faro:publicar pasa --confirmo tras el AskUserQuestion.
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

function repoConDevelopPorDelante(name) {
  const dir = tmp(name);
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), '---\niniciativa: Test\nfases_total: 1\nfase_actual: 1\nowner: t\n---\n### Fase 1 · Piloto — in_progress\n- [ ] tarea\n');
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  // La firma de commits heredada de la config global (gpg/1Password/ssh-sign) puede fallar o
  // pedir interaccion y dejar el repo de prueba SIN COMMITS: entonces el harness no tiene nada
  // que gobernar y el test falla por el entorno. Se apaga solo aqui, no en la config del usuario.
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  git(dir, 'remote', 'add', 'origin', 'https://github.com/faro-test/repo-inexistente.git');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'base');
  git(dir, 'switch', '-c', 'develop');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'cambio pendiente de aprobar');
  return dir;
}

// NOTA: 'harness.js publicar' valida el ROL vía API de GitHub ANTES de llegar al gate de
// confirmación — sin un token/remoto real no hay forma de hacer que 'roleInfo()' devuelva
// puedeAprobar:true en un test aislado. Estos dos tests cubren igualmente la propiedad que
// importa (nunca se mergea sin permiso), y el propio codigo fuente se audita mas abajo para
// la propiedad que SI es puramente local: sin --confirmo, el flujo nunca llega al merge.

test('aprobar SIN --confirmo: nunca avanza main (bloqueado por rol o por el gate de confirmacion)', () => {
  const dir = repoConDevelopPorDelante('aprobar-sin-confirmo');
  const before = (git(dir, 'rev-parse', 'main').stdout || '').trim();
  const r = run(['publicar'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  const after = (git(dir, 'rev-parse', 'main').stdout || '').trim();
  assert.strictEqual(before, after, `main avanzo sin --confirmo: ${r.stdout}`);
});

test('aprobar con argumento distinto de --confirmo tampoco ejecuta el merge (no basta con "cualquier flag")', () => {
  const dir = repoConDevelopPorDelante('aprobar-flag-erroneo');
  const before = (git(dir, 'rev-parse', 'main').stdout || '').trim();
  const r = run(['publicar', '--si'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  const after = (git(dir, 'rev-parse', 'main').stdout || '').trim();
  assert.strictEqual(before, after, `main avanzo con un flag que no es --confirmo: ${r.stdout}`);
});

test('fuente: cmdPublicar comprueba --confirmo ANTES de cualquier git switch/merge (orden estatico)', () => {
  const src = fs.readFileSync(HARNESS, 'utf8');
  const inicio = src.indexOf('async function cmdPublicar');
  assert.ok(inicio > 0, 'no encuentro cmdPublicar en harness.js');
  // Ventana amplia a proposito: lo que se comprueba es el ORDEN (confirmo antes que merge), no que
  // esten cerca. Con 6000 el test empezo a fallar solo por crecer cmdPublicar, sin que el gate se
  // hubiera movido — un falso positivo que habria hecho dudar de la seguridad en vez del test.
  const cuerpo = src.slice(inicio, inicio + 20000);
  const posConfirmado = cuerpo.indexOf('if (!confirmado)');
  // gitWrite = via de escritura con exit code real y timeout amplio (0.9.7); antes era git(...).
  const posMerge = cuerpo.indexOf("gitWrite('merge', '--no-ff', 'develop'");
  assert.ok(posConfirmado > 0, 'no encuentro el gate de confirmacion en cmdPublicar');
  assert.ok(posMerge > 0, 'no encuentro la llamada de merge en cmdPublicar');
  assert.ok(posConfirmado < posMerge, 'el gate de --confirmo debe ir ANTES del merge en el codigo fuente');
});
