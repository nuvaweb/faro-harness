// #198 — los tests enfocados no acaban en la suite completa: (1) lo que ya paso en verde y no ha cambiado no
// vuelve a seleccionar tests (rama apilada, iteraciones); (2) un cambio SOLO de textos (cadenas, comentarios) en
// un contrato es interior: no arrastra a los dominios dependientes. Un cambio de codigo si.
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
const require = createRequire(import.meta.url);
const dom = require(path.join(HOOKS, 'lib', 'dominios.js'));
const val = require(path.join(HOOKS, 'lib', 'validado.js'));

const escribir = (dir, rel, txt) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };

const CONTRATO = "'use strict';\n// Cobra un importe.\nfunction cobrar(x) { return x > 0 ? `cobrado ${x} €` : 'nada que cobrar'; }\nmodule.exports = { cobrar };\n";
const repo = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-validado-'));
  git(d, 'init', '-q'); git(d, 'config', 'user.email', 'a@b.c'); git(d, 'config', 'user.name', 'T'); git(d, 'config', 'commit.gpgsign', 'false');
  escribir(d, '.faro.json', JSON.stringify({ tests: { comando: 'node --test', dominios: {
    pagos: { descripcion: 'Cobros', codigo: ['src/pagos/**'], tests: ['test/pagos.test.mjs'], contrato: ['src/pagos/cobro.js'] },
    tienda: { descripcion: 'Tienda', codigo: ['src/tienda/**'], tests: ['test/tienda.test.mjs'], dependientes: [] },
  } } }, null, 2));
  escribir(d, 'src/pagos/cobro.js', CONTRATO);
  escribir(d, 'src/tienda/caja.js', "const { cobrar } = require('../pagos/cobro.js');\nmodule.exports = () => cobrar(1);\n");
  escribir(d, 'test/pagos.test.mjs', "import '../src/pagos/cobro.js';\n");
  escribir(d, 'test/tienda.test.mjs', "import '../src/tienda/caja.js';\n");
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'base');
  return d;
};
const afectados = (d, cambiados, opts = {}) => dom.resolver(d, cambiados, { ctx: dom.contexto(d), ...opts }).afectados.map((a) => `${a.dominio}:${a.motivo}`).sort();

test('esqueleto: cadenas y comentarios fuera, el codigo se conserva (regex y ${} incluidos)', () => {
  const a = "const r = /'[a-z]\\//g; // nota\nconst t = `hola ${f('x')} adios`; /* bloque */ g(\"uno\");\n";
  const b = "const r = /'[a-z]\\//g; // otra nota distinta\nconst t = `buenas ${f('y')} hasta luego`; /* otro */ g(\"dos\");\n";
  assert.strictEqual(val.esqueleto(a), val.esqueleto(b));
  assert.notStrictEqual(val.esqueleto(a), val.esqueleto(a.replace("f('x')", "h('x')")), 'el codigo dentro de ${} cuenta');
  assert.notStrictEqual(val.esqueleto(a), val.esqueleto(a.replace('[a-z]', '[a-y]')), 'una regex es codigo, no texto');
});

test('soloTexto: cambiar un aviso o un comentario es texto; cambiar la logica no', () => {
  assert.strictEqual(val.soloTexto('src/a.js', CONTRATO, CONTRATO.replace('nada que cobrar', 'importe a cero').replace('Cobra un', 'Cobra el')), true);
  assert.strictEqual(val.soloTexto('src/a.js', CONTRATO, CONTRATO.replace('x > 0', 'x >= 0')), false);
  assert.strictEqual(val.soloTexto('src/a.js', CONTRATO, CONTRATO), false, 'sin cambios no es «solo texto»');
  assert.strictEqual(val.soloTexto('datos.json', '{"a":"x"}', '{"a":"y"}'), false, 'solo se juzga codigo JS/TS');
});

test('contrato con cambio SOLO de texto: interior, sin arrastrar dependientes; con cambio de codigo, si', () => {
  const d = repo();
  const f = 'src/pagos/cobro.js';
  assert.deepStrictEqual(afectados(d, [f]), ['pagos:contrato', 'tienda:dependiente de pagos'], 'sin informacion de texto: contrato como siempre');
  escribir(d, f, CONTRATO.replace('nada que cobrar', 'importe a cero'));
  let p = val.pendientes(d, [f], 'HEAD');
  assert.deepStrictEqual([...p.soloTexto], [f]);
  assert.deepStrictEqual(afectados(d, p.cambiados, { soloTexto: p.soloTexto }), ['pagos:interior']);
  escribir(d, f, CONTRATO.replace('x > 0', 'x >= 0'));
  p = val.pendientes(d, [f], 'HEAD');
  assert.deepStrictEqual([...p.soloTexto], []);
  assert.deepStrictEqual(afectados(d, p.cambiados, { soloTexto: p.soloTexto }), ['pagos:contrato', 'tienda:dependiente de pagos']);
});

test('lo validado en verde y sin cambios desde entonces no vuelve a seleccionar tests', () => {
  const d = repo();
  escribir(d, 'src/pagos/cobro.js', CONTRATO.replace('x > 0', 'x >= 0'));
  escribir(d, 'src/tienda/caja.js', "const { cobrar } = require('../pagos/cobro.js');\nmodule.exports = () => cobrar(2);\n");
  const cambiados = dom.cambiadosContra(d, 'HEAD').filter((x) => x.startsWith('src/'));
  val.registrarVerde(d, val.instantanea(d, cambiados));
  let p = val.pendientes(d, cambiados, 'HEAD');
  assert.deepStrictEqual(p.cambiados, []);
  assert.deepStrictEqual(p.validados.sort(), cambiados.sort());
  // un cambio NUEVO solo en la tienda: entra solo la tienda (el contrato de pagos ya paso en verde tal cual)
  escribir(d, 'src/tienda/caja.js', "const { cobrar } = require('../pagos/cobro.js');\nmodule.exports = () => cobrar(3);\n");
  p = val.pendientes(d, cambiados, 'HEAD');
  assert.deepStrictEqual(p.cambiados, ['src/tienda/caja.js']);
  assert.deepStrictEqual(afectados(d, p.cambiados, { soloTexto: p.soloTexto }), ['tienda:interior']);
  // tras el verde, cambiar solo un texto del contrato se compara con lo validado: interior
  escribir(d, 'src/pagos/cobro.js', CONTRATO.replace('x > 0', 'x >= 0').replace('nada que cobrar', 'cero'));
  p = val.pendientes(d, cambiados, 'HEAD');
  assert.ok(p.soloTexto.has('src/pagos/cobro.js'), 'se compara con la version validada, no con la base');
});

test('un fichero borrado tras el verde vuelve a contar; el registro vive en .git, no en el arbol', () => {
  const d = repo();
  escribir(d, 'src/tienda/caja.js', 'module.exports = 1;\n');
  val.registrarVerde(d, val.instantanea(d, ['src/tienda/caja.js']));
  assert.strictEqual(git(d, 'status', '--porcelain', '--', '.git'), '');
  assert.ok(fs.existsSync(path.join(d, '.git', 'faro-tests-verdes.json')));
  fs.rmSync(path.join(d, 'src/tienda/caja.js'));
  assert.deepStrictEqual(val.pendientes(d, ['src/tienda/caja.js'], 'HEAD').cambiados, ['src/tienda/caja.js']);
});
