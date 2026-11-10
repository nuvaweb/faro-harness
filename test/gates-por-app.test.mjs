// #130 — GATES POR APP: en un monorepo, FARO ejecuta los gates (typecheck/lint/test/build y el
// simulacro de despliegue de cada worker) de las apps que toca el cambio, y la bateria completa solo
// para publicar/consolidar.
//
// Las apps AFECTADAS salen del diff contra la rama base (origin/develop o develop) mas lo que este
// sin commitear, cruzado con lib/apps.js, y se amplian con sus DEPENDIENTES del workspace (quien
// declara la app tocada como dependencia 'workspace:'). Un cambio solo de raiz/gestion no corre gates
// de apps; uno que toca el package.json, el lockfile o el pnpm-workspace.yaml de la raiz, todas.
//
// El fixture es el monorepo pnpm de test/monorepo-apps.test.mjs (api worker + web front + paquete
// compartido), con scripts que dejan un MARCADOR en la carpeta de la app: asi se comprueba que se
// ejecuto y que no.
//
// Y el reverso: un repo simple corre sus gates exactamente igual que antes.
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
const codeModule = require(path.join(HOOKS, 'lib', 'code.js'));

const HAY_PNPM = spawnSync('pnpm', ['--version'], { encoding: 'utf8', shell: true, windowsHide: true }).status === 0;
const SIN_PNPM = HAY_PNPM ? false : 'pnpm no esta instalado en esta maquina';

