// #178 — TESTS POR DOMINIO (= funcionalidad): lib/dominios.js, el servicio unico que consumen el hook TDD,
// validate, `harness.js tests-dominios` y los scripts npm del motor.
//
// Un dominio es una unidad ENCAPSULADA: interior (codigo+tests propios), contrato publico (lo que otros
// importan) y dependientes. Regla: interior -> solo ese dominio; contrato -> dominio + hermanos
// dependientes; transversal -> todos los alcanzados; la suite completa solo en CI y /faro:publicar.
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
const dom = require(path.join(HOOKS, 'lib', 'dominios.js'));

const escribir = (dir, rel, txt) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const repo = (ficheros, faro) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-dom-'));
  git(d, 'init', '-q'); git(d, 'config', 'user.email', 'a@b.c'); git(d, 'config', 'user.name', 'T'); git(d, 'config', 'commit.gpgsign', 'false');
  if (faro !== undefined) escribir(d, '.faro.json', JSON.stringify(faro, null, 2));
  for (const [rel, txt] of Object.entries(ficheros)) escribir(d, rel, txt);
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'base');
  return d;
};
const harness = (cwd, args, extra = {}) => {
  const r = spawnSync(process.execPath, [HARNESS, ...args], { cwd, encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, CLAUDE_PLUGIN_DATA: path.join(os.tmpdir(), 'faro-dom-data', path.basename(cwd)), ...extra } });
  return { out: r.stdout || '', err: r.stderr || '', status: r.status };
};
const clon = (o) => JSON.parse(JSON.stringify(o));

// Dos dominios: 'pagos' (importa a 'clientes' por su contrato) y 'clientes'. 'util' es transversal.
const FICHEROS = {
  'src/clientes/index.js': "const { norm } = require('./interno.js'); module.exports = { alta: (x) => norm(x) };\n",
  'src/clientes/interno.js': 'module.exports = { norm: (x) => String(x).trim() };\n',
  'src/pagos/index.js': "const { alta } = require('../clientes/index.js'); module.exports = { cobrar: (c) => alta(c) };\n",
  'src/pagos/calculo.js': 'module.exports = { iva: (n) => n * 1.21 };\n',
  'src/util/fechas.js': 'module.exports = { hoy: () => new Date() };\n',
  'src/suelto/huerfano.js': 'module.exports = {};\n',
  'test/clientes.test.mjs': "import { alta } from '../src/clientes/index.js';\n",
  'test/pagos.test.mjs': "import { cobrar } from '../src/pagos/index.js';\n",
  'test/pagos-lento.test.mjs': "import { iva } from '../src/pagos/calculo.js';\n",
};
const FARO = {
  tests: {
    comando: 'node --test',
    dominios: {
      clientes: { descripcion: 'Alta y normalizacion de clientes', codigo: ['src/clientes/**'], tests: ['test/clientes.test.mjs'], contrato: ['src/clientes/index.js'] },
      pagos: { descripcion: 'Cobros', codigo: ['src/pagos/**'], tests: ['test/pagos*.test.mjs'], lento: ['test/pagos-lento.test.mjs'] },
    },
    transversal: ['src/util/**'],
  },
};
const nombres = (r) => r.afectados.map((a) => a.dominio).sort();

// ---------- configuracion ----------

test('config: sin tests.dominios -> no declarado; con ellos, normaliza listas', () => {
  const sin = repo({ 'src/a.js': '1' }, {});
  assert.strictEqual(dom.config(sin).declarado, false);
  const d = repo(FICHEROS, FARO);
  const c = dom.config(d);
  assert.strictEqual(c.declarado, true);
  assert.deepStrictEqual(Object.keys(c.dominios).sort(), ['clientes', 'pagos']);
  assert.deepStrictEqual(c.dominios.pagos.contrato, null);
  assert.deepStrictEqual(c.dominios.clientes.contrato, ['src/clientes/index.js']);
});

