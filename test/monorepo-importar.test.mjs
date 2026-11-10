// #162 — harness.js monorepo importar: levantar un FARO nuevo e IMPORTAR repos existentes como apps,
// con su historial y con su gestion consolidada en la raiz (caso acme-aiops, hoy hecho a mano).
//
// Garantias fijadas aqui (todo con repos git temporales, sin red):
//   - dry-run por defecto: trae el origen a un directorio temporal, muestra el plan y no toca nada;
//   - el origen NO se modifica jamas (solo lectura) y no se ejecuta nada de el;
//   - `git log --follow` conserva el historial de los ficheros importados;
//   - riesgos/requisitos renumerados por origen (+100, +200) y doc_id conservados;
//   - ids, ramas y origenes validados con patron estricto: organizacion distinta, opciones de git y
//     formas raras se rechazan ANTES de tocar nada;
//   - idempotente: reimportar no duplica; --actualizar trae lo nuevo.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(RAIZ, 'plugins', 'faro', 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');
const require = createRequire(import.meta.url);
const apps = require(path.join(HOOKS, 'lib', 'apps.js'));
const mp = require(path.join(HOOKS, 'lib', 'monorepo-plan.js'));

const w = (dir, rel, txt) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };
const r = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8').replace(/\r\n/g, '\n');
const hay = (dir, rel) => fs.existsSync(path.join(dir, rel));
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const harness = (cwd, ...a) => spawnSync(process.execPath, [HARNESS, ...a], { cwd, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: cwd } });

const ESTADO = (nombre) => `---
iniciativa: ${nombre}
fases_total: 2
fase_actual: 2
owner: t
funcional: documentos/funcional/f.md
---

### Fase 1 · Cimientos — done
Hecho.
- [x] #3 · Base — @t

### Fase 2 · Paneles — in_progress
En curso.
- [ ] #7 · Panel — @t (cubre REQ-02 y R-01)
`;

// Un repo ORIGEN con codigo, historial de 2 commits y su propia gestion FARO.
function origen(nombre, clave) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `faro-orig-${nombre}-`));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'remote', 'add', 'origin', `https://github.com/acme-org/${nombre}.git`);
  w(dir, 'ESTADO.md', ESTADO(nombre));
  w(dir, 'package.json', JSON.stringify({ name: nombre, version: '0.4.0', scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(\'PWNED\',\'x\')"' } }));
  w(dir, 'src/index.ts', `// implementa REQ-02 (${nombre})\nexport const a = 1;\n`);
  w(dir, 'gestion/risks.md', '# Riesgos\n| ID | Tipo | Descripcion | Prob/Imp | Mitigacion | Estado |\n|----|------|-------------|----------|------------|--------|\n| R-01 | riesgo | Latencia | M/A | Cache (REQ-01) | abierto |\n');
  w(dir, 'gestion/requisitos.md', '# Requisitos\n## REQ-01 · Medir\nestado: aceptado\norigen: reunion\n\n## REQ-02 · Panel\nestado: propuesto\norigen: reunion\n');
  w(dir, `documentos/funcional/${nombre}.md`, `---\ndoc_id: ${clave}-FUN-001\ntitle: F\nstatus: aprobado\n---\nCubre REQ-02. Ver #7.\n`);
  w(dir, '.gitignore', 'node_modules\n/dist\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'primero');
  w(dir, 'src/index.ts', `// implementa REQ-02 (${nombre})\nexport const a = 2;\n`);
  git(dir, 'commit', '-qam', 'segundo');
  return dir;
}

