// Wizard monorepo (#5): el alta pregunta "¿una app o monorepo?" y, en monorepo, deja cada app en
// apps/<id> copiada de su plantilla, en el MISMO commit inicial. Lo hace el propio CLI, SIN depender
// del plugin. Aquí se prueban las piezas puras y la instanciación con una plantilla FALSA (sin red).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NATURALEZAS } from '../bin/lib/model.mjs';
import {
  plantillasMonorepo, validarIdApp, appsDesdeFlags, payloadMeta, fusionarMeta,
  instanciarMonorepo, sinCredenciales,
} from '../bin/lib/monorepo.mjs';

const tmp = (pre) => fs.mkdtempSync(path.join(os.tmpdir(), pre));
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// Repo recién generado: un solo commit, como el que deja /generate.
function repoNuevo() {
  const d = tmp('faro-mono-');
  git(d, 'init', '-q', '-b', 'develop');
  git(d, 'config', 'user.email', 't@t'); git(d, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(d, '.faro.json'), JSON.stringify({ domain: 'ti' }, null, 2) + '\n');
  fs.writeFileSync(path.join(d, 'README.md'), '# repo\n');
  fs.writeFileSync(path.join(d, '.gitignore'), 'borrador/*\n.env\n');
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'init');
  return d;
}

// "Clonar" la plantilla: en real es un git clone con token; aquí un directorio con su contenido.
function clonarFalso(_app, dir) {
  const w = (rel, txt) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), txt); };
  w('package.json', JSON.stringify({ name: 'app', private: true, packageManager: 'pnpm@11.17.0', engines: { node: '>=24' }, scripts: { dev: 'vite dev' } }, null, 2) + '\n');
  w('wrangler.jsonc', '{ "name": "name-dev", "env": { "production": { "name": "name-prod" } } }\n');
  w('src/main.tsx', 'export {}\n');
  w('.node-version', '24\n');
  w('pnpm-workspace.yaml', '# solo config\npackages: []\n\nallowBuilds:\n  esbuild: true\n  workerd: true\n\nminimumReleaseAgeExclude:\n  - mi-ds\n');
  w('pnpm-lock.yaml', "lockfileVersion: '9.0'\nimporters:\n  .: {}\n");
  w('gestion/brainstorming/nota.md', '# de la plantilla\n');
  w('.gitignore', 'node_modules/\n.dev.vars\n');
  w('.git/HEAD', 'ref: refs/heads/main\n');
}
// Segunda plantilla, para probar que el workspace de la raíz junta la config de pnpm de todas.
function clonarApi(_app, dir) {
  clonarFalso(_app, dir);
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages: []\nallowBuilds:\n  esbuild: true\n  sharp: true\n');
}

// ---------- US-1 · catálogo, id y harness ----------
test('solo las plantillas con monorepo:true se ofrecen en monorepo', () => {
  const pl = plantillasMonorepo(NATURALEZAS.worker);
  assert.deepEqual(Object.keys(pl), ['tanstack-ui']);
  assert.deepEqual(plantillasMonorepo(NATURALEZAS.documental), {});
});

test('el catálogo remoto sin la marca monorepo hereda la del catálogo local', () => {
  const remoto = { plantillas: { 'tanstack-ui': { etiqueta: 'x', repo: 'TANSTACK-WORKER-UI' } } };
  assert.deepEqual(Object.keys(plantillasMonorepo(remoto)), ['tanstack-ui']);
  assert.equal(plantillasMonorepo(remoto)['tanstack-ui'].id, 'web');
});

test('--monorepo --plantilla=tanstack-ui crea la app con id web, sin preguntar', () => {
  const apps = appsDesdeFlags(NATURALEZAS.worker, 'tanstack-ui');
  assert.equal(apps.length, 1);
  assert.equal(apps[0].id, 'web');
  assert.equal(apps[0].plantilla, 'tanstack-ui');
  assert.equal(apps[0].repo, 'TANSTACK-WORKER-UI');
  assert.ok(apps[0].rol);
  assert.equal(appsDesdeFlags(NATURALEZAS.worker, 'no-existe'), null);
});