test('validarConfig: nombres, globs y comandos mal formados se avisan en una linea', () => {
  const malo = 'r' + 'm -rf /';
  const d = repo({ 'src/a.js': '1' }, { tests: { dominios: { 'Mal Nombre': { codigo: ['src/**'] }, ok: { codigo: 'src/**' }, otro: { codigo: ['src/**'], tests: ['t/**'], comando: malo } } } });
  const w = dom.validarConfig(d).join('\n');
  assert.match(w, /Mal Nombre/);
  assert.match(w, /ok.*codigo.*lista/i);
  assert.match(w, /otro.*comando/i);
  assert.ok(dom.validarConfig(repo(FICHEROS, FARO)).length === 0);
});

// ---------- resolver ----------

test('cambio en el INTERIOR -> solo ese dominio', () => {
  const d = repo(FICHEROS, FARO);
  const r = dom.resolver(d, ['src/clientes/interno.js']);
  assert.deepStrictEqual(nombres(r), ['clientes']);
  assert.strictEqual(r.afectados[0].motivo, 'interior');
});

test('cambio en el CONTRATO -> el dominio y sus hermanos dependientes (deducidos del grafo de imports)', () => {
  const d = repo(FICHEROS, FARO);
  const r = dom.resolver(d, ['src/clientes/index.js']);
  assert.deepStrictEqual(nombres(r), ['clientes', 'pagos']);
  assert.match(r.afectados.find((a) => a.dominio === 'pagos').motivo, /dependiente de clientes/);
});

test('dependientes declarados se suman a los deducidos', () => {
  const faro = clon(FARO);
  faro.tests.dominios.pagos.contrato = ['src/pagos/index.js'];
  faro.tests.dominios.pagos.dependientes = ['clientes'];
  const d = repo(FICHEROS, faro);
  assert.deepStrictEqual(nombres(dom.resolver(d, ['src/pagos/index.js'])), ['clientes', 'pagos']);
});

test('un test cambiado afecta solo a su dominio', () => {
  const d = repo(FICHEROS, FARO);
  assert.deepStrictEqual(nombres(dom.resolver(d, ['test/clientes.test.mjs'])), ['clientes']);
});

test('TRANSVERSAL -> los dominios que lo alcanzan por el grafo; sin importadores, todos', () => {
  const d = repo({ ...FICHEROS, 'src/pagos/f.js': "require('../util/fechas.js');\n" }, FARO);
  const r = dom.resolver(d, ['src/util/fechas.js']);
  assert.deepStrictEqual(nombres(r), ['pagos']);
  assert.strictEqual(r.afectados[0].motivo, 'transversal');
  const d2 = repo(FICHEROS, FARO);
  assert.deepStrictEqual(nombres(dom.resolver(d2, ['src/util/fechas.js'])), ['clientes', 'pagos']);
});

test('transversal como mapa explicito glob -> dominios', () => {
  const faro = clon(FARO);
  faro.tests.transversal = { 'src/util/**': ['clientes'] };
  const d = repo(FICHEROS, faro);
  assert.deepStrictEqual(nombres(dom.resolver(d, ['src/util/fechas.js'])), ['clientes']);
});

test('codigo sin dominio -> hueco de cobertura funcional (no se esconde ejecutando todo)', () => {
  const d = repo(FICHEROS, FARO);
  const r = dom.resolver(d, ['src/suelto/huerfano.js', 'src/clientes/interno.js']);
  assert.deepStrictEqual(r.sinDominio, ['src/suelto/huerfano.js']);
  assert.deepStrictEqual(nombres(r), ['clientes']);
});

test('ficheros que no son codigo ni test (docs) no cuentan', () => {
  const d = repo({ ...FICHEROS, 'README.md': 'x' }, FARO);
  const r = dom.resolver(d, ['README.md']);
  assert.deepStrictEqual(r.afectados, []);
  assert.deepStrictEqual(r.sinDominio, []);
});

