// Calidad medible (principios de ub-mode, github.com/unclebob/ub-mode): CRAP < 10 y sin duplicados
// estructurales >= 0,8 en el código que toca un cambio. El script (lib/calidad.py) se mide con Python;
// el job del CI generado instala crapper y dryer fijados a un commit y corre `.faro/calidad.py --ci`.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(RAIZ, 'plugins', 'faro', 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');
const SCRIPT = path.join(HOOKS, 'lib', 'calidad.py');
const require = createRequire(import.meta.url);
const { HERRAMIENTAS } = require(path.join(HOOKS, 'lib', 'calidad-ci.js'));
const { buscarPython } = require(path.join(HOOKS, 'lib', 'calidad-herramientas.js'));

const PY = buscarPython();
const sinPython = PY ? false : 'sin Python >= 3.11 en esta máquina';

// Ejecuta código Python con el módulo calidad importado (sin crapper ni dryer: solo lo puro).
function py(codigo) {
  const r = spawnSync(PY.cmd, [...PY.args, '-I', '-B', '-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(path.dirname(SCRIPT))}); import calidad as c\n${codigo}`], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

// Datos de JS a Python sin pelearse con null/true/false.
const j = (x) => `json.loads(${JSON.stringify(JSON.stringify(x))})`;

// ---------- dominio: el diff y lo tocado ----------

test('rangos_diff: líneas nuevas por fichero; un borrado marca la línea donde ocurre; /dev/null no cuenta', { skip: sinPython }, () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js',
    '@@ -3,0 +4,2 @@', '+x', '+y',
    '@@ -10 +12 @@', '-z', '+w',
    '@@ -20,3 +21,0 @@', '-a', '-b', '-c',
    'diff --git a/viejo.js b/viejo.js', '--- a/viejo.js', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-q', '-r',
  ].join('\n');
  const r = py(`print(json.dumps(c.rangos_diff(${JSON.stringify(diff)})))`);
  assert.deepStrictEqual(r, { 'src/a.js': [[4, 5], [12, 12], [21, 21]] });
});

test('evaluar: solo cuentan las funciones tocadas; sin cobertura se exige CC < umbral (cota segura de CRAP)', { skip: sinPython }, () => {
  const funciones = [
    { fichero: 'a.js', nombre: 'a.tocada', inicio: 1, fin: 30, complejidad: 11, crap: null },
    { fichero: 'a.js', nombre: 'a.intacta', inicio: 40, fin: 80, complejidad: 25, crap: null },
    { fichero: 'a.js', nombre: 'a.simple', inicio: 90, fin: 95, complejidad: 3, crap: null },
    { fichero: 'b.js', nombre: 'b.cubierta', inicio: 1, fin: 50, complejidad: 12, crap: 12.0 },
  ];
  const rangos = { 'a.js': [[10, 10], [92, 92]], 'b.js': [[5, 5]] };
  const r = py(`print(json.dumps(c.evaluar(${j(funciones)}, [], ${j(rangos)})))`);
  assert.deepStrictEqual(r.crap.map((f) => f.nombre), ['b.cubierta', 'a.tocada']);
  assert.strictEqual(r.medidas, 3);
});

test('evaluar: un duplicado cuenta si toca cualquiera de sus dos lados y su score llega al umbral', { skip: sinPython }, () => {
  const dup = (score, a, b) => ({ score, a: { fichero: a, inicio: 1, fin: 10 }, b: { fichero: b, inicio: 1, fin: 10 } });
  const duplicados = [dup(0.95, 'x.js', 'tocado.js'), dup(0.9, 'x.js', 'y.js'), dup(0.7, 'tocado.js', 'y.js')];
  const r = py(`print(json.dumps(c.evaluar([], ${j(duplicados)}, {"tocado.js": [[3, 3]]})))`);
  assert.deepStrictEqual(r.dup.map((d) => d.score), [0.95]);
});

test('evaluar con --todo (rangos None): todo cuenta como tocado', { skip: sinPython }, () => {
  const f = [{ fichero: 'a.js', nombre: 'a.f', inicio: 1, fin: 9, complejidad: 10, crap: null }];
  assert.strictEqual(py(`print(json.dumps(c.evaluar(${j(f)}, [], None)))`).crap.length, 1);
});

test('evaluar: lo que vive en .faro/ es de FARO, no del proyecto: ni se mide ni cuenta', { skip: sinPython }, () => {
  const f = [{ fichero: '.faro/calidad.py', nombre: 'calidad.main', inicio: 1, fin: 9, complejidad: 30, crap: null },
    { fichero: 'src/a.py', nombre: 'a.f', inicio: 1, fin: 9, complejidad: 2, crap: null }];
  const d = [{ score: 1, a: { fichero: '.faro/calidad.py', inicio: 1, fin: 9 }, b: { fichero: '.faro/calidad.py', inicio: 20, fin: 29 } }];
  const r = py(`print(json.dumps(c.evaluar(${j(f)}, ${j(d)}, None)))`);
  assert.deepStrictEqual([r.crap, r.dup, r.medidas], [[], [], 1]);
});

test('sin_duplicacion: los ficheros tocados que dryer no lee (p. ej. .js) se dicen, no se callan', { skip: sinPython }, () => {
  const r = py(`print(json.dumps(c.sin_duplicacion(["src/a.js", "src/b.ts", "src/c.jsx", "src/d.py"], {".ts", ".py"})))`);
  assert.deepStrictEqual(r, ['src/a.js', 'src/c.jsx']);
  const t = py(`print(json.dumps(c.informe({"crap": [], "dup": [], "medidas": 1}, False, sin_dup=["src/a.js"])))`);
  assert.match(t, /duplicación no medida en 1 fichero\(s\) \(\.js\)/);
});

test('informe: dice dónde, cuánto y qué hacer; OK cuando no hay nada', { skip: sinPython }, () => {
  const malo = { crap: [{ fichero: 'a.js', nombre: 'a.f', inicio: 3, fin: 40, complejidad: 14, crap: null }],
    dup: [{ score: 0.91, a: { fichero: 'a.js', inicio: 1, fin: 9 }, b: { fichero: 'b.js', inicio: 2, fin: 10 } }], medidas: 4 };
  const t = py(`print(json.dumps(c.informe(${j(malo)}, False)))`);
  assert.match(t, /a\.js:3-40 {2}a\.f {2}CC 14/);
  assert.match(t, /0\.91 {2}a\.js:1-9 {2}~ {2}b\.js:2-10/);
  assert.match(py(`print(json.dumps(c.informe({"crap": [], "dup": [], "medidas": 2}, True)))`), /OK: CRAP < 10/);
});

test('calidad.py sin crapper ni dryer instalados: avisa y sale con 0, también con --ci', { skip: sinPython }, () => {
  const r = spawnSync(PY.cmd, [...PY.args, '-I', SCRIPT, '--ci'], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /faltan crapper y dryer/);
});

// ---------- CI generado ----------

function repo(ficheros) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-calidad-'));
  for (const [rel, txt] of Object.entries(ficheros)) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), txt);
  }
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, windowsHide: true });
  return dir;
}
const PKG = JSON.stringify({ name: 'a', scripts: { test: 'echo t' } });
function ci(dir, remoto) {
  spawnSync('git', ['remote', 'add', 'origin', remoto], { cwd: dir, windowsHide: true });
  const r = spawnSync(process.execPath, [HARNESS, 'ci'], { cwd: dir, encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  return r.stdout + r.stderr;
}

test('herramientas fijadas a un commit completo (40 hex), nunca a una rama', () => {
  assert.deepStrictEqual(HERRAMIENTAS.map((h) => h.nombre), ['crapper', 'dryer']);
  for (const h of HERRAMIENTAS) assert.match(h.sha, /^[0-9a-f]{40}$/, h.nombre);
});

test('GitHub: job calidad solo en PR (no borrador), historia completa, Python 3.12 y las herramientas fijadas', () => {
  const dir = repo({ 'package.json': PKG });
  ci(dir, 'git@github.com:org/r.git');
  const yml = fs.readFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), 'utf8');
  const job = yml.slice(yml.indexOf('\n  calidad:'));
  assert.match(job, /if: github\.event_name == 'pull_request' && !github\.event\.pull_request\.draft/);
  assert.match(job, /fetch-depth: 0/);
  assert.match(job, /uses: actions\/setup-python@v7\n {8}with:\n {10}python-version: '3\.12'/);
  for (const h of HERRAMIENTAS) assert.ok(job.includes(`git+https://github.com/unclebob/${h.nombre}@${h.sha}`), h.nombre);
  assert.match(job, /run: python \.faro\/calidad\.py --ci --base "origin\/\$\{\{ github\.base_ref \}\}"/);
  assert.doesNotMatch(job, /secrets\./);
});

