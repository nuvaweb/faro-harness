// lib/docx.js — Imprenta de Word (.docx) con estilo neutro FARO, SIN dependencias (#121).
//
// Un .docx es un ZIP de XML (Office Open XML). Node trae zlib para comprimir; el resto es escribir el
// XML a mano. Asi el motor sigue sin dependencias y el documento es un Word de verdad (se abre, se edita
// y se reenvia), no un HTML disfrazado.
//
// Esta pieza solo IMPRIME: recibe la estructura (titulo, secciones con parrafos, listas y tablas) y
// devuelve el Buffer del .docx. El CONTENIDO lo decide quien llama (p. ej. lib/reporte-negocio.js).
'use strict';
const zlib = require('zlib');

// Paleta neutra FARO (mismos valores que las plantillas HTML): tinta casi negra + acento azul pizarra.
const MARCA = { noche: '1F2933', cian: '6B97C2', cian2: '2F5D8A', palido: 'EEF2F6', tinta: '1F2933', gris: '5B6675', borde: 'D3DAE6' };
const FUENTE = 'Segoe UI';   // Inter no viene con Office: Segoe UI es la mas cercana instalada en Windows/Office

// ── ZIP minimo (deflate) ─────────────────────────────────────────────────────────────────────────────
const TABLA_CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = TABLA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

// Fecha DOS fija (1980-01-01 00:00): valida para cualquier descompresor y el zip sale igual con el mismo contenido.
const FECHA_DOS = (0x21 << 16) >>> 0;