test('etiqueta lento: no entra salvo que se toque lo que ejercita (o el propio test)', () => {
  const d = repo(FICHEROS, FARO);
  let r = dom.resolver(d, ['src/pagos/index.js']);
  assert.ok(!r.tests.includes('test/pagos-lento.test.mjs'), 'lento fuera');
  assert.ok(r.tests.includes('test/pagos.test.mjs'));
  assert.deepStrictEqual(r.lentosOmitidos, ['test/pagos-lento.test.mjs']);
  r = dom.resolver(d, ['src/pagos/calculo.js']);
  assert.ok(r.tests.includes('test/pagos-lento.test.mjs'), 'se toco su modulo');
  r = dom.resolver(d, ['test/pagos-lento.test.mjs']);
  assert.ok(r.tests.includes('test/pagos-lento.test.mjs'));
});

test('entradas: las importaciones desde una puerta (CLI) no vuelven dependiente al resto', () => {
  const faro = clon(FARO);
  faro.tests.dominios.nucleo = { codigo: ['src/cli.js'], tests: [] };
  faro.tests.entradas = ['src/cli.js'];
  const d = repo({ ...FICHEROS, 'src/cli.js': "require('./clientes/index.js'); require('./pagos/index.js');\n" }, faro);
  assert.deepStrictEqual(nombres(dom.resolver(d, ['src/clientes/index.js'])), ['clientes', 'pagos']);   // nucleo NO aparece
});

// ---------- encapsulacion ----------

test('cruces: un test que importa codigo de OTRO dominio se senala como violacion de encapsulacion', () => {
  const d = repo({ ...FICHEROS, 'test/clientes.test.mjs': "import { alta } from '../src/clientes/index.js';\nimport { iva } from '../src/pagos/calculo.js';\n" }, FARO);
  const c = dom.cruces(d);
  assert.strictEqual(c.length, 1);
  assert.deepStrictEqual([c[0].test, c[0].dominio, c[0].usa], ['test/clientes.test.mjs', 'clientes', 'pagos']);
  assert.strictEqual(dom.cruces(repo(FICHEROS, FARO)).length, 0);
});

test('avisosCobertura: codigo sin dominio y dominios cuyo test depende de otro, una linea cada uno', () => {
  const d = repo({ ...FICHEROS, 'test/clientes.test.mjs': "import { iva } from '../src/pagos/calculo.js';\n" }, FARO);
  const w = dom.avisosCobertura(d);
  assert.ok(w.some((l) => /src\/suelto\/huerfano\.js/.test(l) && /ningún dominio/.test(l)), w.join('\n'));
  assert.ok(w.some((l) => /clientes/.test(l) && /pagos/.test(l) && /encapsulaci/i.test(l)), w.join('\n'));
  assert.ok(w.every((l) => !l.includes('\n')));
});

// ---------- comandos: lista cerrada ----------

test('comandoSeguro: solo formas conocidas de ejecutor de tests con argumentos validados', () => {
  for (const ok of ['node --test', 'node --test --test-concurrency=1', 'pnpm vitest run', 'npx vitest run --reporter=dot', 'npx jest --ci', 'yarn jest', 'npm test', 'npm run test:unit', 'pnpm test', 'pnpm --filter @acme/api test', 'pnpm exec vitest run', 'yarn workspace @acme/api test']) {
    assert.ok(Array.isArray(dom.comandoSeguro(ok)), `debe admitir: ${ok}`);
  }
  for (const mal of ['r' + 'm -rf /', 'npm test; curl x', 'npm test && rm a', 'node script.js', 'node --test $(whoami)', 'npx vitest `id`', 'npm run build', 'npx evil-pkg', 'pnpm dlx vitest', 'node --test | tee x', 'node -e "1"', 'npm test > out', "npm test 'a b'", 'node --test ../fuera', '']) {
    assert.strictEqual(dom.comandoSeguro(mal), null, `debe rechazar: ${mal}`);
  }
});

