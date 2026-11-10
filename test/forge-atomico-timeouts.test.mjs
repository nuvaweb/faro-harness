// Cambio 'harness-timeouts-forge-atomicidad': presupuesto de hooks, deteccion de forja y atomicidad.
// Un test por ESCENARIO de los deltas de spec (gestion/cambios/changes/<slug>/specs/).
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');
const FORGE = path.join(HOOKS, 'lib', 'forge.js');

const run = (args, cwd, env = {}) =>
  spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60000 });
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${name}-`));

// Repo git real y minimo, con el remoto que se le indique.
// OJO: hace falta AL MENOS UN COMMIT. Sin el, 'git rev-parse --abbrev-ref HEAD' falla, gitInfo()
// devuelve null y gitLines() sale por la rama "repo sin git" ANTES de emitir la regla de plataforma.
function repoCon(remote, extra = () => {}) {
  const dir = tmp('forge');
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  // La firma de commits heredada de la config global (gpg/1Password/ssh-sign) puede fallar o
  // pedir interaccion y dejar el repo de prueba SIN COMMITS: entonces el harness no tiene nada
  // que gobernar y el test falla por el entorno. Se apaga solo aqui, no en la config del usuario.
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  if (remote) git('remote', 'add', 'origin', remote);
  extra(dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

// ---------- spec: presupuesto-hooks ----------

// Spec presupuesto-hooks (#122): sin timeout donde el defecto es 600 s; UserPromptSubmit, cuyo
// defecto son 30 s, lleva uno explicito y holgado. Spec y test dicen lo mismo.
test('hooks.json solo declara timeout en UserPromptSubmit (>= 60 s); el resto usa el defecto de la plataforma', () => {
  const h = JSON.parse(fs.readFileSync(path.join(HOOKS, 'hooks.json'), 'utf8'));
  const conTimeout = [];
  for (const [evento, grupos] of Object.entries(h.hooks)) {
    for (const g of grupos) for (const hook of g.hooks) {
      // UserPromptSubmit es la EXCEPCION: su defecto de plataforma son 30 s (no 600) y se agotan
      // bajo carga, asi que lleva timeout explicito y holgado. En el resto, declararlo RECORTA el margen.
      if (evento === 'UserPromptSubmit') { assert.ok(hook.timeout >= 60, 'UserPromptSubmit debe llevar un timeout explicito holgado (>= 60 s)'); continue; }
      if (Object.prototype.hasOwnProperty.call(hook, 'timeout')) conTimeout.push(`${evento}:${hook.timeout}`);
    }
  }
  assert.deepStrictEqual(conTimeout, [],
    `declaran timeout y recortan el defecto de 600s: ${conTimeout.join(', ')}`);
});

// ---------- spec: deteccion-forja ----------

test('forja: remoto de GitHub por SSH y por HTTPS', async () => {
  const { detect } = await import(`file://${FORGE.replace(/\\/g, '/')}`);
  for (const r of ['git@github.com:acme-org/faro-plugin.git', 'https://github.com/acme-org/faro-plugin.git']) {
    const f = detect(r);
    assert.strictEqual(f.forge, 'github', r);
    assert.strictEqual(f.owner, 'acme-org', r);
    assert.strictEqual(f.project, 'faro-plugin', r);
    assert.strictEqual(f.path, 'acme-org/faro-plugin', r);
  }
});

test('forja: GitLab con subgrupos anidados conserva la ruta COMPLETA (es el id de su API)', async () => {
  const { detect } = await import(`file://${FORGE.replace(/\\/g, '/')}`);
  const f = detect('git@gitlab.com:acme/plataforma/backend/api.git');
  assert.strictEqual(f.forge, 'gitlab');
  assert.strictEqual(f.path, 'acme/plataforma/backend/api');
  assert.strictEqual(f.project, 'api');
  assert.strictEqual(f.owner, 'acme', 'el owner es el grupo RAIZ, no el subgrupo');
});

test('forja: GitLab autoalojado se reconoce por el host', async () => {
  const { detect } = await import(`file://${FORGE.replace(/\\/g, '/')}`);
  const f = detect('https://gitlab.acme.internal/equipo/proyecto.git');
  assert.strictEqual(f.forge, 'gitlab');
  assert.strictEqual(f.selfHosted, true);
});

test('forja: host desconocido y repo sin remoto no afirman soporte de API', async () => {
  const { detect, capacidades } = await import(`file://${FORGE.replace(/\\/g, '/')}`);
  for (const r of ['git@bitbucket.org:equipo/proyecto.git', '']) {
    const f = detect(r);
    assert.strictEqual(f.forge, 'desconocida', r || '(sin remoto)');
    assert.strictEqual(capacidades(f.forge).api, false);
    assert.strictEqual(capacidades(f.forge).pr, false);
  }
});

