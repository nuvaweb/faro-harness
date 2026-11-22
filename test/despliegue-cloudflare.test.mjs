// Adaptador Cloudflare: valida wrangler.jsonc con los entornos que declara el propio fichero.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const CF = require(path.join(RAIZ, 'plugins/faro/hooks/lib/despliegue-cloudflare.js'));
const D = require(path.join(RAIZ, 'plugins/faro/hooks/lib/despliegue.js'));

const ctx = (ficheros) => ({
  root: '/x', monorepo: false, apps: [],
  leer: (r) => (r in ficheros ? ficheros[r] : null),
  existe: (r) => r in ficheros,
  listar: () => [],
});
const codigos = (ficheros) => {
  const c = ctx(ficheros);
  const det = CF.detectar(c);
  return CF.diagnostico(c, det).map((h) => h.codigo);
};
const w = (o) => JSON.stringify({ compatibility_date: '2025-01-01', ...o });
const d1 = (id) => [{ binding: 'DB', database_id: id }];

const COMPLETO = w({
  d1_databases: d1('top'),
  env: {
    staging: { d1_databases: d1('s'), vars: { LOG: '1' } },
    production: { d1_databases: d1('p') },
  },
});

test('sin wrangler no detecta; con wrangler.toml avisa cf-toml', () => {
  assert.strictEqual(CF.detectar(ctx({})), null);
  assert.deepStrictEqual(codigos({ 'wrangler.toml': 'name="x"' }), ['cf-toml']);
});

test('wrangler.jsonc completo y correcto: cero hallazgos de error', () => {
  const c = ctx({ 'wrangler.jsonc': COMPLETO });
  const hs = CF.diagnostico(c, CF.detectar(c));
  assert.deepStrictEqual(hs.filter((h) => h.nivel === 'error'), []);
});

test('cf-binding-falta-env: binding superior no redeclarado en un env', () => {
  const f = w({ d1_databases: d1('t'), env: { staging: {}, production: { d1_databases: d1('p') } } });
  const hs = CF.diagnostico(ctx({ 'wrangler.jsonc': f }), CF.detectar(ctx({ 'wrangler.jsonc': f })));
  const h = hs.filter((x) => x.codigo === 'cf-binding-falta-env');
  assert.strictEqual(h.length, 1);
  assert.match(h[0].mensaje, /env\.staging/);
  assert.strictEqual(h[0].nivel, 'error');
});

test('cf-id-repetido: mismo database_id en dos entornos', () => {
  const f = w({ env: { staging: { d1_databases: d1('mismo') }, production: { d1_databases: d1('mismo') } } });
  assert.ok(codigos({ 'wrangler.jsonc': f }).includes('cf-id-repetido'));
});

test('cf-id-fijo-sin-env: ID fijo de nivel superior y sin bloque env (aviso)', () => {
  const c = ctx({ 'wrangler.jsonc': w({ d1_databases: d1('t') }) });
  const h = CF.diagnostico(c, CF.detectar(c)).find((x) => x.codigo === 'cf-id-fijo-sin-env');
  assert.ok(h);
  assert.strictEqual(h.nivel, 'aviso');
  assert.match(h.mensaje, /cuentas/);
  // sin IDs fijos o con env, no avisa
  assert.ok(!codigos({ 'wrangler.jsonc': w({}) }).includes('cf-id-fijo-sin-env'));
  assert.ok(!codigos({ 'wrangler.jsonc': COMPLETO }).includes('cf-id-fijo-sin-env'));
});