function zip(ficheros) {
  const locales = []; const centrales = []; let desplaz = 0;
  for (const [nombre, contenido] of ficheros) {
    const datos = Buffer.isBuffer(contenido) ? contenido : Buffer.from(contenido, 'utf8');
    const comp = zlib.deflateRawSync(datos);
    const n = Buffer.from(nombre, 'utf8');
    const crc = crc32(datos);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(0x0800, 6); loc.writeUInt16LE(8, 8);
    loc.writeUInt32LE(FECHA_DOS, 10); loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(comp.length, 18); loc.writeUInt32LE(datos.length, 22);
    loc.writeUInt16LE(n.length, 26); loc.writeUInt16LE(0, 28);
    locales.push(loc, n, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(FECHA_DOS, 12); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(datos.length, 24);
    cen.writeUInt16LE(n.length, 28); cen.writeUInt32LE(desplaz, 42);
    centrales.push(cen, n);
    desplaz += 30 + n.length + comp.length;
  }
  const central = Buffer.concat(centrales);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(ficheros.length, 8); fin.writeUInt16LE(ficheros.length, 10);
  fin.writeUInt32LE(central.length, 12); fin.writeUInt32LE(desplaz, 16);
  return Buffer.concat([...locales, central, fin]);
}

// ── XML de Word ──────────────────────────────────────────────────────────────────────────────────────
// Fuera los caracteres de control que XML 1.0 no admite: uno solo deja el Word corrupto («no se puede abrir»).
const esc = (s) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

// Texto con **negrita** (el unico enfasis que se admite: el contenido viene de markdown sencillo).
function runs(texto, { color, tam, negrita } = {}) {
  const props = (b) => `<w:rPr>${b || negrita ? '<w:b/>' : ''}${color ? `<w:color w:val="${color}"/>` : ''}${tam ? `<w:sz w:val="${tam}"/><w:szCs w:val="${tam}"/>` : ''}</w:rPr>`;
  return String(texto == null ? '' : texto).split(/(\*\*[^*]+\*\*)/).filter(Boolean)
    .map((t) => (/^\*\*[^*]+\*\*$/.test(t) ? `<w:r>${props(true)}<w:t xml:space="preserve">${esc(t.slice(2, -2))}</w:t></w:r>` : `<w:r>${props(false)}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`))
    .join('');
}
const parrafo = (texto, opts = {}) => `<w:p>${opts.estilo ? `<w:pPr><w:pStyle w:val="${opts.estilo}"/></w:pPr>` : ''}${runs(texto, opts)}</w:p>`;
const vineta = (texto) => `<w:p><w:pPr><w:pStyle w:val="Vineta"/></w:pPr>${runs(`•  ${texto}`)}</w:p>`;

function celda(texto, { fondo, color, negrita, ancho } = {}) {
  return `<w:tc><w:tcPr>${ancho ? `<w:tcW w:w="${ancho}" w:type="dxa"/>` : ''}${fondo ? `<w:shd w:val="clear" w:color="auto" w:fill="${fondo}"/>` : ''}<w:tcMar><w:top w:w="80" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/></w:tcMar></w:tcPr>`
    + `<w:p>${runs(texto, { color, negrita })}</w:p></w:tc>`;
}
function tabla({ cabecera = [], filas = [], anchos = [] }) {
  const bordes = `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((b) => `<w:${b} w:val="single" w:sz="4" w:color="${MARCA.borde}"/>`).join('')}</w:tblBorders>`;
  const fila = (cs, i, cab) => `<w:tr>${cab ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cs.map((c, j) => celda(c, cab
    ? { fondo: MARCA.noche, color: 'FFFFFF', negrita: true, ancho: anchos[j] }
    : { fondo: i % 2 ? MARCA.palido : null, ancho: anchos[j] })).join('')}</w:tr>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>${bordes}<w:tblLayout w:type="fixed"/></w:tblPr>`
    + `<w:tblGrid>${(anchos.length ? anchos : cabecera.map(() => 2000)).map((a) => `<w:gridCol w:w="${a}"/>`).join('')}</w:tblGrid>`
    + (cabecera.length ? fila(cabecera, 0, true) : '') + filas.map((f, i) => fila(f, i, false)).join('') + '</w:tbl><w:p/>';
}

// Banda de portada: celda oscura con el logo (solo si quien llama lo pasa) y el titulo en blanco.
function portada({ titulo, subtitulo, meta, conLogo, logoEmu }) {
  const img = conLogo ? `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${logoEmu.cx}" cy="${logoEmu.cy}"/><wp:docPr id="1" name="Logo"/>`
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="logo.png"/><pic:cNvPicPr/></pic:nvPicPr>'
    + `<pic:blipFill><a:blip r:embed="rIdLogo"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${logoEmu.cx}" cy="${logoEmu.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>` : '';
  const dentro = img
    + `<w:p><w:pPr><w:spacing w:before="160" w:after="40"/></w:pPr>${runs('REPORTE DE NEGOCIO', { color: MARCA.cian, tam: 18, negrita: true })}</w:p>`
    + `<w:p><w:pPr><w:spacing w:after="80"/></w:pPr>${runs(titulo, { color: 'FFFFFF', tam: 40, negrita: true })}</w:p>`
    + (subtitulo ? `<w:p>${runs(subtitulo, { color: 'AEB8CC', tam: 22 })}</w:p>` : '')
    + (meta ? `<w:p><w:pPr><w:spacing w:before="120"/></w:pPr>${runs(meta, { color: 'C7D0E0', tam: 18 })}</w:p>` : '');
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:bottom w:val="single" w:sz="24" w:color="${MARCA.cian2}"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="9600"/></w:tblGrid>`
    + `<w:tr><w:tc><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="${MARCA.noche}"/><w:tcMar><w:top w:w="360" w:type="dxa"/><w:left w:w="360" w:type="dxa"/><w:bottom w:w="360" w:type="dxa"/><w:right w:w="360" w:type="dxa"/></w:tcMar></w:tcPr>${dentro}</w:tc></w:tr></w:tbl><w:p/>`;
}

const ESTILOS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${FUENTE}" w:hAnsi="${FUENTE}" w:cs="${FUENTE}" w:eastAsia="${FUENTE}"/><w:color w:val="${MARCA.tinta}"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="es-ES"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="4" w:color="${MARCA.cian2}"/></w:pBdr><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="${MARCA.noche}"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Destacado"><w:name w:val="Destacado"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:left w:val="single" w:sz="24" w:space="8" w:color="${MARCA.cian2}"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="${MARCA.palido}"/><w:ind w:left="200"/></w:pPr><w:rPr><w:sz w:val="23"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Vineta"><w:name w:val="Vineta"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/><w:ind w:left="360" w:hanging="200"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Pie"><w:name w:val="Pie"/><w:basedOn w:val="Normal"/><w:rPr><w:color w:val="${MARCA.gris}"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>
</w:styles>`;

/**
 * Crea el .docx. `secciones`: [{ titulo, destacado?, parrafos?: [], lista?: [], tabla?: { cabecera, filas, anchos } }]
 * `logo`: Buffer PNG (opcional) con sus pixeles { ancho, alto } para el tamano.
 */
function crearDocx({ titulo, subtitulo = '', meta = '', secciones = [], pie = '', logo = null, autor = 'FARO' }) {
  const conLogo = !!(logo && logo.png);
  const alto = 520000;   // ~1,4 cm de alto en la portada; el ancho mantiene la proporcion
  const logoEmu = conLogo ? { cy: alto, cx: Math.round(alto * (logo.ancho / logo.alto)) } : null;
  let cuerpo = portada({ titulo, subtitulo, meta, conLogo, logoEmu });
  for (const s of secciones) {
    cuerpo += parrafo(s.titulo, { estilo: 'Heading1' });
    if (s.destacado) cuerpo += parrafo(s.destacado, { estilo: 'Destacado' });
    for (const p of s.parrafos || []) cuerpo += parrafo(p);
    for (const v of s.lista || []) cuerpo += vineta(v);
    if (s.tabla) cuerpo += tabla(s.tabla);
  }
  const sect = '<w:sectPr><w:footerReference w:type="default" r:id="rIdPie"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>';
  const documento = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${cuerpo}${sect}</w:body></w:document>`;
  const pieXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:ftr ${W}><w:p><w:pPr><w:pStyle w:val="Pie"/><w:pBdr><w:top w:val="single" w:sz="4" w:space="4" w:color="${MARCA.borde}"/></w:pBdr></w:pPr>${runs(pie, { color: MARCA.gris, tam: 16 })}</w:p></w:ftr>`;
  const ahora = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const ficheros = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>'],
    ['docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(titulo)}</dc:title><dc:creator>${esc(autor)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${ahora}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${ahora}</dcterms:modified></cp:coreProperties>`],
    ['word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdEstilos" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdPie" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>${conLogo ? '<Relationship Id="rIdLogo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo.png"/>' : ''}</Relationships>`],
    ['word/document.xml', documento],
    ['word/styles.xml', ESTILOS],
    ['word/footer1.xml', pieXml],
    ...(conLogo ? [['word/media/logo.png', logo.png]] : []),
  ];
  return zip(ficheros);
}

module.exports = { crearDocx, crc32, zip, MARCA };