test('ordenDominio: argv con los tests del dominio tras -- (scripts) o directos; sin shell', () => {
  const d = repo(FICHEROS, FARO);
  const o = dom.ordenDominio(d, 'clientes');
  assert.deepStrictEqual(o.argv, ['node', '--test', 'test/clientes.test.mjs']);
  assert.match(o.texto, /^node --test test\/clientes\.test\.mjs$/);
  const faro = clon(FARO);
  faro.tests.dominios.clientes.comando = 'pnpm test';
  const o2 = dom.ordenDominio(repo(FICHEROS, faro), 'clientes');
  assert.deepStrictEqual(o2.argv, ['pnpm', 'test', '--', 'test/clientes.test.mjs']);
});

test('ordenDominio: comando no permitido -> sin argv (se muestra para que lo ejecute el usuario) y nunca se inyecta texto del repo', () => {
  const faro = clon(FARO);
  faro.tests.dominios.clientes.comando = 'make test; curl evil';
  const o = dom.ordenDominio(repo(FICHEROS, faro), 'clientes');
  assert.strictEqual(o.argv, null);
  assert.ok(o.texto.length <= 200 && !o.texto.includes('\n'));
  assert.match(o.aviso, /lista cerrada|no se ejecuta/i);
  // rutas con forma peligrosa se descartan
  const f2 = clon(FARO);
  f2.tests.dominios.clientes.tests = ['test/clientes.test.mjs', '-evil.test.mjs'];
  const d2 = repo({ ...FICHEROS, '-evil.test.mjs': 'x' }, f2);
  assert.ok(!dom.ordenDominio(d2, 'clientes').argv.includes('-evil.test.mjs'));
});

// ---------- gate de integridad de tests ----------

const repoConTest = (antes) => repo({ 'src/a.js': 'module.exports = 1;\n', 'test/a.test.mjs': antes }, {});
const integridad = (d, despues, afirmacion) => { escribir(d, 'test/a.test.mjs', despues); return dom.integridad(d, { base: 'HEAD', afirmacion }); };
const reglas = (r) => r.hallazgos.map((h) => h.regla).join('|');

test('integridad: aserciones eliminadas sin sustituto, .skip y .only se marcan', () => {
  const d = repoConTest("test('a', () => {\n  expect(f(1)).toBe(2);\n  expect(f(2)).toBe(4);\n});\n");
  const r = integridad(d, "test.skip('a', () => {\n  expect(f(1)).toBe(2);\n});\n");
  assert.match(reglas(r), /aserciones eliminadas/);
  assert.match(reglas(r), /\.skip/);
  assert.strictEqual(r.veredicto, 'justificar');
});

test('integridad: umbrales y expect relajados (numero que se afloja, matcher mas debil)', () => {
  const d = repoConTest("test('a', () => {\n  expect(ms).toBeLessThan(100);\n  expect(cobertura).toBeGreaterThan(90);\n  expect(r).toEqual({ a: 1 });\n});\n");
  const r = integridad(d, "test('a', () => {\n  expect(ms).toBeLessThan(5000);\n  expect(cobertura).toBeGreaterThan(10);\n  expect(r).toBeTruthy();\n});\n");
  assert.match(reglas(r), /umbral relajado/);
  assert.match(reglas(r), /expect debilitado/);
  assert.ok(r.hallazgos.filter((h) => /relajado/.test(h.regla)).length >= 2);
  // apretar un umbral NO es relajar
  const d2 = repoConTest("test('a', () => {\n  expect(ms).toBeLessThan(100);\n});\n");
  assert.strictEqual(integridad(d2, "test('a', () => {\n  expect(ms).toBeLessThan(50);\n});\n").hallazgos.length, 0);
});

