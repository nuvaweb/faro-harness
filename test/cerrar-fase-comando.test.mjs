// La ceremonia COMPLETA sobre un repo de verdad: 'harness.js cerrar-fase <N>'. Los tests unitarios
// fijan el criterio (planCerrarFase) y la reescritura (cerrarFaseEnTexto); esto comprueba que el
// comando los ata bien y que NO escribe nada sin --confirmo.
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
// Sin token ni forja: el comando debe funcionar igual (la consulta a la forja es opcional por diseño).
const run = (args, dir) => spawnSync(process.execPath, [HARNESS, ...args], {
  cwd: dir, encoding: 'utf8', timeout: 60000,
  env: { ...process.env, CLAUDE_PROJECT_DIR: dir, FARO_GITHUB_TOKEN: '', GITHUB_TOKEN: '' },
});

const ESTADO = (f1 = 'in_progress', t1 = '- [x] #4 · Pantallas — @t') => `---
iniciativa: T
fases_total: 2
fase_actual: 1
owner: t
funcional: documentos/funcional/x.md
---

### Fase 1 · Mockup — ${f1}
Las pantallas del informe.
Objetivo: 2026-12-01
${t1}

### Fase 2 · Integracion — pending
Conectar la API.
Objetivo: 2027-01-15
- [ ] #7 · Cliente — @t
`;

function repo(estado = ESTADO(), conInforme = true) {
  const dir = tmp('cerrar-fase');
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  fs.mkdirSync(path.join(dir, 'documentos', 'funcional'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'documentos', 'funcional', 'x.md'), '# Funcional\n');
  if (conInforme) {
    fs.mkdirSync(path.join(dir, 'gestion', 'reporting', 'informes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'gestion', 'reporting', 'informes', '2026-12-01-fase-1-informe.md'), '# Cierre fase 1\n');
  }
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), estado);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false'); git('config', 'tag.gpgsign', 'false');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  return dir;
}

// ---------- se niega, y dice por que ----------

test('sin informe: se NIEGA y nombra el fichero que espera', () => {
  const dir = repo(ESTADO(), false);
  const r = run(['cerrar-fase', '1'], dir);
  assert.notStrictEqual(r.status, 0, r.stdout);
  assert.match(r.stdout, /informe/i, r.stdout);
  assert.match(r.stdout, /fase-1-informe\.md/, r.stdout);
});

test('con tareas abiertas: se NIEGA y dice cuantas', () => {
  const dir = repo(ESTADO('in_progress', '- [ ] #4 · Pantallas — @t'));
  const r = run(['cerrar-fase', '1'], dir);
  assert.notStrictEqual(r.status, 0, r.stdout);
  assert.match(r.stdout, /1 tarea/, r.stdout);
});

test('una fase que no existe: se NIEGA sin tocar nada', () => {
  const dir = repo();
  const antes = fs.readFileSync(path.join(dir, 'ESTADO.md'), 'utf8');
  const r = run(['cerrar-fase', '9'], dir);
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ESTADO.md'), 'utf8'), antes);
});

// ---------- sin --confirmo NO escribe ----------

test('sin --confirmo ENSENA lo que haria y NO toca ESTADO.md ni crea el tag', () => {
  const dir = repo();
  const antes = fs.readFileSync(path.join(dir, 'ESTADO.md'), 'utf8');
  const r = run(['cerrar-fase', '1'], dir);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.match(r.stdout, /Se CERRARIA la Fase 1/, r.stdout);
  assert.match(r.stdout, /--confirmo/, 'debe decir como confirmar');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ESTADO.md'), 'utf8'), antes, 'NO puede haber escrito');
  const tags = spawnSync('git', ['tag', '-l'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  assert.strictEqual(tags, '', 'NO puede haber creado el tag');
});

// ---------- con --confirmo, la ceremonia entera ----------

test('con --confirmo: cierra la fase, avanza fase_actual y crea el tag', () => {
  const dir = repo();
  const r = run(['cerrar-fase', '1', '--confirmo'], dir);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const txt = fs.readFileSync(path.join(dir, 'ESTADO.md'), 'utf8');
  assert.match(txt, /^### Fase 1 · Mockup — done$/m, txt);
  assert.match(txt, /^fase_actual: 2$/m, txt);
  assert.match(txt, /^### Fase 2 · Integracion — pending$/m, 'la fase 2 intacta');
  assert.match(txt, /- \[x\] #4 · Pantallas — @t/, 'las tareas intactas');
  const tags = spawnSync('git', ['tag', '-l'], { cwd: dir, encoding: 'utf8' }).stdout;
  assert.match(tags, /fase-1/, `debe crear el tag: ${tags}`);
});

test('el ESTADO.md resultante sigue pasando validate', () => {
  const dir = repo();
  assert.strictEqual(run(['cerrar-fase', '1', '--confirmo'], dir).status, 0);
  const v = run(['validate'], dir);
  assert.strictEqual(v.status, 0, `el faseo quedo incoherente tras cerrar:\n${v.stdout}`);
});

test('cerrar dos veces la misma fase: la segunda se niega (ya esta cerrada)', () => {
  const dir = repo();
  assert.strictEqual(run(['cerrar-fase', '1', '--confirmo'], dir).status, 0);
  const r2 = run(['cerrar-fase', '1', '--confirmo'], dir);
  assert.notStrictEqual(r2.status, 0, r2.stdout);
  assert.match(r2.stdout, /ya esta cerrada|historico/i, r2.stdout);
});