test('validarIdApp: minúsculas, números y guiones; sin repetir', () => {
  assert.equal(validarIdApp('web'), undefined);
  assert.equal(validarIdApp('api-v2'), undefined);
  assert.ok(validarIdApp('Web'));
  assert.ok(validarIdApp('-web'));
  assert.ok(validarIdApp(''));
  assert.ok(validarIdApp('web', ['web']));
});

test('payloadMeta: naturaleza siempre; plantilla (clave del catálogo) solo en app única', () => {
  const unica = payloadMeta({ domain: 'ti', teams: ['t'], tags: [], naturaleza: 'worker', plantilla: 'tanstack-ui' });
  assert.equal(unica.naturaleza, 'worker');
  assert.equal(unica.plantilla, 'tanstack-ui');
  assert.equal(unica.domain, 'ti');
  const mono = payloadMeta({ domain: 'ti', naturaleza: 'worker', plantilla: null });
  assert.equal(mono.naturaleza, 'worker');
  assert.equal('plantilla' in mono, false);
  assert.deepEqual(mono.teams, []);
});

test('fusionarMeta: el .faro.json que trae el template se COMPLETA, no se ignora', () => {
  const previa = { teams: ['ia', 'web'] };
  const m = fusionarMeta(previa, payloadMeta({ domain: 'ti', teams: [], tags: [], naturaleza: 'worker', plantilla: null }));
  assert.equal(m.domain, 'ti');
  assert.equal(m.naturaleza, 'worker');
  assert.deepEqual(m.teams, ['ia', 'web']);   // vacío en el alta no borra lo que ya había
  assert.deepEqual(fusionarMeta(null, { domain: 'ti', teams: ['x'] }), { domain: 'ti', teams: ['x'] });
  assert.deepEqual(fusionarMeta({ teams: ['a'] }, { teams: ['b'] }).teams, ['b']);
});

// ---------- US-3 · instanciar (sin plugin) ----------
const leerJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const app = (id, rol = 'Front web') => ({ id, rol, plantilla: 'tanstack-ui', repo: 'TANSTACK-WORKER-UI' });

test('monorepo con front TanStack: apps/web desde la plantilla, workspace, wrangler portal-web-dev y .faro.json', () => {
  const destino = repoNuevo();
  const r = instanciarMonorepo({ destino, repoName: 'portal', apps: [app('web')], clonar: clonarFalso });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.hechos, ['web']);
  const web = path.join(destino, 'apps', 'web');
  assert.ok(fs.existsSync(path.join(web, 'src', 'main.tsx')));
  assert.equal(leerJson(path.join(web, 'package.json')).name, 'portal-web');
  const wr = fs.readFileSync(path.join(web, 'wrangler.jsonc'), 'utf8');
  assert.match(wr, /"portal-web-dev"/);
  assert.match(wr, /"portal-web-prod"/);
  assert.match(fs.readFileSync(path.join(web, 'CLAUDE.md'), 'utf8'), /apps\/web/);
  // Lo que NO es de la app no baja a apps/web: historial, gestión y config de workspace de la plantilla.
  for (const f of ['.git', 'gestion', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) assert.equal(fs.existsSync(path.join(web, f)), false, f);
  // Raíz: workspace pnpm con apps/* y la config de pnpm de la plantilla; package.json con scripts -r.
  const ws = fs.readFileSync(path.join(destino, 'pnpm-workspace.yaml'), 'utf8');
  assert.match(ws, /- "apps\/\*"/);
  assert.match(ws, /allowBuilds:\n {2}esbuild: true\n {2}workerd: true/);
  assert.match(ws, /minimumReleaseAgeExclude:\n {2}- mi-ds/);
  const raiz = leerJson(path.join(destino, 'package.json'));
  assert.equal(raiz.private, true);
  assert.equal(raiz.packageManager, 'pnpm@11.17.0');
  assert.equal(raiz.scripts.build, 'pnpm -r --if-present run build');
  assert.equal(fs.readFileSync(path.join(destino, '.node-version'), 'utf8').trim(), '24');
  // .gitignore de la raíz: pnpm install deja node_modules/ en la RAÍZ y wrangler/secretos pueden
  // aparecer fuera de apps/<id>; el .gitignore de la app solo cubre su carpeta.
  const gi = fs.readFileSync(path.join(destino, '.gitignore'), 'utf8');
  for (const l of ['node_modules/', '.wrangler/', '.dev.vars', '.env.*', '!.dev.vars.example']) assert.ok(gi.split(/\r?\n/).includes(l), l);
  assert.match(gi, /^borrador\/\*$/m);   // lo que ya tenía la raíz se conserva
  assert.ok(fs.existsSync(path.join(web, '.gitignore')));   // y la app conserva el suyo
  const meta = leerJson(path.join(destino, '.faro.json'));
  assert.deepEqual(meta.monorepo, { apps: { web: { rol: 'Front web' } } });
  assert.equal(meta.domain, 'ti');
});

