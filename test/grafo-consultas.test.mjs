// Tarea T7 del grafo FARO (#301): consultas por intencion sobre el indice.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const I = require(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'grafo', 'indice.js'));
const C = require(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'grafo', 'consultas.js'));

const escribir = (dir, rel, txt) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };
function repoCon(ficheros) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-con-'));
  for (const [rel, txt] of Object.entries(ficheros)) escribir(d, rel, txt);
  return d;
}

const FAC = {
  'src/facturas/emitir.ts': 'export function emitirFactura() {}\n',
  'src/x.ts': "import { emitirFactura } from './facturas/emitir';\nexport const x = 1;\n",
  'test/emitir.test.ts': "import { emitirFactura } from '../src/facturas/emitir';\n",
};

test('tokens: parte camelCase/snake, quita stopwords y cortas', () => {
  const t = C.tokens('emitirFactura en src/facturas_v2');
  for (const e of ['emitir', 'factura', 'facturas']) assert.ok(t.includes(e), e);
  assert.ok(!t.includes('en'));
  assert.ok(C.tokens('a b the para '.repeat(5)).length === 0);
  assert.ok(C.tokens('abcdef '.repeat(30) + Array.from({ length: 30 }, (_, i) => 'palabra' + 'x'.repeat(i)).join(' ')).length <= 12);
});

test('buscar: el codigo por encima del test', () => {
  const d = repoCon(FAC);
  const idx = I.construir(d, {});
  const r = C.buscar(idx, 'emitir factura');
  assert.strictEqual(r[0].rel, 'src/facturas/emitir.ts');
  const iTest = r.findIndex((x) => x.rel === 'test/emitir.test.ts');
  assert.ok(iTest > 0);
  assert.deepStrictEqual(C.buscar(idx, ''), []);
});

test('contexto: texto, fichero, ref citada y entradas raras', () => {
  const d = repoCon({ ...FAC, 'src/a.js': '// fix #12\nexport const a = 1;\n' });
  const idx = I.construir(d, {});
  const t = C.contexto(d, idx, 'emitir factura');
  assert.match(t.lineas[0], /^grafo contexto «emitir factura»: \d+ ficheros/);
  assert.ok(t.ficheros.includes('src/facturas/emitir.ts') && t.ficheros.includes('src/x.ts'));
  const f = C.contexto(d, idx, 'src/x.ts');
  assert.ok(f.ficheros.includes('src/x.ts') && f.ficheros.includes('src/facturas/emitir.ts'));
  const r = C.contexto(d, idx, '#12');
  assert.deepStrictEqual(r.ficheros, ['src/a.js']);
  for (const raro of ['', '../../etc', '/etc/passwd', 'x'.repeat(500)]) {
    const e = C.contexto(d, idx, raro);
    assert.strictEqual(e.ficheros.length, 0);
    assert.match(e.lineas[0], /: 0 ficheros$/);
  }
  assert.ok(C.contexto(d, idx, 'x'.repeat(500)).lineas[0].length < 100);
});

test('esqueleto: declaraciones con linea, vecinos y fichero inexistente', () => {
  const pre = Array.from({ length: 11 }, () => '').join('\n');
  const d = repoCon({ 'src/m.js': pre + '\nexport function x() {}\n', 'src/u.js': "import './m.js';\n" });
  const idx = I.construir(d, {});
  const e = C.esqueleto(d, idx, 'src/m.js');
  assert.ok(e.lineas.some((l) => l.includes('12: export function x')));
  assert.ok(e.lineas.some((l) => l.includes('lo importan:') && l.includes('src/u.js')));
  fs.rmSync(path.join(d, 'src/m.js'));
  assert.deepStrictEqual(C.esqueleto(d, idx, 'src/m.js').lineas, ['grafo: src/m.js no existe']);
  assert.deepStrictEqual(C.esqueleto(d, idx, '../../etc/passwd').lineas, ['grafo: ../../etc/passwd no existe']);
  assert.deepStrictEqual(C.esqueleto(d, idx, 'src/nada.js').lineas, ['grafo: src/nada.js no existe']);
});

test('superficie y legado', () => {
  const d = repoCon({
    'package.json': '{"main":"src/main.js"}',
    'src/main.js': "import Anthropic from '@anthropic-ai/sdk';\nconst k = process.env.API_KEY;\n",
    'src/roto.js': "import './falta.js';\n",
    'src/huerfano.js': 'export const h = 1;\n',
  });
  const idx = I.construir(d, {});
  const s = C.superficie(d, idx).lineas.join('\n');
  assert.match(s, /entradas:[\s\S]*src\/main\.js/);
  assert.match(s, /entorno:[\s\S]*src\/main\.js/);
  assert.match(s, /ia:[\s\S]*src\/main\.js/);
  const l = C.legado(d, idx);
  assert.ok(l.lineas.some((x) => x.includes('src/roto.js') && x.includes('./falta.js')));
  assert.ok(l.ficheros.includes('src/huerfano.js'));
  assert.ok(!l.ficheros.includes('src/main.js'));
});

// T9: CLI con presupuesto y medicion.
const CLI = require(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'grafo', 'cli.js'));
const USO = require(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'grafo', 'uso.js'));
const correr = (argv, root) => { const o = []; const code = CLI.cli(argv, { root, out: (l) => o.push(l) }); return { o, code }; };

