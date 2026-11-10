// #178 — los tests del MOTOR por dominio: `npm run test:afectados` / `npm run test:dominio -- <nombre>`.
// Los dominios del motor se declaran en .faro.json > tests.dominios y los resuelve el mismo servicio que
// usan los repos de trabajo (lib/dominios.js). Estos tests son la red: si alguien añade un test o un modulo
// y no lo asigna a un dominio, falla aqui (no se esconde ejecutandolo todo).
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const dom = require(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'dominios.js'));
const cfg = dom.config(RAIZ);
const ctx = dom.contexto(RAIZ, { cfg });
const TESTS = ctx.lista.filter((f) => /^test\/[\w.-]+\.test\.mjs$/.test(f));
const lib = (n) => `plugins/faro/hooks/lib/${n}.js`;

test('el motor declara sus dominios y la configuracion es valida', () => {
  assert.strictEqual(cfg.declarado, true);
  assert.deepStrictEqual(dom.validarConfig(RAIZ), []);
});

test('TODO test del motor pertenece a un dominio (si no, cae fuera de test:afectados)', () => {
  const sin = TESTS.filter((t) => !dom.dominiosDe(ctx, t).length);
  assert.deepStrictEqual(sin, [], `asigna estos tests a un dominio en .faro.json > tests.dominios:\n${sin.join('\n')}`);
});

test('TODO modulo de hooks/ pertenece a un dominio (sin hueco de cobertura funcional)', () => {
  const huecos = dom.avisosCobertura(RAIZ).filter((l) => /ningún dominio/.test(l));
  assert.deepStrictEqual(huecos, []);
  const sueltos = ctx.lista.filter((f) => /^plugins\/faro\/hooks\/(lib\/)?[\w-]+\.js$/.test(f) && !dom.dominiosDe(ctx, f).length);
  assert.deepStrictEqual(sueltos, []);
});

test('ningun dominio del motor tiene tests que necesiten codigo de otro (encapsulacion)', () => {
  assert.deepStrictEqual(dom.cruces(RAIZ, { ctx }), []);
});

test('un cambio en un modulo ejecuta SOLO su dominio, y una fraccion de la suite', () => {
  const r = dom.resolver(RAIZ, [lib('contexto')], { ctx });
  assert.deepStrictEqual(r.afectados.map((a) => a.dominio), ['contexto']);
  assert.ok(r.tests.length / TESTS.length < 0.1, `${r.tests.length}/${TESTS.length}`);
  assert.ok(r.tests.includes('test/contexto-minimo.test.mjs'));
});

test('harness.js, hooks.json y el esquema: el subconjunto de coherencia + sus dominios dependientes, no toda la suite', () => {
  for (const f of ['plugins/faro/hooks/harness.js', 'plugins/faro/hooks/faro-schema.json', 'plugins/faro/hooks/hooks.json']) {
    const r = dom.resolver(RAIZ, [f], { ctx });
    const n = r.afectados.map((a) => a.dominio);
    assert.ok(n.includes('nucleo'), f);
    assert.ok(r.tests.includes('test/coherencia-docs-comandos.test.mjs'), f);
    assert.ok(r.tests.length < TESTS.length / 2, `${f}: ${r.tests.length}/${TESTS.length}`);
  }
});

test('etiqueta lento: un test lento no entra salvo que se toque su modulo', () => {
  const r = dom.resolver(RAIZ, [lib('apps-forja')], { ctx });
  assert.ok(!r.tests.includes('test/simulacro-despliegue.test.mjs'));
  assert.ok(r.lentosOmitidos.includes('test/simulacro-despliegue.test.mjs'));
  const r2 = dom.resolver(RAIZ, [lib('code')], { ctx });
  assert.ok(r2.tests.includes('test/simulacro-despliegue.test.mjs'), 'simulacro-despliegue menciona code.js');
});

test('un test cambiado ejecuta solo ese dominio', () => {
  const r = dom.resolver(RAIZ, ['test/triaje.test.mjs'], { ctx });
  assert.deepStrictEqual(r.afectados.map((a) => a.dominio), ['triaje']);
});

test('scripts npm: test:afectados y test:dominio existen y --lista no ejecuta nada', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['test:afectados'], /scripts\/test-afectados\.js/);
  assert.match(pkg.scripts['test:dominio'], /scripts\/test-afectados\.js --dominio/);
  const r = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'test-afectados.js'), '--dominio', 'planificacion', '--lista'], { cwd: RAIZ, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /test\/planificacion\.test\.mjs/);
  assert.match(r.stdout, /de \d+ tests/);
  const mal = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'test-afectados.js'), '--dominio', 'no-existe'], { cwd: RAIZ, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(mal.status, 2);
  assert.match(mal.stderr, /no existe/);
});

test('test:afectados: sin cambios contra la base no ejecuta nada', () => {
  const r = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'test-afectados.js'), '--lista', '--base', 'HEAD'], { cwd: RAIZ, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.status, 0, r.stderr);
});