test('integridad: cambio limpio (aserciones nuevas) -> ok y en silencio', () => {
  const d = repoConTest("test('a', () => {\n  expect(f(1)).toBe(2);\n});\n");
  const r = integridad(d, "test('a', () => {\n  expect(f(1)).toBe(2);\n  expect(f(3)).toBe(6);\n});\n");
  assert.strictEqual(r.veredicto, 'ok');
  assert.deepStrictEqual(r.hallazgos, []);
});

test('integridad: la afirmacion del agente se contrasta con el diff', () => {
  const d = repoConTest("test('a', () => {\n  expect(f(1)).toBe(2);\n  expect(f(2)).toBe(4);\n});\n");
  const r = integridad(d, "test('a', () => {\n  expect(f(1)).toBe(2);\n});\n", 'Solo añadí un doble de prueba, no rebajé aserciones.');
  assert.strictEqual(r.veredicto, 'bloquear');
  assert.ok(r.contradicciones.length >= 1);
  assert.match(r.contradicciones[0], /no rebaj|solo añad/i);
  // sin afirmacion contradictoria no hay contradiccion
  const r2 = integridad(d, "test('a', () => {\n  expect(f(1)).toBe(2);\n});\n", 'He simplificado el test.');
  assert.deepStrictEqual(r2.contradicciones, []);
  assert.strictEqual(r2.veredicto, 'justificar');
});

// ---------- proponer / aplicar ----------

const SPEC = '# Clientes\n\n## Requisitos AÑADIDOS\n\n### Requisito: Alta de clientes\n\nEl sistema DEBE dar de alta.\n\n#### Escenario: alta\n\n- CUANDO x\n- ENTONCES y\n\nEvidencia: test/clientes.test.mjs\n';
const repoLegacy = () => repo({ ...FICHEROS, 'gestion/cambios/changes/c1/specs/clientes/spec.md': SPEC, 'ESTADO.md': '---\ntipo: proyecto\n---\n' }, { teams: ['a'] });

test('proponer: borrador desde Evidencia: de las specs y el grafo de imports; lista huecos; SOLO LECTURA', () => {
  const d = repoLegacy();
  const antes = fs.readFileSync(path.join(d, '.faro.json'), 'utf8');
  const p = dom.proponer(d);
  assert.ok(p.dominios.clientes, JSON.stringify(Object.keys(p.dominios)));
  assert.strictEqual(p.dominios.clientes.origen, 'specs');
  assert.deepStrictEqual(p.dominios.clientes.tests, ['test/clientes.test.mjs']);
  assert.ok(p.dominios.clientes.codigo.some((g) => g.startsWith('src/clientes')));
  assert.ok(p.huecos.codigoSinDominio.includes('src/suelto/huerfano.js'));
  assert.strictEqual(fs.readFileSync(path.join(d, '.faro.json'), 'utf8'), antes);
  assert.ok(Array.isArray(p.decisiones));
});

test('aplicar: sin confirmo no escribe; con confirmo escribe .faro.json > tests.dominios y marca lo pendiente', () => {
  const d = repoLegacy();
  const antes = fs.readFileSync(path.join(d, '.faro.json'), 'utf8');
  assert.strictEqual(dom.aplicar(d, { confirmo: false }).escrito, false);
  assert.strictEqual(fs.readFileSync(path.join(d, '.faro.json'), 'utf8'), antes);
  const r = dom.aplicar(d, { confirmo: true });
  assert.strictEqual(r.escrito, true);
  const j = JSON.parse(fs.readFileSync(path.join(d, '.faro.json'), 'utf8'));
  assert.deepStrictEqual(j.teams, ['a'], 'no toca el resto');
  assert.ok(j.tests.dominios.clientes);
  assert.ok(Array.isArray(j.tests.dominios.clientes.pendiente) && j.tests.dominios.clientes.pendiente.length > 0, 'lo deducido sin certeza queda pendiente de decision');
  // idempotente y sin pisar lo declarado a mano
  j.tests.dominios.clientes.descripcion = 'EDITADA';
  fs.writeFileSync(path.join(d, '.faro.json'), JSON.stringify(j));
  dom.aplicar(d, { confirmo: true });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(d, '.faro.json'), 'utf8')).tests.dominios.clientes.descripcion, 'EDITADA');
});