test('GitLab: job calidad solo en MR, GIT_DEPTH 0, trae la rama destino y compara contra ella', () => {
  const dir = repo({ 'package.json': PKG });
  ci(dir, 'git@gitlab.com:g/r.git');
  const yml = fs.readFileSync(path.join(dir, '.gitlab-ci.yml'), 'utf8');
  const job = yml.slice(yml.indexOf('\ncalidad:'));
  assert.match(job, /image: python:3\.12/);
  assert.match(job, /GIT_DEPTH: "0"/);
  assert.match(job, /- git fetch -q origin "\$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"/);
  assert.match(job, /- python \.faro\/calidad\.py --ci --base "origin\/\$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"/);
  assert.match(job, /rules:\n {4}- if: \$CI_PIPELINE_SOURCE == "merge_request_event"\n(?! {4}- if)/);
});

test('ci copia .faro/calidad.py (con las versiones fijadas en cabecera) y lo actualiza si cambia', () => {
  const dir = repo({ 'package.json': PKG });
  ci(dir, 'git@github.com:org/r.git');
  const copia = fs.readFileSync(path.join(dir, '.faro', 'calidad.py'), 'utf8');
  for (const h of HERRAMIENTAS) assert.ok(copia.includes(`${h.nombre}@${h.sha}`), h.nombre);
  assert.ok(copia.endsWith(fs.readFileSync(SCRIPT, 'utf8')), 'el resto es el script tal cual');
  fs.writeFileSync(path.join(dir, '.faro', 'calidad.py'), 'viejo\n');
  fs.rmSync(path.join(dir, '.github'), { recursive: true });
  ci(dir, 'git@github.com:org/r.git');
  assert.ok(fs.readFileSync(path.join(dir, '.faro', 'calidad.py'), 'utf8').endsWith(fs.readFileSync(SCRIPT, 'utf8')));
});

test('ci con CI ya existente: el aviso de «mergea a mano» incluye el job de calidad', () => {
  const dir = repo({ 'package.json': PKG, '.github/workflows/ci.yml': 'name: propio\n' });
  const salida = ci(dir, 'git@github.com:org/r.git');
  assert.match(salida, /python \.faro\/calidad\.py --ci/);
  assert.ok(fs.existsSync(path.join(dir, '.faro', 'calidad.py')));
});

// ---------- harness.js calidad en local ----------

test('harness.js calidad sin Python: lo dice y sale con 0 (en local informa, nunca bloquea)', () => {
  const dir = repo({ 'package.json': PKG });
  const r = spawnSync(process.execPath, [HARNESS, 'calidad'], { cwd: dir, encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, FARO_PYTHON: path.join(dir, 'no-existe-python') } });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /Python 3\.11/);
});
