// 'gitInfo()' hace TRES llamadas a git —rev-parse, config user.name y status --porcelain— porque
// quien lo pide normalmente quiere saber tambien si hay trabajo sin commitear y quien firma.
//
// Pero 'pre-doc' (el hook que corre en CADA Write/Edit) solo necesita UNA cosa: en que rama estas,
// para decidir si esa rama esta protegida. Pagaba las otras dos en cada escritura sin usarlas —
// medido: 'git status --porcelain' cuesta ~156ms y 'git config' otro tanto, en una llamada que se
// repite decenas de veces por sesion.
//
// 'ramaActual()' es la version barata: una sola llamada a git. Misma respuesta para lo que importa.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${n}-`));

// El modulo es una factory: se le pasa el mismo CTX minimo que usa el harness.
function lib(dir) {
  return require(path.join(HOOKS, 'lib', 'git.js'))({
    fs, path, ROOT: dir,
    ESTADO_FILE: 'ESTADO.md', DOC_PATHS: /^(documentos|gestion)\//,
    WORK_BRANCH_RE: /^[a-z]+\/.+/, PROTECTED_BRANCHES: ['main', 'master'],
    BRANCH_TYPES: ['feat', 'fix'], isProtected: () => false, isDone: () => false,
    NO_INSTANCIA: false, listFiles: () => [], fmtDate: (d) => d, parseEstado: () => null, labelSlugs: () => [],
  });
}

function repo(rama) {
  const dir = tmp('rama');
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', rama);
  git('config', 'user.email', 't@t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  return dir;
}

test('ramaActual da la MISMA rama que gitInfo (que es lo unico que pre-doc necesita)', () => {
  for (const rama of ['develop', 'main', 'feat/algo']) {
    const dir = repo(rama);
    const g = lib(dir);
    assert.strictEqual(g.ramaActual(), rama, `rama ${rama}`);
    assert.strictEqual(g.ramaActual(), g.gitInfo().branch, 'debe coincidir con gitInfo().branch');
  }
});

test('sin repo git devuelve null, igual que gitInfo', () => {
  const dir = tmp('sin-git');
  const g = lib(dir);
  assert.strictEqual(g.ramaActual(), null);
});

// Lo que justifica que exista: una sola llamada a git en vez de tres.
test('ramaActual hace UNA sola llamada a git (gitInfo hace tres)', () => {
  const src = fs.readFileSync(path.join(HOOKS, 'lib', 'git.js'), 'utf8');
  const cuerpo = src.slice(src.indexOf('function ramaActual'), src.indexOf('function ramaActual') + 600);
  const fin = cuerpo.indexOf('\n}');
  const solo = cuerpo.slice(0, fin);
  const llamadas = (solo.match(/\bgit\(/g) || []).length;
  assert.strictEqual(llamadas, 1, `ramaActual debe llamar a git UNA vez, no ${llamadas}: si no, no ahorra nada`);
  assert.ok(!/status|--porcelain|config/.test(solo), `no puede pedir status ni config: ${solo}`);
});

// Y que no rompa la cache: si alguien ya pidio gitInfo, ramaActual debe aprovecharla en vez de
// lanzar otro proceso git.
test('si gitInfo ya se consulto, ramaActual reutiliza su resultado', () => {
  const dir = repo('feat/x');
  const g = lib(dir);
  assert.strictEqual(g.gitInfo().branch, 'feat/x');
  assert.strictEqual(g.ramaActual(), 'feat/x', 'misma respuesta, sin volver a preguntar');
});