test('sesion en repo GitLab: NO ordena usar la API de GitHub y orienta a los comandos por intencion', () => {
  const dir = repoCon('git@gitlab.com:acme/plataforma/api.git');
  const r = run([HARNESS, 'session'], dir, { CLAUDE_PROJECT_DIR: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!/gh repos\/<org>\/<repo>\/pulls POST/.test(r.stdout),
    'sigue mandando abrir PRs contra la API de GitHub en un repo de GitLab');
  assert.ok(/PLATAFORMA = GITLAB/.test(r.stdout), 'no anuncia que la plataforma es GitLab');
  // Desde el cimiento de forja (0.15.0) GitLab TIENE adaptador: la sesion orienta a los comandos por
  // intencion en vez de declarar que falta soporte.
  assert.ok(/por INTENCION/.test(r.stdout), 'debe orientar a los comandos por intencion del harness');
});

test('sesion en repo GitHub: conserva la regla vigente del token del harness', () => {
  const dir = repoCon('git@github.com:acme-org/algo.git');
  const r = run([HARNESS, 'session'], dir, { CLAUDE_PROJECT_DIR: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/GITHUB \/ API \(REGLA DURA/.test(r.stdout), 'perdio la regla dura de GitHub');
});

test('subcomando forge: imprime la deteccion y sale en 0', () => {
  const dir = repoCon('git@gitlab.com:grupo/sub/proyecto.git');
  const r = run([HARNESS, 'forge'], dir, { CLAUDE_PROJECT_DIR: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Forja: gitlab/);
  assert.match(r.stdout, /grupo\/sub\/proyecto/);
});

// ---------- spec: atomicidad-modulos ----------

test('atomico: informa los ficheros por encima del umbral y SALE EN 0 (avisa, no bloquea)', () => {
  const dir = repoCon('git@github.com:x/y.git', (d) => {
    fs.writeFileSync(path.join(d, 'grande.js'), 'const a = 1;\n'.repeat(500));
    fs.writeFileSync(path.join(d, 'pequeno.js'), 'const b = 2;\n');
  });
  const r = run([HARNESS, 'atomico'], dir, { CLAUDE_PROJECT_DIR: dir });
  assert.strictEqual(r.status, 0, 'un informe nunca devuelve error');
  assert.match(r.stdout, /grande\.js/);
  assert.ok(!/pequeno\.js/.test(r.stdout), 'no deberia listar el que esta dentro del umbral');
});

test('atomico: repo sin ficheros grandes lo declara explicitamente', () => {
  const dir = repoCon('git@github.com:x/y.git', (d) => {
    fs.writeFileSync(path.join(d, 'ok.js'), 'const a = 1;\n'.repeat(10));
  });
  const r = run([HARNESS, 'atomico'], dir, { CLAUDE_PROJECT_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /Ningun fichero supera el umbral/);
});

test('atomico: el umbral del repo (su .claude/faro-schema.json) manda sobre el del plugin', () => {
  const dir = repoCon('git@github.com:x/y.git', (d) => {
    fs.mkdirSync(path.join(d, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(d, '.claude', 'faro-schema.json'),
      JSON.stringify({ enums: { atomicidad: { max_lineas: 20, extensiones: ['.js'], excluir: [] } } }));
    fs.writeFileSync(path.join(d, 'medio.js'), 'const a = 1;\n'.repeat(50)); // 50 > 20, pero < 400
  });
  const r = run([HARNESS, 'atomico'], dir, { CLAUDE_PROJECT_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /umbral 20 lineas/);
  assert.match(r.stdout, /medio\.js/, 'con umbral 20 deberia cantar un fichero de 50 lineas');
});

test('validate en modo MOTOR no siembra el andamio de carpetas de instancia', () => {
  const dir = repoCon('git@github.com:acme-org/faro-plugin.git', (d) => {
    // Marca de repo MOTOR: el manifiesto de marketplace.
    fs.mkdirSync(path.join(d, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(d, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'faro-marketplace', plugins: [] }));
    // IS_ENGINE exige AMBAS marcas: el manifiesto de marketplace Y el motor en plugins/faro/hooks/.
    fs.mkdirSync(path.join(d, 'plugins', 'faro', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(d, 'plugins', 'faro', 'hooks', 'harness.js'), '// motor\n');
  });
  run([HARNESS, 'validate'], dir, { CLAUDE_PROJECT_DIR: dir });
  for (const carpeta of ['gestion', 'documentos', 'fuentes', 'notebooks', 'borrador']) {
    assert.ok(!fs.existsSync(path.join(dir, carpeta)),
      `validate creo '${carpeta}/' en un repo MOTOR, que no usa el andamio de instancia`);
  }
});