test('cf-hyperdrive-local: sin localConnectionString ni variable en .dev.vars.example', () => {
  const f = w({ hyperdrive: [{ binding: 'HD', id: 'a' }] });
  assert.ok(codigos({ 'wrangler.jsonc': f }).includes('cf-hyperdrive-local'));
  assert.ok(!codigos({ 'wrangler.jsonc': f, '.dev.vars.example': 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HD=x' }).includes('cf-hyperdrive-local'));
  assert.ok(!codigos({ 'wrangler.jsonc': w({ hyperdrive: [{ binding: 'HD', id: 'a', localConnectionString: 'p' }] }) }).includes('cf-hyperdrive-local'));
});

test('cf-secreto-en-vars: global y por entorno', () => {
  assert.ok(codigos({ 'wrangler.jsonc': w({ vars: { API_KEY: 'x' } }) }).includes('cf-secreto-en-vars'));
  assert.ok(codigos({ 'wrangler.jsonc': w({ env: { staging: { vars: { DB_PASSWORD: 'x' } } } }) }).includes('cf-secreto-en-vars'));
});

test('cf-sin-compat: falta compatibility_date', () => {
  assert.ok(codigos({ 'wrangler.jsonc': '{}' }).includes('cf-sin-compat'));
});

test('cf-devvars-versionado: .dev.vars sin .gitignore', () => {
  assert.ok(codigos({ 'wrangler.jsonc': w({}), '.dev.vars': 'X=1' }).includes('cf-devvars-versionado'));
  assert.ok(!codigos({ 'wrangler.jsonc': w({}), '.dev.vars': 'X=1', '.gitignore': 'node_modules\n.dev.vars\n' }).includes('cf-devvars-versionado'));
});

test('gates: un dry-run por entorno presente, o uno sin --env', () => {
  const c = ctx({ 'wrangler.jsonc': COMPLETO });
  const g = CF.gates(c, CF.detectar(c));
  assert.deepStrictEqual(g.map((x) => x.run), [
    'npx wrangler deploy --dry-run --env staging',
    'npx wrangler deploy --dry-run --env production',
  ]);
  const c2 = ctx({ 'wrangler.jsonc': w({}) });
  const g2 = CF.gates(c2, CF.detectar(c2));
  assert.strictEqual(g2.length, 1);
  assert.strictEqual(g2[0].run, 'npx wrangler deploy --dry-run');
  assert.deepStrictEqual(g2[0].pasos, [['npx', ['wrangler', 'deploy', '--dry-run']]]);
});

test('comandoLocal: script dev del package.json o wrangler dev', () => {
  const sin = CF.comandoLocal(ctx({ 'wrangler.jsonc': w({}) }), {});
  assert.deepStrictEqual([sin.cmd, sin.args], ['npx', ['wrangler', 'dev']]);
  assert.match(sin.nota, /Miniflare/);
  const con = CF.comandoLocal(ctx({ 'package.json': '{"scripts":{"dev":"vite"}}' }), {});
  assert.deepStrictEqual([con.cmd, con.args], ['npm', ['run', 'dev']]);
});

test('el adaptador no exporta pasosCi ni secretosEsperados', () => {
  assert.strictEqual(CF.id, 'cloudflare');
  assert.strictEqual(CF.pasosCi, undefined);
  assert.strictEqual(CF.secretosEsperados, undefined);
});

test('adaptadores() del núcleo devuelve el adaptador de Cloudflare', () => {
  assert.ok(D.adaptadores().some((a) => a.id === 'cloudflare'));
});

test('cf-invalido: wrangler.jsonc ilegible da error y conserva su gate dry-run', () => {
  const c = ctx({ 'wrangler.jsonc': '{nope' });
  const det = CF.detectar(c);
  const hs = CF.diagnostico(c, det);
  assert.deepStrictEqual(hs.map((h) => [h.nivel, h.codigo]), [['error', 'cf-invalido']]);
  assert.deepStrictEqual(CF.gates(c, det).map((g) => g.run), ['npx wrangler deploy --dry-run']);
});

const mono = (ficheros) => ({ ...ctx(ficheros), monorepo: true, apps: [{ id: 'api', dir: 'apps/api' }, { id: 'web', dir: 'apps/web' }] });

test('monorepo: gates por app con --config y sufijo :app; hallazgos y .gitignore por app', () => {
  const c = mono({
    'apps/api/wrangler.jsonc': w({ env: { staging: { d1_databases: d1('s') } }, d1_databases: d1('t') }),
    'apps/web/wrangler.jsonc': '{}',
    'apps/web/.dev.vars': 'X=1',
    'apps/api/.dev.vars': 'X=1',
    'apps/api/.gitignore': '.dev.vars\n',
  });
  const det = CF.detectar(c);
  assert.deepStrictEqual(det.proyectos.map((p) => p.app), ['api', 'web']);
  const g = CF.gates(c, det);
  assert.deepStrictEqual(g.map((x) => x.gate), ['deploy-dry-run:api:staging', 'deploy-dry-run:web']);
  assert.strictEqual(g[0].run, 'npx wrangler deploy --dry-run --config apps/api/wrangler.jsonc --env staging');
  assert.strictEqual(g[1].run, 'npx wrangler deploy --dry-run --config apps/web/wrangler.jsonc');
  const hs = CF.diagnostico(c, det);
  const de = (f) => hs.filter((h) => h.fichero === f).map((h) => h.codigo);
  assert.deepStrictEqual(de('apps/api/wrangler.jsonc'), []);
  assert.deepStrictEqual(de('apps/web/wrangler.jsonc').sort(), ['cf-devvars-versionado', 'cf-sin-compat']);
});