test('cli: --presupuesto recorta y la ultima linea avisa del doble', () => {
  const ficheros = {};
  for (let i = 0; i < 10; i++) ficheros[`src/factura${i}.js`] = 'export const x = 1;\n';
  const d = repoCon(ficheros);
  correr(['construir'], d);
  const r = correr(['contexto', 'factura', '--presupuesto', '3'], d);
  assert.strictEqual(r.o.length, 3);
  assert.match(r.o[2], /^… \+\d+ más \(--presupuesto 6\)$/);
  assert.deepStrictEqual(CLI.recortar(['a', 'b', 'c'], 5), ['a', 'b', 'c']);
  assert.deepStrictEqual(CLI.recortar(['a', 'b', 'c', 'd', 'e'], 3), ['a', 'b', '… +3 más (--presupuesto 6)']);
});

test('cli: sin indice cada intencion avisa y devuelve 0', () => {
  const d = repoCon({ 'src/a.js': 'x\n' });
  for (const i of ['contexto', 'esqueleto', 'impacto', 'tests', 'porque', 'superficie', 'legado']) {
    const r = correr([i, 'src/a.js'], d);
    assert.deepStrictEqual(r.o, ['grafo: sin índice — harness.js grafo construir']);
    assert.strictEqual(r.code, 0);
  }
});

test('cli: --base invalido se rechaza y la medicion no guarda rutas absolutas', () => {
  const d = repoCon(FAC);
  correr(['construir'], d);
  assert.strictEqual(correr(['impacto', '--base', '--upload-pack=x'], d).code, 2);
  correr(['contexto', 'emitir factura'], d);
  correr(['esqueleto', 'src/x.ts'], d);
  const e = correr(['estado'], d).o.join('\n');
  assert.match(e, /uso: 2 consultas/);
  const f = path.join(path.dirname(I.rutaIndice(d)), 'grafo-uso.json');
  const txt = fs.readFileSync(f, 'utf8');
  assert.ok(!txt.includes(d) && !txt.includes('emitir factura'));
  assert.strictEqual(USO.leer(d).intenciones.contexto.n, 1);
  assert.strictEqual(USO.leer(fs.mkdtempSync(path.join(os.tmpdir(), 'faro-vacio-'))), null);
});

// Ola final de menores (#301).
test('esqueleto: rel ausente no lanza y pide un fichero', () => {
  const d = repoCon(FAC);
  const idx = I.construir(d, {});
  for (const mal of [undefined, '', '   ']) assert.deepStrictEqual(C.esqueleto(d, idx, mal).lineas, ['grafo: indica un fichero']);
});

test('leer: un fichero enlace simbolico no se lee', () => {
  const d = repoCon({ 'src/real.js': 'export function secreto() {}\n' });
  const idx = I.construir(d, {});
  fs.rmSync(path.join(d, 'src/real.js'));
  const fuera = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'faro-fuera-')), 'o.js');
  fs.writeFileSync(fuera, 'export function secreto() {}\n');
  try { fs.symlinkSync(fuera, path.join(d, 'src/real.js'), 'file'); } catch { return; }
  assert.deepStrictEqual(C.esqueleto(d, idx, 'src/real.js').lineas, ['grafo: src/real.js no existe']);
});

test('leer: un directorio intermedio convertido en enlace no se sigue', () => {
  const d = repoCon({ 'src/real.js': 'export function secreto() {}\n' });
  const idx = I.construir(d, {});
  const fuera = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-fuera-'));
  escribir(fuera, 'real.js', 'export function secreto() {}\n');
  fs.rmSync(path.join(d, 'src'), { recursive: true });
  try { fs.symlinkSync(fuera, path.join(d, 'src'), 'junction'); } catch { return; }
  assert.deepStrictEqual(C.esqueleto(d, idx, 'src/real.js').lineas, ['grafo: src/real.js no existe']);
});

test('cli: presupuesto invalido avisa al final; evitadas y cabecera desactualizado', () => {
  const d = repoCon(FAC);
  correr(['construir'], d);
  const r = correr(['contexto', 'emitir factura', '--presupuesto', 'abc'], d);
  assert.strictEqual(r.o[r.o.length - 1], '(presupuesto inválido: se usa 40)');
  assert.strictEqual(correr(['contexto', 'emitir factura', '--presupuesto', '5'], d).o.some((l) => /inválido/.test(l)), false);
  // evitadas con tam conocido
  const idx = I.cargar(d);
  const tam = Object.values(idx.ficheros).map((n) => n.tam);
  assert.ok(tam.every(Number.isFinite));
  const u = USO.leer(d);
  assert.ok(u.intenciones.contexto.evitadas >= 0);
  const d2 = repoCon({ 'src/grande.js': 'export const x = 1;\n'.repeat(400) });
  correr(['construir'], d2);
  correr(['esqueleto', 'src/grande.js'], d2);
  const u2 = USO.leer(d2).intenciones.esqueleto;
  assert.ok(u2.evitadas > 0, 'evitadas > 0');
  assert.match(correr(['estado'], d2).o.join('\n'), /≈[1-9]\d* líneas evitadas/);
  // desactualizado
  escribir(d2, 'src/nuevo.js', 'export const y = 2;\n');
  const s = correr(['esqueleto', 'src/grande.js'], d2);
  assert.match(s.o[0], /· índice desactualizado$/);
});

test('uso: el tmp lleva sufijo aleatorio y no se escribe a traves de un tmp plantado', () => {
  const d = repoCon(FAC);
  correr(['construir'], d);
  const p = USO.rutaUso(d);
  const fuera = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'faro-fuera-')), 'x');
  try { fs.symlinkSync(fuera, `${p}.${process.pid}.tmp`, 'file'); } catch { return; }
  assert.strictEqual(USO.registrar(d, { intencion: 'contexto', lineas: 1, ficheros: [], idx: I.cargar(d) }), true);
  assert.ok(!fs.existsSync(fuera));
});
