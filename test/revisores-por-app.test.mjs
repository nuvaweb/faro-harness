// #132 — skills y agentes CONSCIENTES DE APPS: en un monorepo el codigo vive en apps/<x>/src y el
// contrato en apps/<x>/ARCHITECTURE.md, no en la raiz. Todo lo que buscaba en la raiz se apagaba en
// silencio (el enlace cambio->ADR de validate, 'contrato', los revisores condicionados a ficheros de
// la raiz) o exigia lo que un monorepo no tiene (test/ en la raiz).
//
// Y el reverso: un repo simple se comporta exactamente como antes.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(RAIZ, 'plugins', 'faro');
const HOOKS = path.join(PLUGIN, 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');
const require = createRequire(import.meta.url);
const codeModule = require(path.join(HOOKS, 'lib', 'code.js'));

const escribir = (dir, rel, txt) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, txt);
};
const harness = (dir, ...args) => {
  const r = spawnSync(process.execPath, [HARNESS, ...args], { cwd: dir, encoding: 'utf8', timeout: 60000, input: '', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  return { out: (r.stdout || '') + (r.stderr || ''), status: r.status, stdout: r.stdout || '' };
};

const ESTADO = `---
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
`;

const DECLARADO = {
  teams: ['desarrollo'],
  monorepo: {
    apps: {
      api: { rol: 'API de metricas', funcional: 'MONO-FUN-001', equipo: 'desarrollo' },
      web: { rol: 'Panel', funcional: 'MONO-FUN-002', equipo: 'desarrollo' },
    },
  },
};

// Monorepo pnpm: apps/api (worker con contrato y tests/), apps/web (worker sin contrato, tests
// colocados), apps/batch (sin tests). Sin src/ ni ARCHITECTURE.md en la raiz.
function monorepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-rev-mono-'));
  escribir(dir, 'ESTADO.md', ESTADO);
  escribir(dir, 'documentos/funcional/f.md', '# F\n## Fuera de alcance\n- Nada mas\n');
  escribir(dir, 'package.json', JSON.stringify({ name: 'mono', private: true }));
  escribir(dir, 'pnpm-workspace.yaml', 'packages:\n  - "apps/*"\n');
  escribir(dir, '.faro.json', JSON.stringify({ ...DECLARADO, monorepo: { apps: { ...DECLARADO.monorepo.apps, batch: { rol: 'Proceso', funcional: 'MONO-FUN-003', equipo: 'desarrollo' } } } }, null, 2));
  escribir(dir, 'apps/api/package.json', JSON.stringify({ name: 'mono-api', version: '1.0.0' }));
  escribir(dir, 'apps/api/wrangler.jsonc', '{ "name": "mono-api" }\n');
  escribir(dir, 'apps/api/CLAUDE.md', '# api\n');
  escribir(dir, 'apps/api/ARCHITECTURE.md', '# Arquitectura api\n## API\n- GET /metricas — lista\n- POST /metricas — crea\n');
  escribir(dir, 'apps/api/src/index.ts', "app.get('/metricas', h);\napp.post('/metricas', h);\n");
  escribir(dir, 'apps/api/tests/api.test.ts', '\n');
  escribir(dir, 'apps/web/package.json', JSON.stringify({ name: 'mono-web', version: '0.1.0' }));
  escribir(dir, 'apps/web/wrangler.jsonc', '{ "name": "mono-web" }\n');
  escribir(dir, 'apps/web/CLAUDE.md', '# web\n');
  escribir(dir, 'apps/web/src/lib/util.test.ts', '\n');
  escribir(dir, 'apps/batch/package.json', JSON.stringify({ name: 'mono-batch', version: '0.1.0' }));
  escribir(dir, 'apps/batch/CLAUDE.md', '# batch\n');
  escribir(dir, 'apps/batch/src/index.ts', 'export {};\n');
  return dir;
}

function simple() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-rev-simple-'));
  escribir(dir, 'ESTADO.md', ESTADO);
  escribir(dir, 'documentos/funcional/f.md', '# F\n## Fuera de alcance\n- Nada mas\n');
  escribir(dir, 'package.json', JSON.stringify({ name: 'simple', version: '1.0.0' }));
  escribir(dir, '.faro.json', JSON.stringify({ teams: ['desarrollo'] }));
  escribir(dir, 'ARCHITECTURE.md', '# Arquitectura\n## API\n- GET /leads — lista\n');
  escribir(dir, 'src/index.ts', "app.get('/leads', h);\n");
  return dir;
}

