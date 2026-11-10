// #121 — REPORTE DE NEGOCIO en Word (.docx) con estilo neutro FARO, adjunto a la epica y regenerado SOLO cuando
// cambia el estado de negocio. Lo lee negocio: valor entregado, plazo, KPIs y riesgos; nada tecnico.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(RAIZ, 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const docx = require(path.join(HOOKS, 'lib', 'docx.js'));
const rn = require(path.join(HOOKS, 'lib', 'reporte-negocio.js'));

/** Lee las entradas de un zip por sus cabeceras locales: { nombre: Buffer }. */
function unzip(buf) {
  const out = {};
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const comp = buf.readUInt32LE(i + 18); const nl = buf.readUInt16LE(i + 26); const xl = buf.readUInt16LE(i + 28);
    const nombre = buf.slice(i + 30, i + 30 + nl).toString('utf8');
    const ini = i + 30 + nl + xl;
    out[nombre] = zlib.inflateRawSync(buf.slice(ini, ini + comp));
    i = ini + comp;
  }
  return out;
}

const FASES = [
  { num: 1, nombre: 'API de métricas', estado: 'done', done: 4, open: 0, objetivo: '2026-09-15', descripcion: 'Expone las métricas de uso por cliente para facturación.', tareas: [{ texto: '#12 · refactor del repo en la rama feat/x', owner: 'dev' }] },
  { num: 2, nombre: 'Panel comercial', estado: 'in_progress', done: 3, open: 2, objetivo: '2026-11-30', descripcion: 'Los comerciales ven su embudo en tiempo real.', tareas: [] },
];
const MODELO = {
  meta: { nombre: 'Proyecto Planeta', objetivo: 'Medir y vender mejor.' },
  rag: { nivel: 'verde', label: 'En plazo', frase: 'sin bloqueos' },
  avance: { pct: 64 },
  kpis: { definidos: false, items: [] },
  riesgos: { top: [] },
  decisiones: [],
};
const FM = { objetivo: 'Medir y vender mejor.', fecha_inicio: '2026-07-01' };

