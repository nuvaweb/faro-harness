// Test del resumen agregado de sesion (0.30.0): ramas vivas/muertas (reutiliza ramas.js --json) +
// tus issues abiertos (reutiliza gh_resumen ya cacheado), compuestos en ~/.faro.json bajo
// 'resumen_agregado[repoKey]' con el mismo patron de cache-y-refresco-en-background que gh_resumen.
// node --test marca NODE_TEST_CONTEXT -> credenciales.js usa un fichero temporal por proceso, nunca
// el ~/.faro.json real (ver lib/credenciales.js).
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { umbral, plazo, conReintento } from './lib-tiempo.mjs';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${name}-`));
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: plazo(120000) });

async function cargarAgregado(ROOT) {
  const mod = await import(pathToFileURL(path.join(HOOKS, 'lib', 'agregado.js')).href);
  return (mod.default || mod)({ ROOT });
}

async function cargarCred() {
  const mod = await import(pathToFileURL(path.join(HOOKS, 'lib', 'credenciales.js')).href);
  return (mod.default || mod)();
}

function repoConUnaMuertaYUnaViva(name) {
  const dir = tmp(name);
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'base');
  git(dir, 'switch', '-c', 'feat/muerta');
  fs.writeFileSync(path.join(dir, 'b.txt'), '1');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'feat: muerta');
  git(dir, 'switch', 'main');
  git(dir, 'merge', '--no-ff', 'feat/muerta', '-m', 'merge feat/muerta');
  git(dir, 'switch', '-c', 'feat/viva');
  fs.writeFileSync(path.join(dir, 'c.txt'), '1');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'feat: viva, sin integrar');
  git(dir, 'switch', 'main');
  return dir;
}

test('agregadoCache: null si nunca se ha refrescado', async () => {
  const dir = tmp('agregado-vacio');
  git(dir, 'init', '-b', 'main');
  const { agregadoCache, agregadoFresco } = await cargarAgregado(dir);
  assert.strictEqual(agregadoCache(), null);
  assert.strictEqual(agregadoFresco(Date.now()), false);
});

test('refrescarAgregado: cuenta ramas vivas/muertas reutilizando ramas.js', async () => {
  const dir = repoConUnaMuertaYUnaViva('agregado-ramas');
  const { refrescarAgregado, agregadoCache, agregadoFresco } = await cargarAgregado(dir);
  const now = Date.now();
  const snap = refrescarAgregado(now);
  assert.deepStrictEqual(snap.ramas, { vivas: 1, muertas: 1 });
  assert.strictEqual(agregadoCache().ramas.vivas, 1);
  assert.strictEqual(agregadoFresco(now), true);
  assert.strictEqual(agregadoFresco(now + 11 * 60000), false, 'a los 11 minutos ya deberia estar caducado (umbral 10)');
});

test('refrescarAgregado: compone tus_issues_abiertos desde gh_resumen ya cacheado, sin llamada de red propia', async () => {
  const dir = tmp('agregado-issues');
  git(dir, 'init', '-b', 'main');
  const cred = await cargarCred();
  const cfg = cred.leerCfg();
  cfg.gh_resumen = cfg.gh_resumen || {};
  // mis_tareas es un NUMERO (total_count de la busqueda de GitHub, ver github-tareas.js), no un array.
  cfg.gh_resumen[dir] = { mis_tareas: 2, prs_por_revisar: 0, ts: Date.now() };
  cred.escribirCfg(cfg);

  const { refrescarAgregado } = await cargarAgregado(dir);
  const snap = refrescarAgregado(Date.now());
  assert.strictEqual(snap.tus_issues_abiertos, 2);
});

test('refrescarAgregado: tus_issues_abiertos en 0 se conserva como 0, no como null (0 es un conteo valido)', async () => {
  const dir = tmp('agregado-issues-cero');
  git(dir, 'init', '-b', 'main');
  const cred = await cargarCred();
  const cfg = cred.leerCfg();
  cfg.gh_resumen = cfg.gh_resumen || {};
  cfg.gh_resumen[dir] = { mis_tareas: 0, ts: Date.now() };
  cred.escribirCfg(cfg);

  const { refrescarAgregado } = await cargarAgregado(dir);
  const snap = refrescarAgregado(Date.now());
  assert.strictEqual(snap.tus_issues_abiertos, 0);
});

test('refrescarAgregado: tus_issues_abiertos es null si no hay gh_resumen cacheado para este repo', async () => {
  const dir = tmp('agregado-sin-gh');
  git(dir, 'init', '-b', 'main');
  const { refrescarAgregado } = await cargarAgregado(dir);
  const snap = refrescarAgregado(Date.now());
  assert.strictEqual(snap.tus_issues_abiertos, null);
});

// plan_sin_hito / plan_sin_hito_estancadas: MISMO patron que tus_issues_abiertos — se componen desde
// gh_resumen ya cacheado (github-tareas.js:refrescarResumen los calcula con total_count), sin
// llamada de red propia de agregado.js. Es la vigilancia del anclaje al ciclo (0.31.1): cuantas
// tareas de PLAN quedaron sin fase, y cuantas de esas llevan >30 dias sin tocar.
test('refrescarAgregado: compone plan_sin_hito y sus estancadas desde gh_resumen ya cacheado', async () => {
  const dir = tmp('agregado-plan-sin-hito');
  git(dir, 'init', '-b', 'main');
  const cred = await cargarCred();
  const cfg = cred.leerCfg();
  cfg.gh_resumen = cfg.gh_resumen || {};
  cfg.gh_resumen[dir] = { mis_tareas: 2, plan_sin_hito: 5, plan_sin_hito_estancadas: 2, ts: Date.now() };
  cred.escribirCfg(cfg);

  const { refrescarAgregado } = await cargarAgregado(dir);
  const snap = refrescarAgregado(Date.now());
  assert.strictEqual(snap.plan_sin_hito, 5);
  assert.strictEqual(snap.plan_sin_hito_estancadas, 2);
});

test('refrescarAgregado: plan_sin_hito en 0 se conserva como 0 (0 es un conteo valido, no "sin dato")', async () => {
  const dir = tmp('agregado-plan-sin-hito-cero');
  git(dir, 'init', '-b', 'main');
  const cred = await cargarCred();
  const cfg = cred.leerCfg();
  cfg.gh_resumen = cfg.gh_resumen || {};
  cfg.gh_resumen[dir] = { mis_tareas: 0, plan_sin_hito: 0, plan_sin_hito_estancadas: 0, ts: Date.now() };
  cred.escribirCfg(cfg);

  const { refrescarAgregado } = await cargarAgregado(dir);
  const snap = refrescarAgregado(Date.now());
  assert.strictEqual(snap.plan_sin_hito, 0);
  assert.strictEqual(snap.plan_sin_hito_estancadas, 0);
});

test('refrescarAgregado: plan_sin_hito es null si no hay gh_resumen cacheado (repo aun sin refrescar)', async () => {
  const dir = tmp('agregado-plan-sin-gh');
  git(dir, 'init', '-b', 'main');
  const { refrescarAgregado } = await cargarAgregado(dir);
  const snap = refrescarAgregado(Date.now());
  assert.strictEqual(snap.plan_sin_hito, null);
  assert.strictEqual(snap.plan_sin_hito_estancadas, null);
});

// 'harness.js resumen': el comando de CONSULTA explicita — a diferencia del resumen de sesion (que
// calla en 0), aqui se dice SIEMPRE que haya dato, para que "cero tareas sin fase" tambien se pueda
// confirmar a proposito. FARO_CONFIG_PATH explicito: el proceso hijo (spawnSync) tiene otro PID que
// el test, y NODE_TEST_CONTEXT sin override usa el PID como parte de la ruta (ver credenciales.js).
const HARNESS = path.join(HOOKS, 'harness.js');
// 'harness.js resumen' lee agregadoCache() -> cfg.resumen_agregado[repoKey], NO gh_resumen
// directamente (ese ultimo solo lo consume refrescarAgregado al COMPONER el agregado).
function repoConCache(name, datos) {
  const dir = tmp(name);
  git(dir, 'init', '-b', 'main');
  const cfgPath = path.join(dir, '.faro-test.json');
  const cfg = { resumen_agregado: { [dir]: { tus_issues_abiertos: 0, ...datos, ts: Date.now() } } };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  return { dir, cfgPath };
}
function correrResumen(dir, cfgPath) {
  return spawnSync(process.execPath, [HARNESS, 'resumen'], { cwd: dir, encoding: 'utf8', timeout: plazo(15000), env: { ...process.env, FARO_CONFIG_PATH: cfgPath } });
}

test("harness.js resumen: dice 'Tareas planificadas SIN fase' con el conteo, aunque sea 0", () => {
  const { dir, cfgPath } = repoConCache('resumen-cmd-cero', { plan_sin_hito: 0, plan_sin_hito_estancadas: 0 });
  const r = correrResumen(dir, cfgPath);
  assert.match(r.stdout, /Tareas planificadas SIN fase: 0/, r.stdout + r.stderr);
});

test("harness.js resumen: con tareas sin fase, avisa las estancadas y sugiere el comando", () => {
  const { dir, cfgPath } = repoConCache('resumen-cmd-con-datos', { plan_sin_hito: 5, plan_sin_hito_estancadas: 2 });
  const r = correrResumen(dir, cfgPath);
  assert.match(r.stdout, /Tareas planificadas SIN fase: 5/, r.stdout);
  assert.match(r.stdout, /2 llevan >30 dias sin tocarse/, r.stdout);
  assert.match(r.stdout, /asignar-tarea --hito/, r.stdout);
});