// Un cambio de codigo SIN decision citada: validate debe exigir el ADR.
const PROPOSAL = `---
titulo: Algo de codigo
descripcion: x
estado: aprobada
fase: 1
owner: T
responsable: t@t
tareas: []
aprobada_por: T
---
## Por qué
Motivo suficientemente largo para el gate del harness, con contexto real del cambio.
## Qué cambia
- Algo
`;

// ---------- contrato por app ----------

test('contrato <app> lee apps/<x>/ARCHITECTURE.md y recorre apps/<x>/src', () => {
  const dir = monorepo();
  const r = harness(dir, 'contrato', 'api');
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /documentados: 2 · en codigo: 2 · coinciden: 2/, r.out);
});

test('contrato <app> detecta la deriva y nombra el contrato de ESA app', () => {
  const dir = monorepo();
  escribir(dir, 'apps/api/src/extra.ts', "app.delete('/metricas/:id', h);\n");
  const r = harness(dir, 'contrato', 'api');
  assert.match(r.out, /DERIVA DE CONTRATO/, r.out);
  assert.match(r.out, /apps\/api\/ARCHITECTURE\.md/, r.out);
});

test('contrato sin app en un monorepo recorre todas las apps con contrato', () => {
  const dir = monorepo();
  const r = harness(dir, 'contrato');
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /\bapi\b/, r.out);
  assert.match(r.out, /coinciden: 2/, r.out);
  assert.doesNotMatch(r.out, /Sin endpoints ni en la documentacion ni en src\//, r.out);
});

test('contrato con una app que no existe falla y lista las que hay', () => {
  const dir = monorepo();
  const r = harness(dir, 'contrato', 'nope');
  assert.notStrictEqual(r.status, 0, r.out);
  assert.match(r.out, /api/, r.out);
});

test('repo simple: contrato sigue leyendo ARCHITECTURE.md y src/ de la raiz', () => {
  const dir = simple();
  const r = harness(dir, 'contrato');
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /documentados: 1 · en codigo: 1 · coinciden: 1/, r.out);
});

// ---------- enlace cambio -> ADR ----------

test('monorepo: un cambio sin decision se senala aunque no haya src/ en la raiz', () => {
  const dir = monorepo();
  escribir(dir, 'gestion/cambios/changes/algo/proposal.md', PROPOSAL);
  const r = harness(dir, 'validate');
  assert.match(r.out, /\[ciclo\][^\n]*algo[^\n]*decisi/i, r.out);
});

test('repo simple con src/: el enlace cambio->ADR sigue exigiendose (sin regresion)', () => {
  const dir = simple();
  escribir(dir, 'gestion/cambios/changes/algo/proposal.md', PROPOSAL);
  const r = harness(dir, 'validate');
  assert.match(r.out, /\[ciclo\][^\n]*algo[^\n]*decisi/i, r.out);
});

test('monorepo sin ninguna app con src/: el enlace no aplica', () => {
  const dir = monorepo();
  for (const a of ['api', 'web', 'batch']) fs.rmSync(path.join(dir, 'apps', a, 'src'), { recursive: true, force: true });
  escribir(dir, 'gestion/cambios/changes/algo/proposal.md', PROPOSAL);
  const r = harness(dir, 'validate');
  assert.doesNotMatch(r.out, /\[ciclo\][^\n]*algo[^\n]*decisi/i, r.out);
});

// ---------- disciplina de tests ----------