test('dos apps: cada una en su carpeta y el workspace junta su config de pnpm sin repetir', () => {
  const destino = repoNuevo();
  const clonar = (a, dir) => (a.id === 'api' ? clonarApi(a, dir) : clonarFalso(a, dir));
  const r = instanciarMonorepo({ destino, repoName: 'portal', apps: [app('web'), app('api', 'API')], clonar });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.hechos, ['web', 'api']);
  assert.match(fs.readFileSync(path.join(destino, 'apps', 'api', 'wrangler.jsonc'), 'utf8'), /"portal-api-dev"/);
  const ws = fs.readFileSync(path.join(destino, 'pnpm-workspace.yaml'), 'utf8');
  assert.equal(ws.match(/esbuild: true/g).length, 1);
  assert.match(ws, /sharp: true/);
  assert.deepEqual(Object.keys(leerJson(path.join(destino, '.faro.json')).monorepo.apps), ['web', 'api']);
});

test('si una app falla, no queda apps/ ni workspace y .faro.json vuelve a su estado', () => {
  const destino = repoNuevo();
  const antes = fs.readFileSync(path.join(destino, '.faro.json'), 'utf8');
  const giAntes = fs.readFileSync(path.join(destino, '.gitignore'), 'utf8');
  const clonar = (a, dir) => { if (a.id === 'api') throw new Error('no pude clonar la plantilla'); clonarFalso(a, dir); };
  const r = instanciarMonorepo({ destino, repoName: 'portal', apps: [app('web'), app('api')], clonar });
  assert.equal(r.ok, false);
  assert.match(r.error, /api/);
  assert.deepEqual(r.hechos, []);
  for (const f of ['apps', 'pnpm-workspace.yaml', 'package.json', '.node-version']) assert.equal(fs.existsSync(path.join(destino, f)), false, f);
  assert.equal(fs.readFileSync(path.join(destino, '.faro.json'), 'utf8'), antes);
  assert.equal(fs.readFileSync(path.join(destino, '.gitignore'), 'utf8'), giAntes);
  assert.equal(git(destino, 'status', '--porcelain'), '');
});

test('ningún error sale con el token: se tachan las credenciales de las URLs', () => {
  assert.equal(sinCredenciales('Command failed: git clone https://x-access-token:ghp_SECRETO@github.com/Acme/T.git d'),
    'Command failed: git clone https://***@github.com/Acme/T.git d');
  const destino = repoNuevo();
  const apps = appsDesdeFlags(NATURALEZAS.worker, 'tanstack-ui');
  const r = instanciarMonorepo({ destino, repoName: 'portal', apps, clonar: () => { throw new Error('git clone https://u:ghp_SECRETO@github.com/o/r.git'); } });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.error, /ghp_SECRETO/);
});
