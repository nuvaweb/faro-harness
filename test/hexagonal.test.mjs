// Cambio 'hexagonal-verificada' (#280): FARO impulsa y verifica la arquitectura hexagonal en los repos
// de codigo. Un test por escenario del delta specs/hexagonal/spec.md.
//
// Dos niveles, como el diseno: el DOMINIO (lib/hexagonal.js, puro: recibe textos y la declaracion) y
// los ADAPTADORES (extractores por lenguaje y lectura de disco), mas el cableado en harness.js
// (comando 'hexagonal', aviso y gate de validate).
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
const require = createRequire(import.meta.url);
const HX = require(path.join(HOOKS, 'lib', 'hexagonal.js'));
const LENG = require(path.join(HOOKS, 'lib', 'hexagonal-lenguajes.js'));

const SECCION = `## Hexagonal
- dominio: \`src/dominio/\`
- aplicacion: src/aplicacion/
- puertos: src/puertos/
- adaptadores: src/adaptadores/
- composicion: src/index.ts
- permitidos: zod
`;
const ARQ = `# Arquitectura — t\n\n## Mapa de módulos\n- dominio: reglas\n\n${SECCION}\n## Testing\nnode --test\n`;

// Ficheros ya extraidos (como los entrega el adaptador) a partir de { rel: texto }.
const fich = (obj) => Object.entries(obj).map(([rel, texto]) => ({ rel, ...LENG.extraer(rel, texto) }));
const reglas = (r) => r.violaciones.map((v) => `${v.rel}:${v.regla}`);

// ---------- Requisito: la hexagonal se declara en ARCHITECTURE.md ----------

test('declaracion: lee capas, composicion y permitidos de la seccion (con o sin backticks)', () => {
  const d = HX.leerDeclaracion(ARQ);
  assert.strictEqual(d.declarada, true);
  assert.deepStrictEqual(d.capas.dominio, ['src/dominio/']);
  assert.deepStrictEqual(d.capas.adaptadores, ['src/adaptadores/']);
  assert.deepStrictEqual(d.composicion, ['src/index.ts']);
  assert.deepStrictEqual(d.permitidos, ['zod']);
  assert.deepStrictEqual(d.errores, []);
});

test('declaracion: sin la seccion no esta declarada', () => {
  const d = HX.leerDeclaracion('# Arquitectura\n## Mapa de módulos\n- x\n');
  assert.strictEqual(d.declarada, false);
});

test('declaracion: una seccion sin dominio es un error de declaracion y no da el repo por conforme', () => {
  const d = HX.leerDeclaracion('## Hexagonal\n- adaptadores: src/adaptadores/\n');
  assert.strictEqual(d.declarada, true);
  assert.ok(d.errores.some((e) => /dominio/.test(e)), JSON.stringify(d.errores));
  const r = HX.comprobar(d, []);
  assert.strictEqual(r.conforme, false);
});

// ---------- Requisito: el dominio no depende de infraestructura ----------

test('dominio que importa un adaptador: violacion dominio → adaptadores con fichero y linea', () => {
  const d = HX.leerDeclaracion(ARQ);
  const r = HX.comprobar(d, fich({
    'src/dominio/pedido.ts': "import { z } from 'zod';\nimport { guardar } from '../adaptadores/d1.ts';\n",
    'src/adaptadores/d1.ts': 'export const guardar = () => {};\n',
  }));
  const v = r.violaciones.find((x) => x.rel === 'src/dominio/pedido.ts');
  assert.ok(v, JSON.stringify(r.violaciones));
  assert.strictEqual(v.regla, 'dominio → adaptadores');
  assert.strictEqual(v.linea, 2);
  assert.strictEqual(r.conforme, false);
});

test('dominio que hace E/S (fetch o node:fs): violacion dominio hace E/S', () => {
  const d = HX.leerDeclaracion(ARQ);
  const r = HX.comprobar(d, fich({
    'src/dominio/precio.ts': 'export async function precio() { return fetch("https://x"); }\n',
    'src/dominio/lector.ts': "import fs from 'node:fs';\nexport const leer = () => fs.readFileSync('x');\n",
    'src/dominio/config.ts': 'export const k = process.env.CLAVE;\n',
  }));
  const rs = reglas(r);
  assert.ok(rs.includes('src/dominio/precio.ts:dominio hace E/S'), rs.join('\n'));
  assert.ok(rs.includes('src/dominio/lector.ts:dominio hace E/S'), rs.join('\n'));
  assert.ok(rs.includes('src/dominio/config.ts:dominio hace E/S'), rs.join('\n'));
});