test('monorepo: la disciplina de tests acepta tests/, test/ o colocados POR APP y senala las apps sin tests', () => {
  const dir = monorepo();
  const t = codeModule(dir).testDisciplineLines().join('\n');
  assert.doesNotMatch(t, /UNA carpeta raiz/, t);
  assert.match(t, /tests\//, t);
  assert.match(t, /\.test\.ts/, t);
  assert.match(t, /batch/, `debe senalar la app sin tests:\n${t}`);
  assert.doesNotMatch(t, /sin tests[^\n]*\b(api|web)\b/i, t);
});

test('repo simple: la disciplina de tests no cambia', () => {
  const dir = simple();
  const t = codeModule(dir).testDisciplineLines().join('\n');
  assert.match(t, /UNA carpeta raiz propia/, t);
});

// ---------- texto de sesion ----------

// Desde #127 el arranque ya no lista el catalogo de subagentes (lo da el prompt de sistema): la
// linea de revisores por app vive en el bloque de gobierno completo ('harness.js estado').
test('sesion en monorepo: revisor-code por app, sin condicionarlo a ARCHITECTURE.md de la raiz', () => {
  const dir = monorepo();
  const r = harness(dir, 'estado');
  assert.strictEqual(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /si el repo tiene ARCHITECTURE\.md/, r.out);
  assert.match(r.out, /revisor-code y revisor-code-worker se lanzan POR APP afectada[^\n]*apps\/<x>\/ARCHITECTURE\.md/, r.out);
});

test('sesion en repo simple: el texto de revisores no cambia', () => {
  const dir = simple();
  const r = harness(dir, 'estado');
  assert.strictEqual(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /POR APP afectada|^Monorepo:/m, 'un repo simple no habla de apps');
  assert.doesNotMatch(r.out, /revisor-code \(coherencia de codigo/, 'el catalogo de subagentes no se repite (#127)');
});

// ---------- coherencia de skills y agentes ----------

const leer = (rel) => fs.readFileSync(path.join(PLUGIN, rel), 'utf8');

for (const rel of ['skills/publicar/SKILL.md', 'skills/consolidar/SKILL.md', 'skills/pr/SKILL.md', 'skills/revisar-code/SKILL.md']) {
  test(`${rel}: en monorepo lanza revisor-code-worker por cada app worker afectada (harness.js apps)`, () => {
    const t = leer(rel);
    assert.match(t, /harness\.js"? apps --json/, `${rel} debe consultar las apps`);
    assert.match(t, /revisor-code-worker[^\n]*por cada app/i, `${rel} debe lanzar el worker por app`);
    assert.match(t, /monorepo/i, rel);
  });
}

for (const rel of ['skills/consolidar/SKILL.md', 'skills/pr/SKILL.md']) {
  test(`${rel}: el contrato se comprueba por app en monorepo`, () => {
    assert.match(leer(rel), /contrato <app>/, rel);
  });
}

test('revisor-code: en monorepo el contrato se busca por app y su ausencia no siempre bloquea', () => {
  const t = leer('agents/revisor-code.md');
  assert.match(t, /apps\/<x>\/ARCHITECTURE\.md/, t);
  assert.match(t, /harness\.js"? apps/, t);
  assert.match(t, /aviso/i, t);
});

test('revisor-code-worker: trabaja sobre la app que se le pasa', () => {
  const t = leer('agents/revisor-code-worker.md');
  assert.match(t, /apps\/<x>\//, t);
  assert.match(t, /monorepo/i, t);
});

test('redactor-tecnico: en monorepo lee el wrangler de la app', () => {
  const t = leer('agents/redactor-tecnico.md');
  assert.match(t, /monorepo/i, t);
  assert.match(t, /harness\.js"? apps/, t);
});

test('/faro:code: en monorepo andamia en apps/<nueva> con pnpm y la registra en .faro.json', () => {
  const t = leer('skills/code/SKILL.md');
  assert.match(t, /apps\/<nueva>/, t);
  assert.match(t, /pnpm create/, t);
  assert.match(t, /monorepo\.apps/, t);
  assert.match(t, /CLAUDE\.md/, t);
});
