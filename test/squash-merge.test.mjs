// Test de deteccion de ramas integradas por SQUASH MERGE (0.9.6): 'git branch --merged' compara
// por ANCESTRO de commit — un squash merge (GitHub "Squash and merge") crea un commit NUEVO en
// develop con hash distinto a todos los de la rama, asi que ningun commit de la rama es ancestro
// de develop y --merged la sigue listando como "sin integrar" aunque su contenido ya este alli.
// Caso real reportado: PR #46 (feat/add-data-detail -> develop) squasheado en 18 -> 1 commit
// (98475bb); el harness seguia avisando "features sin integrar en develop".
// git cherry NO sirve para ramas de MULTIPLES commits (compara patch a patch, no el diff
// acumulado) — la deteccion correcta compara el diff TOTAL de la rama desde su merge-base contra
// el diff que ese mismo tramo introdujo en develop.
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

function repoConFeatureSquasheada(name, { commitsEnFeature = 18 } = {}) {
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
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'base');
  git(dir, 'switch', '-c', 'develop');
  git(dir, 'switch', '-c', 'feat/add-data-detail');
  for (let i = 1; i <= commitsEnFeature; i++) {
    fs.appendFileSync(path.join(dir, 'a.txt'), `linea ${i}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', `commit ${i} de ${commitsEnFeature}`);
  }
  git(dir, 'switch', 'develop');
  // Simula EXACTAMENTE lo que hace GitHub "Squash and merge": un commit nuevo con el diff
  // acumulado, hash distinto a todos los de la rama.
  git(dir, 'merge', '--squash', 'feat/add-data-detail');
  git(dir, 'commit', '-m', 'feat(detalle-incidente): parametros tecnicos del bloque Analisis (#46)');
  return dir;
}

// Las listas de features integradas / sin integrar viven en el bloque COMPLETO ('status' /
// 'harness.js estado'): el arranque de sesion es un indice y no las repite (#127).
test('gitFlow: rama con 18 commits SQUASHEADA a develop NO aparece como "sin integrar" (caso real PR #46)', () => {
  const dir = repoConFeatureSquasheada('squash-18-commits');
  const r = run(['status'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!/Features SIN integrar en develop:.*add-data-detail/.test(r.stdout), `sigue listando la rama squasheada como sin integrar: ${r.stdout.slice(0, 800)}`);
  assert.ok(/ya integradas.*add-data-detail|add-data-detail.*ya integrada/i.test(r.stdout), `no la reconoce como YA integrada: ${r.stdout.slice(0, 800)}`);
});

test('gitFlow: rama con 1 solo commit squasheada tampoco aparece como "sin integrar" (caso simple)', () => {
  const dir = repoConFeatureSquasheada('squash-1-commit', { commitsEnFeature: 1 });
  const r = run(['status'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!/Features SIN integrar en develop:.*add-data-detail/.test(r.stdout), `sigue listando la rama squasheada como sin integrar: ${r.stdout.slice(0, 800)}`);
});

test('gitFlow: rama de trabajo REALMENTE sin integrar SIGUE apareciendo (no romper el caso normal)', () => {
  const dir = tmp('squash-negativo');
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), '---\niniciativa: Test\nfases_total: 1\nfase_actual: 1\nowner: t\n---\n### Fase 1 · Piloto — in_progress\n- [ ] tarea\n');
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'base');
  git(dir, 'switch', '-c', 'develop');
  git(dir, 'switch', '-c', 'feat/sin-integrar');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'contenido nunca integrado\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'commit que NO se ha integrado en develop');
  git(dir, 'switch', 'develop');
  const r = run(['status'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/Features SIN integrar en develop:.*sin-integrar/.test(r.stdout), `una rama REALMENTE sin integrar deberia seguir avisando: ${r.stdout.slice(0, 800)}`);
});

test('gitFlow: rama squasheada Y con develop avanzado DESPUES por otro commit tambien se detecta integrada', () => {
  const dir = repoConFeatureSquasheada('squash-develop-avanzo', { commitsEnFeature: 3 });
  fs.writeFileSync(path.join(dir, 'c.txt'), 'otro cambio en develop tras el squash\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'otro commit en develop despues del squash');
  const r = run(['status'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!/Features SIN integrar en develop:.*add-data-detail/.test(r.stdout), `sigue listando la rama squasheada como sin integrar tras avanzar develop: ${r.stdout.slice(0, 800)}`);
});

// --- lib/ramas.js (mismo bug, ya distinguia 'squash' pero con diff acumulado que fallaba si la
// base avanzaba DESPUES del squash con commits ajenos a la rama) ---

const RAMAS = path.join(HOOKS, 'lib', 'ramas.js');
const runRamas = (dir, ...args) => spawnSync(process.execPath, [RAMAS, ...args], { cwd: dir, encoding: 'utf8', timeout: 120000 });

test('ramas.js: rama squasheada CON la base avanzada despues se clasifica [squash], no VIVA', () => {
  const dir = repoConFeatureSquasheada('ramas-squash-base-avanzo', { commitsEnFeature: 3 });
  fs.writeFileSync(path.join(dir, 'c.txt'), 'otro cambio en develop tras el squash\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'otro commit en develop despues del squash');
  const r = runRamas(dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/add-data-detail.*\[squash\/rebase/.test(r.stdout), `no la clasifica como squash/rebase integrada: ${r.stdout}`);
  assert.ok(!/VIVAS[\s\S]*add-data-detail/.test(r.stdout), `la deja como VIVA (falso positivo de trabajo pendiente): ${r.stdout}`);
});
