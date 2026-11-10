#!/usr/bin/env node
// render-doc.mjs — Rellena la plantilla faro-documento.html (hermana; faro-presentacion.html con --presentacion) con un MD. SIN dependencias.
// La plantilla es la UNICA fuente de estilo; aqui solo convertimos MD->HTML y rellenamos placeholders.
// Uso: node render-doc.mjs <entrada.md> [salida.html]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rawArgs = process.argv.slice(2);
const pres = rawArgs.includes('--presentacion') || rawArgs.includes('--presentation');
const positional = rawArgs.filter((a) => !a.startsWith('--'));
const [inArg, outArg] = positional;
if (!inArg) { console.error('Uso: node render-doc.mjs <entrada.md> [salida.html] [--presentacion]'); process.exit(1); }
const mdPath = path.resolve(inArg);
const outPath = outArg ? path.resolve(outArg) : mdPath.replace(/\.md$/i, pres ? '-presentacion.html' : '.html');
let md; try { md = fs.readFileSync(mdPath, 'utf8').replace(/\r\n/g, '\n'); } catch { console.error('No puedo leer:', inArg); process.exit(1); }
const tplFile = pres ? 'faro-presentacion.html' : 'faro-documento.html';
let tpl; try { tpl = fs.readFileSync(path.join(__dirname, tplFile), 'utf8'); } catch { console.error('Falta ' + tplFile + ' junto al script'); process.exit(1); }
const fm = {}; let body = md;
const fmm = body.match(/^---\n([\s\S]*?)\n---\n?/);
if (fmm) { fmm[1].split('\n').forEach((l) => { const m = l.match(/^(\w+):\s*(.*)$/); if (m) fm[m[1]] = m[2].trim(); }); body = body.slice(fmm[0].length); }
if (!fm.date) fm.date = new Date().toISOString().slice(0, 10);
const missing = ['doc_id', 'title', 'version', 'date', 'status', 'author', 'classification'].filter((k) => !fm[k]);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inl = (s) => s.replace(/`([^`]+)`/g, (m, c) => '<code>' + esc(c) + '</code>').replace(/==([^=]+)==/g, '<mark>$1</mark>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
const CX = { NOTE: ['note', 'Nota'], NOTA: ['note', 'Nota'], WARNING: ['warn', 'Aviso'], AVISO: ['warn', 'Aviso'], RISK: ['risk', 'Riesgo'], RIESGO: ['risk', 'Riesgo'], OK: ['ok', 'OK'] };
const isB = (l) => /^(#{1,6}\s|>\s?|```|\||\s*([-*]|\d+\.)\s+|---+\s*$)/.test(l);
function mdToHtml(src) {
  const L = src.split('\n'); const O = []; let i = 0;
  while (i < L.length) {
    const line = L[i];
    if (/^```/.test(line)) { const lang = line.slice(3).trim(); const b = []; i++; while (i < L.length && !/^```/.test(L[i])) { b.push(L[i]); i++; } i++; O.push(lang === 'mermaid' ? '<pre class="mermaid">\n' + b.join('\n') + '\n</pre>' : '<pre><code' + (lang ? ' class="language-' + lang + '"' : '') + '>' + esc(b.join('\n')) + '</code></pre>'); continue; }
    // Comentarios HTML (incl. las INSTRUCCIONES DE USO de las plantillas): NO se renderizan.
    if (/^\s*<!--/.test(line)) { while (i < L.length && !/-->/.test(L[i])) i++; i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/); if (h) { O.push('<h' + h[1].length + '>' + inl(h[2].trim()) + '</h' + h[1].length + '>'); i++; continue; }
    if (/^---+\s*$/.test(line)) { O.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(line)) {
      const b = []; while (i < L.length && /^>\s?/.test(L[i])) { b.push(L[i].replace(/^>\s?/, '')); i++; }
      // Divide el bloque de citas en segmentos: cada linea que empieza por [!TYPE] abre un callout NUEVO
      // (asi dos callouts seguidos no se fusionan); las lineas sin marcador son una cita normal.
      let seg = [], marker = null;
      const flush = () => { const txt = seg.join('\n').trim(); if (marker) { const k = CX[marker]; O.push('<div class="callout ' + k[0] + '"><span class="cx-t">' + k[1] + '</span>' + inl(txt) + '</div>'); } else if (txt) O.push('<blockquote>' + inl(txt) + '</blockquote>'); seg = []; marker = null; };
      for (const ln of b) { const cm = ln.match(/^\[!(\w+)\]\s*/); if (cm && CX[cm[1].toUpperCase()]) { flush(); marker = cm[1].toUpperCase(); seg.push(ln.replace(/^\[!\w+\]\s*/, '')); } else seg.push(ln); }
      flush(); continue;
    }
    if (/^\|.*\|/.test(line) && i + 1 < L.length && /^\|[\s:|-]+\|?\s*$/.test(L[i + 1])) { const hd = line.split('|').slice(1, -1).map((c) => c.trim()); i += 2; const rs = []; while (i < L.length && /^\|.*\|/.test(L[i])) { rs.push(L[i].split('|').slice(1, -1).map((c) => c.trim())); i++; } O.push('<table><thead><tr>' + hd.map((c) => '<th>' + inl(c) + '</th>').join('') + '</tr></thead><tbody>' + rs.map((r) => '<tr>' + r.map((c) => '<td>' + inl(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>'); continue; }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) { const od = /^\s*\d+\./.test(line); const b = []; while (i < L.length && /^\s*([-*]|\d+\.)\s+/.test(L[i])) { b.push(L[i].replace(/^\s*([-*]|\d+\.)\s+/, '')); i++; } O.push('<' + (od ? 'ol' : 'ul') + '>' + b.map((x) => '<li>' + inl(x) + '</li>').join('') + '</' + (od ? 'ol' : 'ul') + '>'); continue; }
    if (/^\s*$/.test(line)) { i++; continue; }
    const b = [line]; i++; while (i < L.length && !/^\s*$/.test(L[i]) && !isB(L[i])) { b.push(L[i]); i++; } O.push('<p>' + inl(b.join(' ')) + '</p>');
  }
  return O.join('\n');
}
let content = mdToHtml(body);
let idx = 0; const toc = [];
content = content.replace(/<(h[12])>([\s\S]*?)<\/\1>/g, (m, tag, txt) => { const id = 's' + (idx++); toc.push('<li><a href="#' + id + '">' + txt.replace(/<[^>]+>/g, '') + '</a></li>'); return '<' + tag + ' id="' + id + '">' + txt + '</' + tag + '>'; });
const tocHtml = toc.length ? '<nav class="toc"><b>Indice</b><ol>' + toc.join('') + '</ol></nav>' : '';
const bits = [];
if (fm.doc_id) bits.push('<span><b>Ref:</b> ' + fm.doc_id + '</span>');
if (fm.version) bits.push('<span><b>Version:</b> ' + fm.version + '</span>');
if (fm.date) bits.push('<span><b>Fecha:</b> ' + fm.date + '</span>');
if (fm.status) bits.push('<span><b>Estado:</b> ' + fm.status + '</span>');
if (fm.author) bits.push('<span><b>Autor:</b> ' + fm.author + '</span>');
// Sello de procedencia: rama+commit desde el que se genera. main/master LIMPIO = APROBADO (el merge es la aprobacion).
let prov = '', provState = '';
try {
  const run = (a) => execFileSync('git', a, { cwd: path.dirname(mdPath), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const br = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const sha = run(['rev-parse', '--short', 'HEAD']);
  const dirty = run(['status', '--porcelain']).split('\n').filter(Boolean).length;
  const approved = (br === 'main' || br === 'master') && dirty === 0;
  provState = approved ? 'APROBADO' : (br === 'develop' ? 'EN REVISION (no aprobado)' : 'BORRADOR (no aprobado)');
  prov = 'Generado desde ' + br + '@' + sha + (dirty ? ' (+' + dirty + ' sin commitear)' : '') + ' &mdash; ' + provState;
} catch {}
const footRef = [fm.doc_id || '', fm.version ? ('v' + String(fm.version).replace(/^v/, '')) : '', prov].filter(Boolean).join(' &middot; ');
const footL = 'Generado por FARO el ' + new Date().toISOString().slice(0, 10);
const classHtml = fm.classification ? '<div class="classification">' + fm.classification + '</div>' : '';
// Reemplazo ROBUSTO: global + funcion (rellena TODAS las ocurrencias y evita el manejo de $ en valores).
const repl = {
  TITLE: fm.title || 'Documento',
  SUBTITLE: fm.description || fm.subtitle || '',   // description es EL campo (una linea de que va); subtitle solo se lee como legado
  META: bits.join(''),
  CLASSIFICATION: classHtml,
  // En presentacion el indice no se ve (cada slide ya es un apartado) y, si va en el cuerpo, el
  // reparto en slides le abre una propia: la slide en blanco tras la portada (#105).
  BODY: (pres ? '' : tocHtml + '\n') + content,
  FOOTL: footL,
  FOOTREF: footRef,
};
const out = tpl.replace(/\{\{(TITLE|SUBTITLE|META|CLASSIFICATION|BODY|FOOTL|FOOTREF)\}\}/g, (_, k) => repl[k]);
fs.writeFileSync(outPath, out, 'utf8');
console.log('Documento generado:', path.basename(outPath), missing.length ? ('\nAVISO: faltan datos en el frontmatter: ' + missing.join(', ')) : '(frontmatter completo)');
if (provState) console.log('Procedencia: ' + prov.replace(/&mdash;/g, '—'));