const escribir = (dir, rel, txt) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, txt);
};
const git = (cwd, ...a) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const harness = (dir, ...args) => {
  const r = spawnSync(process.execPath, [HARNESS, ...args], { cwd: dir, encoding: 'utf8', timeout: 240000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  return { out: r.stdout + r.stderr, status: r.status };
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

// Script que deja '.marca-<nombre>' en la carpeta donde corre (la de la app).
const marca = (nombre) => `node -e "require('fs').writeFileSync('.marca-${nombre}','1')"`;

// Monorepo pnpm de test/monorepo-apps.test.mjs, con scripts-marcador y git: 'develop' con la base y
// una rama de trabajo encima. 'web' depende del paquete compartido; 'api' no.
function monorepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-gates-app-'));
  escribir(dir, 'ESTADO.md', ESTADO);
  escribir(dir, 'documentos/funcional/f.md', '# F\n## Fuera de alcance\n- Nada mas\n');
  escribir(dir, 'package.json', JSON.stringify({ name: 'mono', private: true, scripts: { test: marca('raiz') } }));
  escribir(dir, 'pnpm-workspace.yaml', '# workspace\npackages:\n  - "apps/*"\n  - \'packages/*\'\n\n# sin node_modules en el fixture: que pnpm no intente instalar antes de cada run\nverifyDepsBeforeRun: false\n');
  escribir(dir, '.gitignore', 'node_modules/\n.marca-*\npnpm-lock.yaml\n');
  escribir(dir, 'apps/api/package.json', JSON.stringify({
    name: 'mono-api', version: '1.2.0', devDependencies: { wrangler: '^4.40.0' },
    scripts: { test: marca('test'), lint: marca('lint'), 'deploy:dry': marca('dry'), 'cf-typegen': 'wrangler types' },
  }));
  escribir(dir, 'apps/api/wrangler.jsonc', '{\n  // worker\n  "name": "mono-api",\n  "main": "src/index.ts",\n}\n');
  escribir(dir, 'apps/api/ARCHITECTURE.md', '# Arquitectura\n');
  escribir(dir, 'apps/api/CLAUDE.md', '# api\n');
  escribir(dir, 'apps/api/src/index.ts', 'export default {};\n');
  escribir(dir, 'apps/web/package.json', JSON.stringify({
    name: 'mono-web', version: '0.3.0',
    dependencies: { '@tanstack/react-start': '^1.0.0', react: '^19.0.0', '@mono/shared': 'workspace:*' },
    devDependencies: { vite: '^7.0.0' },
    scripts: { test: marca('test'), 'deploy:dry': marca('dry') },
  }));
  escribir(dir, 'apps/web/wrangler.jsonc', '{ "name": "mono-web" }\n');
  escribir(dir, 'apps/web/CLAUDE.md', '# web\n');
  escribir(dir, 'apps/web/src/app.ts', 'export {};\n');
  escribir(dir, 'packages/shared/package.json', JSON.stringify({ name: '@mono/shared', version: '0.0.1', scripts: { test: marca('test') } }));
  escribir(dir, 'packages/shared/index.ts', 'export {};\n');
  escribir(dir, '.faro.json', JSON.stringify({
    teams: ['desarrollo'],
    monorepo: { apps: { api: { rol: 'API de metricas' }, web: { rol: 'Panel de operaciones' } } },
  }, null, 2));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'switch', '-q', '-c', 'develop');
  git(dir, 'switch', '-q', '-c', 'feat/1-algo');
  return dir;
}
// Commitea en la rama de trabajo un cambio en cada fichero indicado.
function tocar(dir, ...rels) {
  for (const r of rels) fs.appendFileSync(path.join(dir, r), '\n// cambio\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'cambio');
}
const ids = (alc) => alc.apps.map((a) => a.id);
const hay = (dir, app, m) => fs.existsSync(path.join(dir, app, `.marca-${m}`));

// ---------- alcance: que apps se ejecutan y por que ----------

test('alcance: un cambio solo en apps/api ejecuta solo api (no web ni shared)', () => {
  const dir = monorepo();
  tocar(dir, 'apps/api/src/index.ts');
  const alc = codeModule(dir).alcanceApps();
  assert.deepStrictEqual(ids(alc), ['api']);
  assert.match(alc.porque.api, /cambiada/i);
  assert.match(alc.resumen, /api/);
});

test('alcance: un cambio en un paquete compartido arrastra a sus DEPENDIENTES del workspace', () => {
  const dir = monorepo();
  tocar(dir, 'packages/shared/index.ts');
  const alc = codeModule(dir).alcanceApps();
  assert.deepStrictEqual(ids(alc).sort(), ['shared', 'web']);
  assert.match(alc.porque.web, /depende de shared/i);
});

test('alcance: lo que esta SIN COMMITEAR tambien cuenta (modificado o nuevo)', () => {
  const dir = monorepo();
  escribir(dir, 'apps/web/src/nuevo.ts', 'export {};\n');
  assert.deepStrictEqual(ids(codeModule(dir).alcanceApps()), ['web']);
});

test('alcance: un cambio solo de raiz/gestion no ejecuta gates de apps', () => {
  const dir = monorepo();
  tocar(dir, 'ESTADO.md');
  const alc = codeModule(dir).alcanceApps();
  assert.deepStrictEqual(ids(alc), []);
  assert.match(alc.resumen, /ninguna app/i);
});

test('alcance: tocar el package.json o el pnpm-workspace.yaml de la raiz ejecuta TODAS', () => {
  for (const f of ['package.json', 'pnpm-workspace.yaml']) {
    const dir = monorepo();
    if (f === 'package.json') {
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); p.description = 'x';
      fs.writeFileSync(path.join(dir, f), JSON.stringify(p));
      git(dir, 'commit', '-q', '-am', 'raiz');
    } else tocar(dir, f);
    const alc = codeModule(dir).alcanceApps();
    assert.deepStrictEqual(ids(alc), ['api', 'web', 'shared'], f);
    assert.match(alc.resumen, new RegExp(f.replace('.', '\\.')), alc.resumen);
  }
});

test('alcance: --todas fuerza todas y --app <id> fuerza esa', () => {
  const dir = monorepo();
  tocar(dir, 'apps/api/src/index.ts');
  const c = codeModule(dir);
  assert.deepStrictEqual(ids(c.alcanceApps({ todas: true })), ['api', 'web', 'shared']);
  assert.deepStrictEqual(ids(c.alcanceApps({ apps: ['web'] })), ['web']);
});

// ---------- ejecucion real: marcadores ----------

test('gates: tocar solo apps/api ejecuta los gates de api (test, lint y simulacro) y no los de web', { skip: SIN_PNPM }, () => {
  const dir = monorepo();
  tocar(dir, 'apps/api/src/index.ts');
  const r = harness(dir, 'gates');
  assert.strictEqual(r.status, 0, r.out);
  for (const m of ['test', 'lint', 'dry']) assert.ok(hay(dir, 'apps/api', m), `falta el marcador ${m} de api:\n${r.out}`);
  assert.ok(!hay(dir, 'apps/web', 'test'), `web NO debia ejecutarse:\n${r.out}`);
  assert.ok(!hay(dir, 'packages/shared', 'test'), `shared NO debia ejecutarse:\n${r.out}`);
  assert.ok(!fs.existsSync(path.join(dir, '.marca-raiz')), `los scripts de la RAIZ no son gates de app:\n${r.out}`);
  assert.match(r.out, /api · test: OK/, r.out);
  assert.match(r.out, /Apps: api \(cambiada\)/, r.out);
});

test('gates --todas (lo que usan publicar y consolidar) ejecuta los de todas las apps', { skip: SIN_PNPM }, () => {
  const dir = monorepo();
  tocar(dir, 'apps/api/src/index.ts');
  const r = harness(dir, 'gates', '--todas');
  assert.strictEqual(r.status, 0, r.out);
  for (const app of ['apps/api', 'apps/web', 'packages/shared']) assert.ok(hay(dir, app, 'test'), `falta ${app}:\n${r.out}`);
  assert.ok(hay(dir, 'apps/web', 'dry'), 'el simulacro de despliegue corre en cada app con worker');
});

test('validate --todas ejecuta los gates de todas las apps; --gates, solo las afectadas; a secas, ninguno (#167)', { skip: SIN_PNPM }, () => {
  const dir = monorepo();
  tocar(dir, 'apps/web/src/app.ts');
  harness(dir, 'validate');
  assert.ok(!hay(dir, 'apps/web', 'test'), 'validate a secas no corre gates');
  harness(dir, 'validate', '--gates');
  assert.ok(hay(dir, 'apps/web', 'test'));
  assert.ok(!hay(dir, 'apps/api', 'test'), 'validate --gates solo corre las afectadas');
  const v = harness(dir, 'validate', '--todas');
  assert.ok(hay(dir, 'apps/api', 'test'), v.out);
  assert.match(v.out, /Gates por app: todas/i, v.out);
});

test('publicar valida con --todas (la bateria completa); consolidar, lo que tocan sus ramas (#226); terminar, solo las afectadas', () => {
  const src = fs.readFileSync(HARNESS, 'utf8').replace(/\r\n/g, '\n');
  const cuerpo = (fn) => { const i = src.indexOf(`function ${fn}(`); assert.ok(i > 0, fn); return src.slice(i, src.indexOf('\n}\n', i)); };
  assert.doesNotMatch(cuerpo('cmdConsolidar'), /\[__filename, 'validate', '--todas'\]/);
  assert.match(cuerpo('cmdConsolidar'), /argsValidate\(/);
  assert.match(cuerpo('cmdPublicar'), /\[__filename, 'validate', '--todas'\]/);
  assert.doesNotMatch(cuerpo('cmdTerminar'), /'validate', '--todas'/);
});

test('un gate que falla en una app dice EN QUE APP falla', { skip: SIN_PNPM }, () => {
  const dir = monorepo();
  const p = path.join(dir, 'apps/api/package.json');
  const pkg = JSON.parse(fs.readFileSync(p, 'utf8')); pkg.scripts.test = 'node -e "process.exit(3)"';
  fs.writeFileSync(p, JSON.stringify(pkg));
  git(dir, 'commit', '-q', '-am', 'rompe');
  const r = harness(dir, 'gates');
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /api · test: FALLA/, r.out);
});

// ---------- dependencias conscientes del workspace ----------

test('deps en monorepo: --filter por app, -w solo para la raiz, outdated -r y cf-typegen por worker', () => {
  const dir = monorepo();
  const txt = codeModule(dir).depsLines().join('\n');
  assert.match(txt, /pnpm outdated -r/, txt);
  assert.match(txt, /pnpm --filter mono-api add -D wrangler@latest/, txt);
  assert.match(txt, /pnpm --filter mono-api run cf-typegen/, txt);
  assert.match(txt, /pnpm --filter mono-web exec wrangler types/, txt);
  assert.match(txt, /pnpm add -Dw /, txt);
  // NINGUNA sugerencia de instalacion en la raiz sin --filter ni -w (ERR_PNPM_ADDING_TO_ROOT).
  for (const l of txt.split('\n')) {
    if (/pnpm (add|up|update)\b/.test(l)) assert.match(l, /--filter|-w\b|-Dw\b| -r\b/, `sugerencia en la raiz sin --filter/-w: ${l}`);
  }
});

// ---------- isDeployCmd ----------
// Guarda que falla CERRADA y SIN EXENCIONES: toda orden de despliegue, tambien de pruebas o
// simulacro, pide aprobacion. Las listas blancas se podian burlar ('--dry-run --dry-run=false', un
// script 'deploy:dev' que despliega a produccion), asi que no hay ninguna.

test('isDeployCmd: toda orden de despliegue pide aprobacion, tambien de pruebas o simulacro', () => {
  const c = codeModule(monorepo());
  for (const cmd of [
    // antes exentas: ya no
    'wrangler deploy --dry-run --dry-run=false',
    'pnpm run deploy:dev',
    'pnpm deploy:dev', 'npm run deploy:dev', 'pnpm --filter mono-api run deploy:staging', 'pnpm deploy:dry',
    'pnpm --filter mono-api run deploy:dry-run', 'yarn deploy:preview', 'pnpm -F @mono/api deploy:qa',
    'wrangler deploy --dry-run', 'npx wrangler deploy --env staging --dry-run --outdir dist', 'pnpm exec wrangler deploy --dry-run',
    // produccion
    'pnpm deploy', 'pnpm run deploy', 'npm run deploy:prod', 'pnpm run deploy:production', 'pnpm --filter mono-api run deploy', 'npx wrangler deploy',
    // compuestas, comillas, comentarios
    'pnpm deploy:dev && wrangler deploy', 'pnpm run deploy:dev; pnpm --filter api deploy', 'wrangler deploy # deploy:dev',
    'wrangler deploy --dry-run; wrangler deploy', 'npx wrangler deploy --dry-run\nnpx wrangler deploy', 'pnpm deploy:dry || pnpm run deploy',
    'env A=" #" wrangler deploy', "FOO=' #' pnpm run deploy", 'wrangler deploy --var A:--dry', 'wrangler deploy --name x--dry-run',
    'wrangler deploy --var "x --dry-run"', 'echo hola # wrangler deploy', 'npx wrangler@latest deploy', '"wrangler" deploy',
    'pnpm -r run deploy', 'npm run-script deploy', 'pnpm run deploy:dev:prod', 'wrangler deploy --var "sin cerrar',
    // sub-shells, sustituciones, variables
    'bash -c "wrangler deploy"', "sh -c 'pnpm deploy'", 'pwsh -Command "pnpm run deploy"', 'eval "$X deploy"',
    'echo $(wrangler deploy)', 'echo `pnpm deploy`', '$CMD deploy',
    // continuaciones de linea (bash y PowerShell), mayusculas, otras herramientas
    'wrangler \\\ndeploy', 'wrangler `\r\ndeploy', 'npx wrangler \\\r\n  deploy --env production',
    'WRANGLER DEPLOY', 'bun run deploy', 'deno task deploy', 'yarn workspace api versions deploy',
  ]) assert.strictEqual(c.isDeployCmd(cmd), true, JSON.stringify(cmd));
  for (const cmd of ['git status', 'git commit -m "explica el deploy"', 'pnpm test', 'wrangler types']) {
    assert.strictEqual(c.isDeployCmd(cmd), false, JSON.stringify(cmd));
  }
});

test('isDeployCmd sigue dormido en un repo documental', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-doc-'));
  escribir(dir, '.faro.json', JSON.stringify({ naturaleza: 'documental' }));
  assert.strictEqual(codeModule(dir).isDeployCmd('wrangler deploy'), false);
});