// El FARO NUEVO (repo contenedor): gestion minima, en una rama de trabajo anclada a un issue.
function contenedor({ rama = 'feat/162-importar', remote = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-cont-'));
  git(dir, 'init', '-q', '-b', 'main');
  if (remote) git(dir, 'remote', 'add', 'origin', 'https://github.com/acme-org/faro-contenedor-test.git');
  w(dir, 'ESTADO.md', ESTADO('Contenedor').replace('REQ-02 y R-01', 'nada'));
  w(dir, 'documentos/funcional/f.md', '# F\n## Fuera de alcance\n- Nada mas\n');
  w(dir, 'gestion/risks.md', '# Riesgos\n| ID | Tipo | Descripcion | Prob/Imp | Mitigacion | Estado |\n|----|------|-------------|----------|------------|--------|\n| R-01 | riesgo | De la raiz | M/M | - | abierto |\n');
  w(dir, 'gestion/requisitos.md', '# Requisitos\n## REQ-01 · De la raiz\nestado: aceptado\norigen: x\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'inicial');
  if (rama) git(dir, 'switch', '-q', '-c', rama);
  return dir;
}

const estadoOrigen = (o) => ({ head: git(o, 'rev-parse', 'HEAD').trim(), status: git(o, 'status', '--porcelain'), refs: git(o, 'for-each-ref'), ramas: git(o, 'branch', '--list') });

test('dry-run por defecto: trae el origen a un temporal, muestra el plan y no toca ni la raiz ni el origen', () => {
  const o = origen('api', 'API'); const c = contenedor();
  const antesO = estadoOrigen(o); const antesC = git(c, 'status', '--porcelain'); const headC = git(c, 'rev-parse', 'HEAD');
  const s = harness(c, 'monorepo', 'importar', o, '--app', 'api', '--rol', 'API de metricas');
  assert.strictEqual(s.status, 0, s.stderr + s.stdout);
  assert.match(s.stdout, /DRY-RUN/i);
  assert.match(s.stdout, /apps\/api/);
  assert.match(s.stdout, /REQ-01 → REQ-101/); assert.match(s.stdout, /R-01 → R-101/);
  assert.match(s.stdout, /fusion-faseo:api/);
  assert.match(s.stdout, /--confirmo/);
  assert.strictEqual(git(c, 'status', '--porcelain'), antesC);
  assert.strictEqual(git(c, 'rev-parse', 'HEAD'), headC);
  assert.ok(!hay(c, 'apps'));
  assert.deepStrictEqual(estadoOrigen(o), antesO, 'el origen queda EXACTAMENTE como estaba');
  assert.ok(!hay(o, 'PWNED'));
});

test('--confirmo: importa dos origenes con historial, consolida su gestion (+100/+200) y valida', () => {
  const a = origen('api', 'API'); const b = origen('panel', 'PAN'); const c = contenedor();
  const antes = [estadoOrigen(a), estadoOrigen(b)];
  const s = harness(c, 'monorepo', 'importar', a, '--app', 'api', b, '--app', 'panel', '--rol', 'App importada', '--confirmo');
  assert.strictEqual(s.status, 0, s.stderr + s.stdout);
  // codigo con historial: git log --follow atraviesa la importacion
  assert.ok(hay(c, 'apps/api/src/index.ts') && hay(c, 'apps/panel/src/index.ts'));
  const hist = git(c, 'log', '--follow', '--format=%s', '--', 'apps/api/src/index.ts');
  assert.match(hist, /primero/); assert.match(hist, /segundo/);
  // el origen intacto y sin ejecutar nada
  assert.deepStrictEqual([estadoOrigen(a), estadoOrigen(b)], antes);
  assert.ok(!hay(c, 'PWNED') && !hay(c, 'apps/api/PWNED') && !hay(a, 'PWNED'));
  // gestion consolidada: api +100, panel +200; doc_id conservados; historico archivado
  const reqs = r(c, 'gestion/requisitos.md');
  assert.match(reqs, /## REQ-01 · De la raiz/);
  assert.match(reqs, /## REQ-101 · Medir/); assert.match(reqs, /## REQ-201 · Medir/);
  assert.match(r(c, 'gestion/risks.md'), /\| R-101 \|[\s\S]*\| R-201 \|/);
  assert.match(r(c, 'documentos/funcional/api.md'), /doc_id: API-FUN-001/);
  assert.ok(hay(c, 'gestion/historico/ESTADO-API-api.md') && hay(c, 'gestion/historico/ESTADO-PAN-panel.md'));
  assert.match(r(c, 'apps/api/src/index.ts'), /REQ-102/);
  // el ESTADO de la raiz no se toca (la fusion de faseos es una decision)
  assert.match(r(c, 'ESTADO.md'), /iniciativa: Contenedor/);
  // monorepo declarado y workspace
  assert.ok(apps.esMonorepo(c)); assert.deepStrictEqual(apps.apps(c).map((x) => x.id).sort(), ['api', 'panel']);
  assert.ok(hay(c, 'pnpm-workspace.yaml'));
  assert.match(r(c, '.gitignore'), /\/apps\/api\/dist/);
  // trazabilidad en el plan
  const plan = JSON.parse(r(c, 'gestion/monorepo-plan.json'));
  const pa = plan.apps.find((x) => x.id === 'api');
  assert.strictEqual(pa.origen.fuente, 'acme-org/api', 'el plan guarda org/repo, nunca la ruta local'); assert.strictEqual(pa.origen.modo, 'subtree'); assert.match(pa.origen.commit, /^[0-9a-f]{40}$/);
  assert.strictEqual(pa.desplazamiento, 100); assert.strictEqual(plan.apps.find((x) => x.id === 'panel').desplazamiento, 200);
  assert.deepStrictEqual(mp.validarPlan(plan, {}), []);
  // ninguna referencia colgante
  const mg = require(path.join(HOOKS, 'lib', 'monorepo-gestion.js'));
  assert.deepStrictEqual(mg.referenciasColgantes(c, ['gestion', 'documentos']), []);
  // lo importado queda commiteado (merge) y lo consolidado en el indice, sin cambios sueltos sin versionar
  assert.strictEqual(git(c, 'status', '--porcelain').split('\n').filter((l) => l.startsWith('??')).length, 0);
  const v = harness(c, 'validate');
  assert.doesNotMatch(v.stdout, /sin declarar|no existe en el workspace|monorepo-plan/);
});

test('idempotente: reimportar no duplica; --actualizar trae lo nuevo del origen', () => {
  const a = origen('api', 'API'); const c = contenedor();
  assert.strictEqual(harness(c, 'monorepo', 'importar', a, '--app', 'api', '--rol', 'API', '--confirmo').status, 0);
  assert.strictEqual(git(c, 'status', '--porcelain'), '', 'importar deja todo commiteado');
  const head = git(c, 'rev-parse', 'HEAD');
  const again = harness(c, 'monorepo', 'importar', a, '--app', 'api', '--rol', 'API', '--confirmo');
  assert.strictEqual(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /ya importada|--actualizar/);
  assert.strictEqual(git(c, 'rev-parse', 'HEAD'), head); assert.strictEqual(git(c, 'status', '--porcelain'), '');
  // el origen avanza
  w(a, 'src/nuevo.ts', 'export const n = 1;\n'); git(a, 'add', '-A'); git(a, 'commit', '-qm', 'tercero');
  const up = harness(c, 'monorepo', 'importar', a, '--app', 'api', '--actualizar', '--confirmo');
  assert.strictEqual(up.status, 0, up.stdout + up.stderr);
  assert.ok(hay(c, 'apps/api/src/nuevo.ts'));
  assert.match(git(c, 'log', '--format=%s', '--', 'apps/api/src/nuevo.ts'), /tercero|actualiza|importa/i);
  assert.strictEqual(r(c, 'gestion/requisitos.md').match(/## REQ-101/g).length, 1, 'no se vuelve a consolidar');
});

test('modo copia: sin historial, con el origen y el commit documentados en el plan', () => {
  const a = origen('api', 'API'); const c = contenedor();
  const s = harness(c, 'monorepo', 'importar', a, '--app', 'api', '--rol', 'API', '--modo', 'copia', '--confirmo');
  assert.strictEqual(s.status, 0, s.stdout + s.stderr);
  assert.ok(hay(c, 'apps/api/src/index.ts')); assert.ok(!hay(c, 'apps/api/.git'));
  assert.doesNotMatch(git(c, 'log', '--format=%s', '--', 'apps/api/src/index.ts'), /primero/);
  const plan = JSON.parse(r(c, 'gestion/monorepo-plan.json'));
  assert.strictEqual(plan.apps[0].origen.modo, 'copia');
  assert.strictEqual(plan.apps[0].origen.commit, git(a, 'rev-parse', 'HEAD').trim());
});

test('un plan con un origen en ruta local se rechaza (desde el plan solo org/repo o URL de GitHub)', () => {
  const a = origen('api', 'API'); const c = contenedor();
  w(c, 'gestion/monorepo-plan.json', JSON.stringify({ version: 1, apps: [{ id: 'api', rol: 'API', origen: { fuente: a, rama: 'main' } }] }));
  git(c, 'add', '-A'); git(c, 'commit', '-qm', 'plan');
  const s = harness(c, 'monorepo', 'importar', '--confirmo');
  assert.notStrictEqual(s.status, 0); assert.match(s.stdout + s.stderr, /fuente|rutas locales/i);
  assert.ok(!hay(c, 'apps'));
});

test('rechaza origenes peligrosos o de otra organizacion y no toca nada', () => {
  const c = contenedor();
  const o = origen('api', 'API');
  git(o, 'remote', 'set-url', 'origin', 'https://github.com/otra-org/api.git');
  const sinRemote = origen('x', 'X'); git(sinRemote, 'remote', 'remove', 'origin');
  const antes = git(c, 'status', '--porcelain'); const head = git(c, 'rev-parse', 'HEAD');
  const casos = [
    [['otra-org/api', '--app', 'api'], /organizaci/i],
    [['https://github.com/otra-org/api.git', '--app', 'api'], /organizaci/i],
    [[o, '--app', 'api'], /organizaci/i],                          // ruta local cuyo remote es de otra org
    [[sinRemote, '--app', 'api'], /remote/i],                      // local sin remote: no se puede comprobar la organizacion
    [['\\\\host\\share\\repo', '--app', 'api'], /UNC|origen/i],
    [['//host/share/repo', '--app', 'api'], /UNC|origen/i],
    [['--upload-pack=touch x', '--app', 'api'], /origen|opci|forma/i],
    [['ext::sh -c touch% pwned', '--app', 'api'], /origen/i],
    [['git@github.com:acme-org/x.git', '--app', 'api'], /origen/i],
    [['file:///etc/passwd', '--app', 'api'], /origen/i],
    [['acme-org/x', '--app', '../x'], /inválid|invalid/i],
    [['acme-org/x', '--app', '--foo'], /inválid|invalid|necesita/i],
    [['acme-org/x', '--app', 'api', '--rama', '--all'], /rama/i],
    [['acme-org/x', '--app', 'api', '--modo', 'magia'], /modo/i],
  ];
  for (const [args, re] of casos) {
    const s = harness(c, 'monorepo', 'importar', ...args, '--rol', 'API', '--confirmo');
    assert.notStrictEqual(s.status, 0, args.join(' '));
    assert.match(s.stdout + s.stderr, re, args.join(' '));
  }
  assert.strictEqual(git(c, 'status', '--porcelain'), antes); assert.strictEqual(git(c, 'rev-parse', 'HEAD'), head);
  assert.ok(!hay(c, 'apps'));
});

test('enlacesEnIndice (logica pura): detecta el modo 120000 en la salida de git ls-files -s', () => {
  const imp = require(path.join(HOOKS, 'lib', 'monorepo-importar.js'));
  const nul = String.fromCharCode(0);
  const salida = ['100644 abc 0	src/a.ts', '120000 def 0	ESTADO.md', '100755 123 0	bin/x', '120000 456 0	docs', ''].join(nul);
  assert.deepStrictEqual(imp.enlacesEnIndice(salida), ['ESTADO.md', 'docs']);
  assert.deepStrictEqual(imp.enlacesEnIndice(''), []);
});

test('un origen con symlinks se rechaza sin tocar la raiz', { skip: (() => { try { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-sl-')); fs.writeFileSync(path.join(d, 'a'), 'x'); fs.symlinkSync(path.join(d, 'a'), path.join(d, 'l')); return false; } catch { return 'esta maquina no puede crear symlinks sin privilegios'; } })() }, () => {
  const o = origen('api', 'API'); const c = contenedor();
  fs.writeFileSync(path.join(o, 'secreto.txt'), 'TOKEN');
  fs.symlinkSync(path.join(o, 'secreto.txt'), path.join(o, 'enlace.md'));
  git(o, 'add', '-A'); git(o, 'commit', '-qm', 'enlace');
  const s = harness(c, 'monorepo', 'importar', o, '--app', 'api', '--rol', 'API', '--confirmo');
  assert.notStrictEqual(s.status, 0); assert.match(s.stdout, /enlace\(s\) simbólico/);
  assert.doesNotMatch(s.stdout + s.stderr, /TOKEN/);
  assert.ok(!hay(c, 'apps')); assert.strictEqual(git(c, 'status', '--porcelain'), '');
});

test('sin organizacion detectable no se importa nada (ni org/repo ni rutas locales)', () => {
  const c = contenedor({ remote: false });   // sin remote origin
  const s = harness(c, 'monorepo', 'importar', 'acme-org/x', '--app', 'api', '--rol', 'API', '--confirmo');
  assert.notStrictEqual(s.status, 0); assert.match(s.stdout + s.stderr, /organizaci/i);
  const l = harness(c, 'monorepo', 'importar', origen('api', 'API'), '--app', 'api', '--rol', 'API', '--confirmo');
  assert.notStrictEqual(l.status, 0); assert.match(l.stdout + l.stderr, /organizaci/i);
});

test('bloquea con arbol sucio o rama sin issue, y exige el rol de la app', () => {
  const o = origen('api', 'API');
  const sucio = contenedor(); w(sucio, 'notas.txt', 'x');
  const a = harness(sucio, 'monorepo', 'importar', o, '--app', 'api', '--rol', 'API', '--confirmo');
  assert.notStrictEqual(a.status, 0); assert.match(a.stdout + a.stderr, /limpio|sin versionar/i);
  const main = contenedor({ rama: null });
  const b = harness(main, 'monorepo', 'importar', o, '--app', 'api', '--rol', 'API', '--confirmo');
  assert.notStrictEqual(b.status, 0); assert.match(b.stdout + b.stderr, /rama de trabajo|issue/i);
  const c = contenedor();
  const d = harness(c, 'monorepo', 'importar', o, '--app', 'api', '--confirmo');
  assert.notStrictEqual(d.status, 0); assert.match(d.stdout + d.stderr, /rol/i);
  for (const x of [sucio, main, c]) assert.ok(!hay(x, 'apps'));
});

test('el origen en una rama concreta (--rama) y un origen inexistente falla sin dejar basura', () => {
  const o = origen('api', 'API');
  git(o, 'switch', '-q', '-c', 'develop'); w(o, 'src/solo-develop.ts', 'x\n'); git(o, 'add', '-A'); git(o, 'commit', '-qm', 'dev'); git(o, 'switch', '-q', 'main');
  const c = contenedor();
  assert.strictEqual(harness(c, 'monorepo', 'importar', o, '--app', 'api', '--rol', 'API', '--rama', 'develop', '--confirmo').status, 0);
  assert.ok(hay(c, 'apps/api/src/solo-develop.ts'));
  const c2 = contenedor();
  const mal = harness(c2, 'monorepo', 'importar', path.join(os.tmpdir(), 'no-existe-faro-xyz'), '--app', 'api', '--rol', 'API', '--confirmo');
  assert.notStrictEqual(mal.status, 0); assert.ok(!hay(c2, 'apps')); assert.strictEqual(git(c2, 'status', '--porcelain'), '');
});