test('docx: es un Word de verdad (zip OOXML con document, estilos, pie y propiedades) y lleva el contenido', () => {
  const buf = docx.crearDocx({ titulo: 'Proyecto & Co', secciones: [{ titulo: 'Resumen', parrafos: ['**Avance:** 50 %'], lista: ['uno'], tabla: { cabecera: ['A', 'B'], filas: [['1', '2']] } }], pie: 'Confidencial' });
  assert.strictEqual(buf.slice(0, 2).toString(), 'PK');
  const z = unzip(buf);
  for (const f of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/footer1.xml', 'docProps/core.xml']) assert.ok(z[f], `falta ${f}`);
  const doc = z['word/document.xml'].toString('utf8');
  assert.match(doc, /Proyecto &amp; Co/);
  assert.match(doc, /<w:b\/>.*Avance:/);
  assert.match(z['word/footer1.xml'].toString('utf8'), /Confidencial/);
});

test('docx: un caracter de control en el texto no corrompe el XML', () => {
  const z = unzip(docx.crearDocx({ titulo: 'Malo\u0001\u000b', secciones: [{ titulo: 'x\u0007', parrafos: ['ok'] }] }));
  assert.doesNotMatch(z['word/document.xml'].toString('utf8'), /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
});

test('docx: con logo, el PNG va dentro y enlazado desde el documento', () => {
  // PNG 1x1 valido: el motor no trae logo propio, pero quien llama puede pasar uno.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const logo = { png, ancho: png.readUInt32BE(16), alto: png.readUInt32BE(20) };
  const z = unzip(docx.crearDocx({ titulo: 'T', secciones: [], logo }));
  assert.ok(z['word/media/logo.png'] && z['word/media/logo.png'].equals(png), 'el PNG va dentro tal cual');
  assert.match(z['word/_rels/document.xml.rels'].toString('utf8'), /media\/logo\.png/);
  assert.match(z['word/document.xml'].toString('utf8'), /r:embed="rIdLogo"/);
});

test('reporte neutro: sin logo de marca (la plantilla no trae imagen) y pie generico «Generado por FARO el <fecha>»', () => {
  assert.strictEqual(rn.logoMarca(), null, 'la plantilla neutra faro-informe.html no trae logo');
  const { buffer } = rn.generarReporte({ modelo: MODELO, fases: FASES, fm: FM, hoy: '2026-10-01' });
  const z = unzip(buffer);
  assert.ok(!z['word/media/logo.png'], 'sin logo no se empaqueta imagen');
  assert.doesNotMatch(z['word/_rels/document.xml.rels'].toString('utf8'), /rIdLogo/);
  assert.match(z['word/footer1.xml'].toString('utf8'), /Generado por FARO el 2026-10-01/);
  for (const [n, b] of Object.entries(z)) {
    if (/\.(xml|rels)$/.test(n)) assert.doesNotMatch(b.toString('utf8'), new RegExp(['fract' + 'alia', 'CONFIDENCIAL', 'uso interno'].join('|'), 'i'), n);
  }
});

test('contenido: habla de NEGOCIO — entregables con su valor, plazo y proximos pasos; nada de issues, ramas ni repos', () => {
  const c = rn.contenidoReporte({ modelo: MODELO, fases: FASES, fm: FM });
  const titulos = c.secciones.map((s) => s.titulo);
  for (const t of ['Resumen ejecutivo', 'Entregables y valor aportado', 'Plazo', 'Indicadores (KPIs)', 'Riesgos y bloqueos', 'Próximos pasos']) assert.ok(titulos.includes(t), t);
  const texto = JSON.stringify(c.secciones);
  assert.match(texto, /Los comerciales ven su embudo/);
  assert.doesNotMatch(texto, /#12|feat\/x|\brama\b|\brepo\b/i);
  assert.strictEqual(c.fin, '2026-11-30');
});

test('huella: no depende de la fecha de generacion y cambia si cambia el estado de negocio', () => {
  const a = rn.generarReporte({ modelo: MODELO, fases: FASES, fm: FM, hoy: '2026-10-01' });
  const b = rn.generarReporte({ modelo: MODELO, fases: FASES, fm: FM, hoy: '2026-10-12' });
  assert.strictEqual(a.huella, b.huella, 'mismo estado, otro dia: misma huella');
  const fases2 = FASES.map((f) => (f.num === 2 ? { ...f, estado: 'done', done: 5, open: 0 } : f));
  const c = rn.generarReporte({ modelo: MODELO, fases: fases2, fm: FM, hoy: '2026-10-12' });
  assert.notStrictEqual(c.huella, a.huella);
});

test('huella: un KPI desactualizado («hace Nd») no la cambia de un dia a otro; renombrar el proyecto si', () => {
  const conKpi = (estado) => ({ ...MODELO, kpis: { definidos: true, items: [{ nombre: 'Conversión', obj: '5 %', actual: '3 %', estado }] } });
  const a = rn.contenidoReporte({ modelo: conKpi('hace 34d'), fases: FASES, fm: FM });
  const b = rn.contenidoReporte({ modelo: conKpi('hace 35d'), fases: FASES, fm: FM });
  assert.strictEqual(a.huella, b.huella);
  const c = rn.contenidoReporte({ modelo: conKpi('2026-10-10'), fases: FASES, fm: FM });
  assert.notStrictEqual(c.huella, a.huella, 'una medición nueva sí cambia el estado de negocio');
  const d = rn.contenidoReporte({ modelo: { ...MODELO, meta: { ...MODELO.meta, nombre: 'Planeta 2' } }, fases: FASES, fm: FM });
  assert.notStrictEqual(d.huella, rn.contenidoReporte({ modelo: MODELO, fases: FASES, fm: FM }).huella);
});

test('contenido: sin descripción ni valor de fase, el Word no da instrucciones internas (ESTADO.md, «fase»)', () => {
  const c = rn.contenidoReporte({ modelo: { ...MODELO, meta: { nombre: 'X' } }, fases: FASES.map((f) => ({ ...f, descripcion: '' })), fm: {} });
  assert.doesNotMatch(JSON.stringify(c.secciones), /ESTADO\.md|objetivo:|falta describir/);
});

test('docx: Heading1 respeta el orden del esquema (pBdr antes de spacing) y el zip lleva fecha DOS valida', () => {
  const buf = docx.crearDocx({ titulo: 'T', secciones: [{ titulo: 'S' }] });
  const est = unzip(buf)['word/styles.xml'].toString('utf8');
  const h = est.slice(est.indexOf('styleId="Heading1"'));
  assert.ok(h.indexOf('<w:pBdr>') < h.indexOf('<w:spacing'), 'pBdr debe ir antes que spacing');
  assert.notStrictEqual(buf.readUInt16LE(12), 0, 'fecha DOS distinta de 0');
});

test('harness reporte-negocio: genera el Word datado en gestion/reporting/informes y el mismo dia lo actualiza', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-reporte-'));
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), `---
iniciativa: Planeta
clave: PLANETA
objetivo: Medir y vender mejor.
fases_total: 1
fase_actual: 1
owner: tester
---
# Estado

### Fase 1 · Piloto — in_progress
Objetivo: 2026-12-01
- [ ] Tarea de prueba
`);
  const correr = () => spawnSync(process.execPath, [path.join(HOOKS, 'harness.js'), 'reporte-negocio', '--json'], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  const r = correr();
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.match(j.ruta, /^gestion\/reporting\/informes\/\d{4}-\d{2}-\d{2}-reporte-negocio\.docx$/);
  const z = unzip(fs.readFileSync(path.join(dir, j.ruta)));
  assert.match(z['word/document.xml'].toString('utf8'), /Piloto/);
  const r2 = correr();
  assert.strictEqual(JSON.parse(r2.stdout.trim().split('\n').pop()).huella, j.huella);
  assert.strictEqual(fs.readdirSync(path.join(dir, 'gestion', 'reporting', 'informes')).length, 1, 'misma fecha = se actualiza, no se duplica');
});