// ---------- CI generado ----------

test('ci en monorepo (GitHub): un job con pnpm install --frozen-lockfile y --filter de lo cambiado', () => {
  const dir = monorepo();
  git(dir, 'remote', 'add', 'origin', 'git@github.com:org/mono.git');
  const r = harness(dir, 'ci');
  assert.strictEqual(r.status, 0, r.out);
  const yml = fs.readFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(yml, /pnpm install --frozen-lockfile/, yml);
  assert.match(yml, /fetch-depth: 0/, 'el filtro por cambios necesita la historia');
  assert.match(yml, /--filter=\.\.\.\[origin\//, yml);
  assert.match(yml, /pnpm -r \$FARO_FILTRO --if-present run test/, yml);
  assert.match(yml, /pnpm --filter mono-api run deploy:dry/, yml);
  assert.doesNotMatch(yml, /- run: pnpm run test$/m, 'no corre el test de la raiz');
});

test('ci en monorepo (GitLab): mismo filtro, calculado con la rama destino de la peticion', () => {
  const dir = monorepo();
  git(dir, 'remote', 'add', 'origin', 'git@gitlab.com:grupo/mono.git');
  const r = harness(dir, 'ci');
  assert.strictEqual(r.status, 0, r.out);
  const yml = fs.readFileSync(path.join(dir, '.gitlab-ci.yml'), 'utf8');
  assert.match(yml, /pnpm install --frozen-lockfile/, yml);
  assert.match(yml, /CI_MERGE_REQUEST_TARGET_BRANCH_NAME/, yml);
  assert.match(yml, /GIT_DEPTH: '0'/, yml);
  assert.match(yml, /pnpm -r \$FARO_FILTRO --if-present run test/, yml);
});

// ---------- no regresion: repo simple ----------

test('NO REGRESION: un repo simple corre sus scripts en la raiz con los mismos nombres de siempre', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-gates-simple-'));
  escribir(dir, 'package.json', JSON.stringify({ name: 'simple', scripts: { test: marca('test'), lint: marca('lint') } }));
  const c = codeModule(dir);
  assert.strictEqual(c.mode(), 'generic');
  const res = c.gateResults();
  assert.deepStrictEqual(res.map(([n]) => n), ['lint', 'test']);
  assert.ok(res.every(([, r]) => r.status === 'pass'), JSON.stringify(res));
  assert.ok(fs.existsSync(path.join(dir, '.marca-test')));
  assert.deepStrictEqual(c.ciPlan().gates.map((g) => g.run), ['npm run lint', 'npm run test']);
  assert.match(c.depsLines().join('\n'), /npm outdated$/m);
  assert.strictEqual(c.isDeployCmd('npm run deploy'), true);
});

// #208: un gate cortado por tiempo NO es un fallo del codigo. Antes, en un repo de una sola app salia
// "[gates] test: FALLA" con la salida parcial (todo en verde) y el agente relanzaba la suite entera
// buscando un fallo que no existia. Y faro.timeout-app solo se leia en un monorepo.
test('#208: un gate cortado por tiempo en un repo de una sola app sale como TIEMPO AGOTADO (no FALLA) y respeta faro.timeout-app', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-gates-tiempo-'));
  escribir(dir, 'ESTADO.md', ESTADO);
  escribir(dir, 'documentos/funcional/f.md', '# F\n## Fuera de alcance\n- Nada mas\n');
  escribir(dir, 'package.json', JSON.stringify({ name: 'lento', scripts: { test: 'node -e "setTimeout(()=>{},30000)"' } }));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'faro.timeout-app', '2');
  const [, r] = codeModule(dir).gateResults().find(([n]) => n === 'test');
  assert.strictEqual(r.status, 'fail', JSON.stringify(r));
  assert.strictEqual(r.timeout, true, JSON.stringify(r));
  assert.match(r.out, /tiempo agotado \(2 s\)/, r.out);
  assert.match(r.out, /git config faro\.timeout-app <segundos>/, r.out);
  const h = harness(dir, 'gates');
  assert.strictEqual(h.status, 1, h.out);
  assert.match(h.out, /test: TIEMPO AGOTADO \(2 s\)/, h.out);
  assert.doesNotMatch(h.out, /test: FALLA/, h.out);
});

// #182: los gates gobernados escriben turnos y cache en el directorio privado del usuario: en los tests, a un temporal.
process.env.FARO_PROC_DIR = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "faro-proc-t-"));
process.env.FARO_MEM_MIN_MB = "0";   // estos tests prueban la logica de los gates, no la memoria de la maquina