test('dominio con paquete permitido o modulo sin E/S: sin violacion', () => {
  const d = HX.leerDeclaracion(ARQ);
  const r = HX.comprobar(d, fich({
    'src/dominio/pedido.ts': "import { z } from 'zod';\nimport path from 'node:path';\nimport { Id } from './id.ts';\nimport type { Repo } from '../puertos/repo.ts';\n",
    'src/dominio/id.ts': 'export type Id = string;\n',
    'src/puertos/repo.ts': "import type { Id } from '../dominio/id.ts';\nexport interface Repo { get(id: Id): unknown }\n",
  }));
  assert.deepStrictEqual(r.violaciones, []);
  assert.strictEqual(r.conforme, true);
});

test('dominio con paquete externo no permitido: violacion dominio usa paquete externo', () => {
  const d = HX.leerDeclaracion(ARQ);
  const r = HX.comprobar(d, fich({ 'src/dominio/a.ts': "import axios from 'axios';\n" }));
  assert.deepStrictEqual(reglas(r), ['src/dominio/a.ts:dominio usa paquete externo']);
});

test('dominio que importa aplicacion: violacion dominio → aplicacion', () => {
  const d = HX.leerDeclaracion(ARQ);
  const r = HX.comprobar(d, fich({ 'src/dominio/a.ts': "import { x } from '../aplicacion/caso.ts';\n" }));
  assert.deepStrictEqual(reglas(r), ['src/dominio/a.ts:dominio → aplicacion']);
});

// ---------- Requisito: solo la composicion importa adaptadores ----------

test('caso de uso que importa un adaptador: violacion aplicacion → adaptadores', () => {
  const d = HX.leerDeclaracion(ARQ);
  const r = HX.comprobar(d, fich({
    'src/aplicacion/crear-pedido.ts': "import { guardar } from '../adaptadores/d1.ts';\nimport { Pedido } from '../dominio/pedido.ts';\n",
  }));
  assert.deepStrictEqual(reglas(r), ['src/aplicacion/crear-pedido.ts:aplicacion → adaptadores']);
});

test('la composicion cablea adaptadores y casos de uso sin violacion', () => {
  const d = HX.leerDeclaracion(ARQ);
  const r = HX.comprobar(d, fich({
    'src/index.ts': "import { guardar } from './adaptadores/d1.ts';\nimport { crear } from './aplicacion/crear-pedido.ts';\nexport default { fetch: () => crear(guardar) };\n",
    'src/adaptadores/d1.ts': "import fs from 'node:fs';\nexport const guardar = () => fetch('x');\n",
  }));
  assert.deepStrictEqual(r.violaciones, []);
});

// ---------- Requisito: Python con las mismas reglas ----------

test('python: dominio que importa requests sin permitir: violacion dominio usa paquete externo', () => {
  const d = HX.leerDeclaracion(ARQ);
  const r = HX.comprobar(d, fich({
    'src/dominio/tarifa.py': 'from dataclasses import dataclass\nimport requests\n',
  }));
  assert.deepStrictEqual(reglas(r), ['src/dominio/tarifa.py:dominio usa paquete externo']);
  assert.strictEqual(r.violaciones[0].linea, 2);
});

test('python: dominio que importa un adaptador por ruta absoluta o relativa', () => {
  const d = HX.leerDeclaracion(ARQ);
  const r = HX.comprobar(d, fich({
    'src/dominio/a.py': 'from src.adaptadores.db import guardar\n',
    'src/dominio/b.py': 'from ..adaptadores import db\n',
    'src/dominio/c.py': 'import os\nx = os.environ["K"]\n',
  }));
  const rs = reglas(r);
  assert.ok(rs.includes('src/dominio/a.py:dominio → adaptadores'), rs.join('\n'));
  assert.ok(rs.includes('src/dominio/b.py:dominio → adaptadores'), rs.join('\n'));
  assert.ok(rs.includes('src/dominio/c.py:dominio hace E/S'), rs.join('\n'));
});

// ---------- Requisito: plan de migracion ----------

test('plan: clasifica puros como dominio y los que hacen E/S como adaptador', () => {
  const p = HX.planMigracion(fich({
    'src/servicio.ts': "export const traer = () => fetch('https://x');\n",
    'src/calculo.ts': 'export const suma = (a, b) => a + b;\n',
    'src/index.ts': "import { traer } from './servicio.ts';\n",
  }));
  assert.ok(p.dominio.includes('src/calculo.ts'), JSON.stringify(p));
  assert.ok(p.adaptadores.includes('src/servicio.ts'), JSON.stringify(p));
  assert.ok(p.composicion.includes('src/index.ts'), JSON.stringify(p));
  assert.match(p.seccion, /^## Hexagonal/m);
  assert.ok(p.pasos.length >= 3);
});

// ---------- Requisito: el dominio del analisis es puro ----------

test('motor: lib/hexagonal.js no hace E/S ni carga modulos; los adaptadores no se cargan desde el', () => {
  const src = fs.readFileSync(path.join(HOOKS, 'lib', 'hexagonal.js'), 'utf8')
    .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const re of [/require\s*\(/, /\bprocess\./, /\bfs\./, /fetch\s*\(/]) assert.doesNotMatch(src, re);
  const harness = fs.readFileSync(HARNESS, 'utf8');
  assert.match(harness, /require\('\.\/lib\/hexagonal\.js'\)/);
});

// ---------- Cableado: comando y validate ----------

function repoCon(ficheros, { estado = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-hex-'));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  if (estado) {
    fs.mkdirSync(path.join(dir, 'documentos', 'funcional'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'documentos', 'funcional', 'f.md'), '# F\n## Fuera de alcance\n- Nada mas\n');
    fs.writeFileSync(path.join(dir, 'ESTADO.md'), `---
iniciativa: T
fases_total: 1
fase_actual: 1
owner: t
funcional: documentos/funcional/f.md
---

### Fase 1 · Una — in_progress
Lo que trae esta fase.
Objetivo: 2026-12-01
- [ ] #1 · Algo — @t
`);
  }
  for (const [rel, txt] of Object.entries(ficheros)) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), txt);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}