test('aplicar --claude-md: escribe un bloque delimitado con la regla (idempotente)', () => {
  const d = repoLegacy();
  escribir(d, 'CLAUDE.md', '# Instancia\n\n## TDD\nCorre `npm test` siempre.\n');
  dom.aplicar(d, { confirmo: true, claudeMd: true });
  dom.aplicar(d, { confirmo: true, claudeMd: true });
  const t = fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8');
  assert.strictEqual((t.match(/<!-- faro:tests -->/g) || []).length, 1);
  assert.match(t, /tests-dominios --afectados/);
  assert.match(t, /Corre `npm test` siempre/, 'no borra lo del usuario');
});

test('CLI tests-dominios: --proponer es solo lectura y --aplicar exige --confirmo', () => {
  const d = repoLegacy();
  const antes = fs.readFileSync(path.join(d, '.faro.json'), 'utf8');
  const p = harness(d, ['tests-dominios', '--proponer']);
  assert.strictEqual(p.status, 0, p.err);
  assert.match(p.out, /clientes/);
  assert.strictEqual(fs.readFileSync(path.join(d, '.faro.json'), 'utf8'), antes);
  const a = harness(d, ['tests-dominios', '--aplicar']);
  assert.notStrictEqual(a.status, 0);
  assert.match(a.out + a.err, /--confirmo/);
  assert.strictEqual(fs.readFileSync(path.join(d, '.faro.json'), 'utf8'), antes);
  assert.strictEqual(harness(d, ['tests-dominios', '--aplicar', '--confirmo']).status, 0);
  assert.ok(JSON.parse(fs.readFileSync(path.join(d, '.faro.json'), 'utf8')).tests.dominios.clientes);
});

test('CLI tests-dominios --afectados: ordenes por dominio segun el diff (silencio si nada)', () => {
  const d = repo(FICHEROS, FARO);
  assert.strictEqual(harness(d, ['tests-dominios', '--afectados']).out.trim(), '');
  escribir(d, 'src/clientes/interno.js', 'module.exports = { norm: (x) => x };\n');
  const r = harness(d, ['tests-dominios', '--afectados']);
  assert.match(r.out, /clientes/);
  assert.match(r.out, /node --test test\/clientes\.test\.mjs/);
  assert.doesNotMatch(r.out, /pagos/);
});

test('CLI tests-dominios --integridad: contrasta el diff con la afirmacion', () => {
  const d = repoConTest("test('a', () => {\n  expect(f(1)).toBe(2);\n  expect(f(2)).toBe(4);\n});\n");
  escribir(d, 'test/a.test.mjs', "test('a', () => {\n  expect(f(1)).toBe(2);\n});\n");
  const r = harness(d, ['tests-dominios', '--integridad', '--base', 'HEAD', '--afirmacion', 'no rebajé aserciones']);
  assert.strictEqual(r.status, 1);
  assert.match(r.out, /aserciones eliminadas/);
  assert.match(r.out, /no rebaj/i);
});

// ---------- arranque tras actualizar ----------

test('avisoArranque: una linea, con marca de version para no repetirla', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-dom-marca-'));
  const d = repo(FICHEROS, { teams: ['a'] });
  const l1 = dom.avisoArranque(d, { version: '9.9.9', dir });
  assert.match(l1, /\/faro:tests/);
  assert.ok(!l1.includes('\n'));
  assert.strictEqual(dom.avisoArranque(d, { version: '9.9.9', dir }), '', 'misma version: no se repite');
  assert.match(dom.avisoArranque(d, { version: '9.10.0', dir }), /\/faro:tests/, 'version nueva: vuelve a avisar');
  // con dominios declarados, o sin codigo: silencio
  assert.strictEqual(dom.avisoArranque(repo(FICHEROS, FARO), { version: '1.0.0', dir }), '');
  assert.strictEqual(dom.avisoArranque(repo({ 'README.md': 'x' }, { teams: ['a'] }), { version: '1.0.0', dir }), '');
});

