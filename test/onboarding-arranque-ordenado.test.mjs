// ARRANQUE de un repo recien nacido: el onboarding tiene un PRINCIPIO y un FINAL, y el harness
// debe decir los dos. Sin eso el agente deduce el orden chocando: edita en develop hasta que el
// gate le frena a media faena, y sigue de largo hasta abrir un cambio anclado a una fase que
// todavia no existe como hito en la forja (no ha corrido 'hito sync').
//
// Las tres piezas que se fijan aqui:
//   1. El onboarding ABRE SU RAMA: si estas en develop/main, el primer paso es 'rama chore inicial'.
//   2. El onboarding TERMINA en ESTADO.md + risks + PR. Changes/specs/issues vienen DESPUES.
//   3. Un cambio que declara 'fase: N' con una fase N que no existe en ESTADO.md es incoherente.
//
// El punto 3 se valida en LOCAL (contra ESTADO.md), no contra la API: 'validate' es determinista y
// sin red. Los hitos reales de la forja ya los audita 'hito auditar'.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');
const run = (args, cwd) =>
  spawnSync(process.execPath, [HARNESS, ...args], {
    cwd, encoding: 'utf8', timeout: 120000, env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${name}-`));
const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' });
// spawnSync puede devolver null en stdout/stderr segun como termine el proceso: normaliza siempre.
const salida = (r) => `${r.stdout || ''}
${r.stderr || ''}`;

// Repo git de verdad, en la rama que se pida: el paso 0 del onboarding depende de DONDE estas.
function repoEnRama(name, rama) {
  const dir = tmp(name);
  git(['init', '-q', '-b', 'develop'], dir);
  git(['config', 'user.email', 't@t.t'], dir);
  git(['config', 'user.name', 'T'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'init'], dir);
  if (rama !== 'develop') git(['checkout', '-qb', rama], dir);
  return dir;
}

const ESTADO_2_FASES = `---
nombre: portal
clave: PORT
objetivo: Un portal
estado: in_progress
fases_total: 2
fase_actual: 1
owner: tester
---
### Fase 1 · Maqueta — in_progress
- [ ] pantalla principal

### Fase 2 · Integracion — backlog
- [ ] cliente api
`;

// Cambio VALIDO salvo por lo que cada test quiera romper: si le faltan campos basicos, sus errores
// tapan al que se esta midiendo. 'sin_spec' evita exigir deltas, que aqui no vienen al caso.
function escribirCambio(dir, slug, fm) {
  const d = path.join(dir, 'gestion', 'cambios', 'changes', slug);
  fs.mkdirSync(d, { recursive: true });
  const completo = { titulo: 'Algo', descripcion: 'Que resuelve', owner: 'tester', responsable: 'tester', sin_spec: true, ...fm };
  const front = Object.entries(completo).map(([k, v]) => `${k}: ${Array.isArray(v) ? JSON.stringify(v) : v}`).join('\n');
  fs.writeFileSync(path.join(d, 'proposal.md'), `---\n${front}\n---\n\n## Por que\n\nMotivo.\n`);
  return d;
}

// ---------- 1. el onboarding abre su propia rama ----------

test('onboarding en develop: el PRIMER paso es abrir la rama de arranque, no editar', () => {
  const dir = repoEnRama('onb-rama', 'develop');
  const r = run(['session'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(salida(r), /rama chore [\\"']*inicial/i,
    `el onboarding debe mandar abrir 'rama chore inicial' antes de tocar nada:\n${salida(r).slice(0, 1200)}`);
});

test('onboarding YA en una rama de trabajo: no repite el paso de abrir rama', () => {
  const dir = repoEnRama('onb-ya-rama', 'chore/inicial');
  const r = run(['session'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(salida(r), /rama chore [\\"']*inicial/i,
    `ya esta en chore/inicial, no debe volver a pedir la rama:\n${salida(r).slice(0, 1200)}`);
});

// ---------- 2. el onboarding dice DONDE TERMINA ----------

test('onboarding: dice explicitamente que NO se abren cambios ni specs todavia', () => {
  const dir = repoEnRama('onb-parada', 'develop');
  const r = run(['session'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(salida(r), /NO (crees|abras)[^.]*cambio/i,
    `debe prohibir abrir cambios durante el onboarding:\n${salida(r).slice(0, 1500)}`);
  assert.match(salida(r), /hito sync/,
    `debe decir que las fases no son hitos hasta 'hito sync':\n${salida(r).slice(0, 1500)}`);
});

// ---------- 3. cambio anclado a una fase que no existe ----------

test("validate: un cambio con 'fase: 9' inexistente en ESTADO.md es un error de ciclo", () => {
  const dir = repoEnRama('fase-inexistente', 'feat/x');
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), ESTADO_2_FASES);
  escribirCambio(dir, 'algo', { titulo: 'Algo', estado: 'borrador', fase: 9, owner: 'tester' });
  const r = run(['validate'], dir);
  assert.match(salida(r), /fase:? 9[^]*no existe/i,
    `debe senalar que la fase 9 no existe:\n${r.stdout}\n${r.stderr}`);
});

test("validate: un cambio con 'fase: 1' existente NO genera ese error", () => {
  const dir = repoEnRama('fase-ok', 'feat/x');
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), ESTADO_2_FASES);
  escribirCambio(dir, 'algo', { titulo: 'Algo', estado: 'borrador', fase: 1, owner: 'tester' });
  const r = run(['validate'], dir);
  assert.doesNotMatch(salida(r), /no existe en ESTADO|fase 1[^\d]*no existe/i,
    `la fase 1 existe, no debe quejarse:\n${r.stdout}\n${r.stderr}`);
});

test("validate: 'fase: backlog' es valido (sala de espera), no una fase inexistente", () => {
  const dir = repoEnRama('fase-backlog', 'feat/x');
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), ESTADO_2_FASES);
  escribirCambio(dir, 'algo', { titulo: 'Algo', estado: 'borrador', fase: 'backlog', owner: 'tester' });
  const r = run(['validate'], dir);
  assert.doesNotMatch(salida(r), /no existe en ESTADO/i,
    `'backlog' es la sala de espera declarada, no un error:\n${r.stdout}\n${r.stderr}`);
});

test('validate: un cambio SIN fase declarada no dispara el error (la fase es opcional en borrador)', () => {
  const dir = repoEnRama('fase-ausente', 'feat/x');
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), ESTADO_2_FASES);
  escribirCambio(dir, 'algo', { titulo: 'Algo', estado: 'borrador', owner: 'tester' });
  const r = run(['validate'], dir);
  assert.doesNotMatch(salida(r), /no existe en ESTADO/i,
    `sin fase declarada no hay nada que contrastar:\n${r.stdout}\n${r.stderr}`);
});