const run = (dir, ...args) => spawnSync(process.execPath, [HARNESS, ...args], {
  cwd: dir, encoding: 'utf8', timeout: 90000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
});
const bloqueantes = (salida) => String(salida).split(/Avisos \(NO bloquean/)[0];

const VIOLA = {
  'ARCHITECTURE.md': ARQ,
  'src/dominio/pedido.ts': "import { guardar } from '../adaptadores/d1.ts';\n",
  'src/adaptadores/d1.ts': 'export const guardar = () => {};\n',
  'src/index.ts': "import { guardar } from './adaptadores/d1.ts';\n",
};

test('comando: harness.js hexagonal --json devuelve capas y violaciones, y sale con error', () => {
  const r = run(repoCon(VIOLA, { estado: false }), 'hexagonal', '--json');
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  const base = Array.isArray(j) ? j[0] : j;
  assert.deepStrictEqual(base.declaracion.capas.dominio, ['src/dominio/']);
  assert.strictEqual(base.violaciones[0].regla, 'dominio → adaptadores');
});

test('comando: --plan propone la seccion sin tocar el arbol de trabajo', () => {
  const dir = repoCon({
    'ARCHITECTURE.md': '# Arquitectura\n## Mapa de módulos\n- x\n',
    'src/servicio.ts': "export const traer = () => fetch('https://x');\n",
    'src/calculo.ts': 'export const suma = (a, b) => a + b;\n',
  }, { estado: false });
  const r = run(dir, 'hexagonal', '--plan');
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /## Hexagonal/);
  assert.match(r.stdout, /src\/calculo\.ts/);
  const st = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout;
  assert.strictEqual(st.trim(), '', `el plan no debe escribir nada:\n${st}`);
});

test('validate --gates: con la hexagonal declarada y una violacion, error [hexagonal]', () => {
  const r = run(repoCon(VIOLA), 'validate', '--gates');
  assert.notStrictEqual(r.status, 0, r.stdout);
  assert.match(bloqueantes(r.stdout), /\[hexagonal\]/);
});

test('validate: con codigo y sin seccion, aviso [hexagonal] que no tumba', () => {
  const dir = repoCon({
    'ARCHITECTURE.md': '# Arquitectura\n## Mapa de módulos\n- x\n',
    'src/a.ts': 'export const a = 1;\n',
  });
  const r = run(dir, 'validate');
  assert.doesNotMatch(bloqueantes(r.stdout), /\[hexagonal\]/);
  assert.match(r.stdout, /\[hexagonal\][^\n]*hexagonal --plan/);
});

test('validate: repo documental sin ARCHITECTURE.md no dice nada de la hexagonal', () => {
  const r = run(repoCon({}), 'validate');
  assert.doesNotMatch(r.stdout, /hexagonal/i);
});

// ---------- /faro:code y revisores: la hexagonal se propone al nacer el codigo y se exige al revisar ----------

const leer = (...p) => fs.readFileSync(path.join(RAIZ, 'plugins', 'faro', ...p), 'utf8');

test('/faro:code scaffoldea hexagonal y la plantilla de ARCHITECTURE.md trae la seccion', () => {
  const s = leer('skills', 'code', 'SKILL.md');
  assert.match(s, /## Hexagonal/);
  for (const c of ['dominio/', 'aplicacion/', 'puertos/', 'adaptadores/']) assert.ok(s.includes(c), `falta ${c}`);
  assert.match(s, /harness\.js" hexagonal/);
});

test('revisor-code y revisor-code-worker ejecutan harness.js hexagonal y la violacion es bloqueante', () => {
  for (const a of ['revisor-code.md', 'revisor-code-worker.md']) {
    const t = leer('agents', a);
    assert.match(t, /harness\.js" hexagonal/, a);
    assert.match(t, /bloqueante/i, a);
  }
  assert.match(leer('agents', 'revisor-code-worker.md'), /bindings[^\n]*adaptador/i);
});