// ---------- presupuesto ----------

test('medirEjecucion: nº de tests y tiempo de node --test, vitest, jest y pytest', () => {
  assert.deepStrictEqual(dom.medirEjecucion('ℹ tests 1256\nℹ pass 1256\nℹ duration_ms 812345.6\n'), { tests: 1256, ms: 812346 });
  assert.deepStrictEqual(dom.medirEjecucion(' Tests  12 passed (12)\n   Duration  1.23s (transform 10ms)'), { tests: 12, ms: 1230 });
  assert.deepStrictEqual(dom.medirEjecucion('Tests:       3 passed, 3 total\nTime:        2.5 s'), { tests: 3, ms: 2500 });
  assert.deepStrictEqual(dom.medirEjecucion('===== 5 passed in 0.12s ====='), { tests: 5, ms: 120 });
  assert.deepStrictEqual(dom.medirEjecucion('nada'), { tests: null, ms: null });
});

// ---------- afinar dependientes ----------

test('afinar: un hermano afectado solo por depender ejecuta los tests que ejercitan lo que cambio', () => {
  const faro = clon(FARO);
  faro.tests.afinar = true;
  delete faro.tests.dominios.pagos.lento;
  const d = repo(FICHEROS, faro);
  const r = dom.resolver(d, ['src/clientes/index.js']);
  assert.deepStrictEqual(r.tests, ['test/clientes.test.mjs', 'test/pagos.test.mjs'], 'pagos-lento ejercita calculo.js, no lo que cambio');
  // sin afinar, el hermano ejecuta todo su dominio
  const sin = clon(faro); sin.tests.afinar = false;
  assert.ok(dom.resolver(repo(FICHEROS, sin), ['src/clientes/index.js']).tests.includes('test/pagos-lento.test.mjs'));
  // el interior propio nunca se afina
  assert.deepStrictEqual(dom.resolver(d, ['src/pagos/calculo.js']).tests, ['test/pagos-lento.test.mjs', 'test/pagos.test.mjs']);
});

// ---------- integracion: arranque y validate ----------

const instancia = (faro) => repo({ ...FICHEROS, 'ESTADO.md': '---\niniciativa: T\nfases_total: 1\nfase_actual: 1\n---\n### Fase 1 · Una — in_progress\n' }, faro);

