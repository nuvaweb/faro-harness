// 'harness.js vigilar' corre EN BACKGROUND (hook con 'asyncRewake') y solo habla si hay algo que
// decir. Existe porque los avisos que necesitan RED no caben en ningun hook sincrono: 'session' y
// 'validate' no tocan la red a proposito, asi que el aviso de desajuste con la forja acabo
// desterrado a 'consolidar'/'publicar', donde solo se ve si alguien invoca esos comandos.
//
// El contrato con el hook es estricto y por eso se fija aqui:
//   - exit 2 + mensaje por STDERR  -> despierta al agente
//   - exit 0 y en silencio          -> no ha pasado nada que contar
//
// El SILENCIO es lo mas importante del diseño: un aviso que salta siempre se aprende a ignorar, y
// entonces deja de avisar de nada.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'harness.js');
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${n}-`));

// Sin token no se puede consultar la forja: el vigilante debe callar, no inventar desajustes.
const run = (dir, env = {}, extra = []) => spawnSync(process.execPath, [HARNESS, 'vigilar', ...extra], {
  cwd: dir, encoding: 'utf8', timeout: 60000,
  env: { ...process.env, CLAUDE_PROJECT_DIR: dir, FARO_GITHUB_TOKEN: '', GITHUB_TOKEN: '', FARO_GITHUB_TOKEN: '', ...env },
});

function repo(estado) {
  const dir = tmp('vigilar');
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  fs.mkdirSync(path.join(dir, 'documentos', 'funcional'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'documentos', 'funcional', 'x.md'), '# Funcional\n');
  if (estado) fs.writeFileSync(path.join(dir, 'ESTADO.md'), estado);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  return dir;
}

const ESTADO = `---
iniciativa: T
fases_total: 1
fase_actual: 1
owner: t
funcional: documentos/funcional/x.md
---

### Fase 1 · Mockup — in_progress
Las pantallas.
Objetivo: 2026-12-01
- [x] #4 · Pantallas — @t
`;

// ---------- silencio cuando no hay nada que decir ----------

test('sin ESTADO.md no dice nada y sale 0 (no todo repo tiene faseo)', () => {
  const r = run(repo(null));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stderr.trim(), '', 'no puede hablar si no hay faseo');
});

// Este es el caso que mas importa: sin red o sin token NO se sabe nada de la forja, y "no pude
// mirar" no es "esta mal". Avisar aqui seria avisar en falso, y ensenaria a ignorar el aviso.
test('sin token no inventa desajustes: calla y sale 0', () => {
  const r = run(repo(ESTADO));
  assert.strictEqual(r.status, 0, `no puede avisar de lo que no pudo consultar:\n${r.stderr}`);
  assert.strictEqual(r.stderr.trim(), '');
});

test('sin repo git tampoco revienta', () => {
  const dir = tmp('sin-git');
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), ESTADO);
  const r = spawnSync(process.execPath, [HARNESS, 'vigilar'], {
    cwd: dir, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, FARO_GITHUB_TOKEN: '', GITHUB_TOKEN: '' },
  });
  assert.notStrictEqual(r.status, null, 'el proceso tiene que terminar por si mismo');
  assert.ok(r.status === 0 || r.status === 2, `salida inesperada ${r.status}: ${r.stderr}`);
});

// Un ReferenceError sale con 1 y solo se ve en el stderr de un proceso de fondo que nadie lee: el
// hook no distingue "no habia nada que decir" de "reventé". Este test existe porque paso de verdad
// (un require('os') que faltaba): sintaxis correcta, fallo solo al ejecutar.
test('nunca sale con 1: reventar en background es un fallo que nadie ve', () => {
  const r = run(repo(ESTADO));
  assert.notStrictEqual(r.status, 1, `el vigilante reventó:\n${r.stderr}`);
  assert.ok(!/ReferenceError|TypeError|is not defined/.test(r.stderr), r.stderr);
});

// ---------- '--ahora': la misma comprobacion, a peticion ----------
//
// El vigilante solo corre en SessionStart. A mitad de sesion la unica via era lanzar 'session'
// entero y filtrar su salida con grep: ~14s BLOQUEANDO el hilo para sacar dos lineas. Y en un repo
// LEGACY recien adoptado, el primer arranque no tiene foto anterior, asi que el vigilante calla y
// quien pregunta se queda sin respuesta.

test('--ahora sale con 0 aunque no pueda consultar: lo pide un humano, no es un fallo', () => {
  const r = run(repo(ESTADO), {}, ['--ahora']);
  assert.strictEqual(r.status, 0, r.stderr);
});

// Lo que NO puede hacer: callar como el modo background. Quien pregunta espera una respuesta.
test('--ahora SIEMPRE responde, aunque la respuesta sea "no lo se"', () => {
  const r = run(repo(ESTADO), {}, ['--ahora']);
  const todo = r.stdout + r.stderr;
  assert.ok(todo.trim().length, 'preguntar y no recibir nada es peor que un no');
  // Y la distincion que mas importa: "no pude mirar" NO es "esta bien".
  assert.match(todo, /no lo se|No pude consultar/i, `no puede dar a entender que cuadra: ${todo}`);
});

// ---------- el contrato con el hook ----------

// Si esto se rompe, el aviso deja de llegar SIN QUE NADIE SE ENTERE: el hook solo despierta al
// agente con exit 2, y solo muestra stderr. Por eso se fija en el codigo fuente.
test('el vigilante señala por STDERR y con exit 2, que es lo unico que el hook escucha', () => {
  const src = fs.readFileSync(HARNESS, 'utf8');
  const ini = src.indexOf('async function cmdVigilar');
  assert.ok(ini > 0, 'no encuentro cmdVigilar');
  // Hasta la SIGUIENTE funcion, no una ventana de N caracteres: con un limite fijo, crecer la
  // funcion empuja el contrato fuera de la ventana y el test se vuelve verde por no mirar.
  const fin = src.indexOf('\nfunction ', ini + 1);
  const cuerpo = src.slice(ini, fin > ini ? fin : src.length);
  assert.match(cuerpo, /process\.stderr\.write/, 'debe escribir por stderr: el hook ignora stdout si hay stderr');
  assert.match(cuerpo, /process\.exit\(2\)/, 'debe salir con 2: es lo que despierta al agente');
  assert.match(cuerpo, /process\.exit\(0\)/, 'y con 0 cuando no hay nada que decir');
});

test('el hook esta declarado con asyncRewake (si no, bloquearia el arranque)', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'hooks.json'), 'utf8'));
  const enSesion = (hooks.hooks.SessionStart || []).flatMap((g) => g.hooks || []);
  const vigilante = enSesion.find((h) => String(h.command || '').includes('vigilar'));
  assert.ok(vigilante, 'el vigilante no esta cableado en SessionStart');
  assert.strictEqual(vigilante.asyncRewake, true, 'sin asyncRewake correria en primer plano y alargaria el arranque');
});