test('arranque: repo con codigo y sin dominios -> UNA linea tras actualizar, y no se repite en la misma version', () => {
  const d = instancia({ teams: ['a'] });
  const data = path.join(os.tmpdir(), 'faro-dom-sesion', path.basename(d));
  const sesion = () => harness(d, ['session'], { CLAUDE_PLUGIN_DATA: data }).out;
  const primera = sesion();
  assert.strictEqual((primera.match(/Tests por dominio \(v/g) || []).length, 1, primera.slice(0, 400));
  assert.match(primera, /\/faro:tests/);
  assert.strictEqual((sesion().match(/Tests por dominio \(v/g) || []).length, 0, 'la misma version no repite');
});

test('arranque: con dominios declarados, silencio', () => {
  const d = instancia(FARO);
  const data = path.join(os.tmpdir(), 'faro-dom-sesion', path.basename(d));
  assert.doesNotMatch(harness(d, ['session'], { CLAUDE_PLUGIN_DATA: data }).out, /Tests por dominio \(v/);
});

test('validate: avisa de codigo sin dominio y de tests que dependen de otro dominio', () => {
  const d = instancia({ ...FARO });
  escribir(d, 'test/clientes.test.mjs', "import { iva } from '../src/pagos/calculo.js';\n");
  const r = harness(d, ['validate']);
  const l = (r.out + r.err).split('\n').filter((x) => x.includes('[tests]'));
  assert.ok(l.some((x) => /ningún dominio/.test(x) && /huerfano/.test(x)), r.out + r.err);
  assert.ok(l.some((x) => /encapsulaci/i.test(x) && /clientes/.test(x) && /pagos/.test(x)), r.out + r.err);
  assert.ok(l.every((x) => x.length < 400));
});

test('validate: sin tests.dominios no dice nada de tests', () => {
  const r = harness(instancia({ teams: ['a'] }), ['validate']);
  assert.doesNotMatch(r.out + r.err, /\[tests\]/);
});

// ---------- revision adversaria (#181) ----------

test('rendimiento: globs hostiles no cuelgan (ReDoS) y globSeguro los rechaza', () => {
  const tdd = require(path.join(HOOKS, 'lib', 'tdd.js'));
  const t0 = Date.now();
  assert.strictEqual(tdd.globRe('**/'.repeat(30) + 'x').test('a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/y'), false);
  assert.ok(Date.now() - t0 < 100, `globRe tardo ${Date.now() - t0} ms`);
  const d = repo({ 'src/a.js': '1' }, { tests: { dominios: { x: { codigo: ['**/'.repeat(10) + 'x'] }, y: { codigo: ['*/*/*/*/*/*/*/*/*/x'] }, z: { codigo: ['src/**'] } } } });
  const c = dom.config(d);
  assert.deepStrictEqual(Object.keys(c.dominios), ['z'], 'x e y se descartan');
  assert.ok(dom.validarConfig(d).length >= 2);
});

test('comandoSeguro: rechaza flags que ejecutan codigo del repo; lista cerrada de flags', () => {
  for (const mal of ['node --test --import=./evil.mjs', 'node --test --require=evil.js', 'npm test --script-shell=./evil.sh', 'npx vitest --config=evil.js', 'npx vitest run --reporter=./r.js', 'npm test --userconfig=.npmrc', 'node --test --experimental-test-coverage --loader=x']) {
    assert.strictEqual(dom.comandoSeguro(mal), null, mal);
  }
  for (const ok of ['npx vitest run --reporter=dot --coverage', 'node --test --test-concurrency=1', 'npx jest --ci --bail', 'pnpm vitest run --watch=false']) assert.ok(dom.comandoSeguro(ok), ok);
});

test('Evidencia: con espacios hostiles no es cubica y una spec enorme se recorta', () => {
  const d = repoLegacy();
  escribir(d, 'gestion/cambios/changes/c2/specs/enorme/spec.md', `Evidencia${' '.repeat(100000)}\n${'x'.repeat(400000)}`);
  const t0 = Date.now();
  dom.proponer(d);
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
});

test('nombres de dominio reservados (constructor, __proto__) se rechazan', () => {
  const d = repo({ 'src/a.js': '1' }, { tests: { dominios: { constructor: { codigo: ['src/**'] }, ok: { codigo: ['src/**'] } } } });
  assert.deepStrictEqual(Object.keys(dom.config(d).dominios), ['ok']);
  assert.match(dom.validarConfig(d).join('\n'), /constructor/);
  assert.strictEqual(dom.ordenDominio(d, 'constructor').argv, null);
});

test('aplicar: rechaza .faro.json o CLAUDE.md que sean enlaces simbolicos', (t) => {
  const d = repoLegacy();
  const real = path.join(d, 'real.json'); fs.writeFileSync(real, '{}');
  fs.rmSync(path.join(d, '.faro.json'));
  try { fs.symlinkSync(real, path.join(d, '.faro.json')); } catch { t.skip('sin permiso para symlinks'); return; }
  const r = dom.aplicar(d, { confirmo: true });
  assert.strictEqual(r.escrito, false);
  assert.match(r.motivo, /enlace/);
  assert.strictEqual(fs.readFileSync(real, 'utf8'), '{}');
});
