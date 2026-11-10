// lib/estado-indice.js — ESTADO.md como INDICE GENERADO de gestion/tareas/*.json (#149, parte 2).
//
// La linea de cada tarea en una fase se GENERA desde su registro:
//     - [ ] #N · titulo — @quien          ([x] si la tarea esta hecha o descartada)
// Es el formato que ya entienden refDeTarea, contabilidadFase, huecosDeFase y validate: aqui no se
// inventa ninguno. Todo lo demas de ESTADO.md (frontmatter, prosa, fechas, criterios, actas) es la
// capa de gestion y se preserva BYTE A BYTE, finales de linea CRLF/LF incluidos.
//
// Reglas de la regeneracion (funcion PURA sobre el texto; quien llama lee y escribe):
//   - Solo se tocan lineas '- [ ] #N ...' con #N PROPIO (id inmediatamente tras la casilla) cuyo
//     registro existe. Lineas sin #N, con referencia ajena (observabilidad#55) o sin registro: intactas.
//   - Lo que sigue al '— @quien' original (marcadores [cu:..]/[pm:..]/[bloq:..], notas) se conserva.
//   - Una linea cuyo registro vive en OTRA fase (que existe en ESTADO.md) se mueve a ella.
//   - Un registro sin linea se anade al final de las tareas de su fase.
//   - Los registros L-<n> (tareas historicas sin issue, #149 parte 3) se muestran como '- [ ] L-<n> · titulo':
//     la linea original sin #N se EMPAREJA con su registro por el texto de origen
//     (extensiones['migracion.origen'].texto) y gana su rotulo; una ya rotulada se refresca. Nunca se
//     anaden ni se mueven: si la linea no esta en ESTADO.md, el registro no la crea.
'use strict';
const fs = require('fs');
const path = require('path');
const tareas = require('./tareas-json.js');

const RE_CAB = /^###\s+Fase\s+(\d+)\s*[·:]\s*.+?\s*(?:—|--|-)\s*\w+/;
const RE_TITULO_NIVEL = /^#{1,3}\s/;
const RE_CASILLA = /^([ \t]*)-\s\[( |x|X)\]\s+(.*)$/;
const RE_LOCAL = /^L-(\d{1,6})\s*·\s*(.*)$/;
const RE_TAREA_ID = /^([ \t]*)-\s\[( |x|X)\]\s+#(\d+)\b(.*)$/;
const ESTADOS_CERRADOS = new Set(['hecha', 'descartada']);

// #293: la ruta la decide el mapa unico (faro/ESTADO.md, o ESTADO.md/INICIATIVA.md en un repo sin migrar).
const ficheroEstado = (root) => { const p = path.join(root, require('./paths.js')(root).ESTADO); return fs.existsSync(p) ? p : null; };

/** Texto de la parte que se conserva tras '— @quien' (o solo los marcadores si no habia responsable). */
function colaDe(resto) {
  const m = /^(.*)(\s—\s@[\w.-]+)(.*)$/.exec(resto);
  if (m) return m[3];
  return [...resto.matchAll(/\[(?:cu|pm|bloq|bloqueada|resp)[^\]]*\]/gi)].map((x) => ` ${x[0]}`).join('');
}

/** Una linea de indice. cola: lo que se conserva del original. */
function lineaDe(r, { indent = '', cola = '' } = {}) {
  const x = ESTADOS_CERRADOS.has(r.estado) ? 'x' : ' ';
  const quien = typeof r.responsable === 'string' && r.responsable ? ` — @${r.responsable}` : '';
  const id = typeof r.issue === 'string' ? r.issue : `#${r.issue}`;   // L-<n> sin almohadilla
  return `${indent}- [${x}] ${id} · ${r.titulo}${quien}${cola}`;
}

/** Las lineas canonicas de una lista de registros (sin cola ni sangria), en orden de id (numericos y luego L-n). */
function lineasDe(registros) {
  return [...registros].sort((a, b) => tareas.comparar(String(a.issue), String(b.issue))).map((r) => lineaDe(r));
}

function partir(texto) {
  const trozos = String(texto).split(/(\r\n|\n)/);
  const lineas = [];
  for (let i = 0; i < trozos.length; i += 2) lineas.push({ t: trozos[i], eol: trozos[i + 1] || '' });
  return lineas;
}

/**
 * -> {texto, cambios:[{id, tipo:'actualizada'|'movida'|'anadida'}]}
 * registros: objetos de tarea (se ignoran los que no tienen issue numerico o fase entera).
 */
function regenerar(texto, registros) {
  const porId = new Map();
  for (const r of registros || []) {
    if (r && Number.isInteger(r.issue) && r.issue > 0 && Number.isInteger(r.fase) && typeof r.titulo === 'string') porId.set(String(r.issue), r);
  }
  // Registros L-<n>: se emparejan por el texto de origen con las lineas sin #N (ver cabecera).
  const locales = new Map();
  const porClave = new Map();
  for (const r of registros || []) {
    if (!r || typeof r.issue !== 'string' || !/^L-\d+$/.test(r.issue) || !Number.isInteger(r.fase) || typeof r.titulo !== 'string') continue;
    locales.set(r.issue, r);
    const o = r.extensiones && typeof r.extensiones === 'object' ? r.extensiones['migracion.origen'] : null;
    if (o && typeof o.texto === 'string') { if (!porClave.has(o.texto)) porClave.set(o.texto, []); porClave.get(o.texto).push(r); }
  }
  for (const lista of porClave.values()) lista.sort((a, b) => tareas.comparar(a.issue, b.issue));
  const lineas = partir(texto);
  // Segmentos de fase: [inicio, fin) de lineas, hasta la siguiente cabecera de nivel <= 3.
  const segs = [];
  lineas.forEach((l, i) => {
    const m = RE_CAB.exec(l.t);
    if (m) segs.push({ num: Number(m[1]), ini: i, fin: lineas.length });
  });
  lineas.forEach((l, i) => {
    if (!RE_TITULO_NIVEL.test(l.t)) return;
    for (const s of segs) if (i > s.ini && i < s.fin) s.fin = i;
  });
  const segDe = new Map(segs.map((s) => [s.num, s]));
  const cambios = [];
  // rotulos L-n ya presentes en alguna fase (la primera ocurrencia manda)
  const rotulados = new Set();
  for (const s of segs) for (let i = s.ini + 1; i < s.fin; i++) {
    const c = RE_CASILLA.exec(lineas[i].t);
    const lab = c && RE_LOCAL.exec(c[3]);
    if (lab && !rotulados.has(`L-${Number(lab[1])}`)) rotulados.add(`L-${Number(lab[1])}`);
  }
  const vistosL = new Set();
  const colas = new Map();
  const colocadas = new Set();
  const borrar = new Set();

  for (const s of segs) {
    for (let i = s.ini + 1; i < s.fin; i++) {
      const m = RE_TAREA_ID.exec(lineas[i].t);
      if (!m) {
        // linea sin #N: ya rotulada (L-n) o por rotular (emparejada por su texto de origen)
        const c = RE_CASILLA.exec(lineas[i].t);
        if (!c || !locales.size) continue;
        const lab = RE_LOCAL.exec(c[3]);
        let rl = null;
        let resto = c[3];
        if (lab) { const idl = `L-${Number(lab[1])}`; if (!vistosL.has(idl)) { rl = locales.get(idl) || null; vistosL.add(idl); } resto = lab[2]; }
        else rl = (porClave.get(tareas.lineaSegura(c[3])) || []).find((x) => !rotulados.has(x.issue) && !vistosL.has(x.issue)) || null;
        if (!rl) continue;
        vistosL.add(rl.issue);
        const nuevaL = lineaDe(rl, { indent: c[1], cola: colaDe(lab ? ` · ${resto}` : resto) });
        if (nuevaL !== lineas[i].t) { lineas[i] = { t: nuevaL, eol: lineas[i].eol }; cambios.push({ id: rl.issue, tipo: 'actualizada' }); }
        continue;
      }
      const id = m[3];
      const r = porId.get(id);
      if (!r || colocadas.has(id) && segDe.has(r.fase) && r.fase === s.num) continue;   // sin registro, o duplicada: intacta
      if (r.fase !== s.num && segDe.has(r.fase)) { colas.set(id, colaDe(m[4])); borrar.add(i); continue; }
      if (colocadas.has(id)) continue;
      colocadas.add(id);
      const nueva = lineaDe(r, { indent: m[1], cola: colaDe(m[4]) });
      if (nueva !== lineas[i].t) { lineas[i] = { t: nueva, eol: lineas[i].eol }; cambios.push({ id, tipo: 'actualizada' }); }
    }
  }
  for (const id of colas.keys()) { colocadas.add(id); cambios.push({ id, tipo: 'movida' }); }

  // Inserciones: registros cuya fase existe y que aun no tienen linea (o cuya linea se movio).
  const inserciones = new Map();   // posicion -> [lineas]
  const faltan = [...porId.values()].filter((r) => !colocadas.has(String(r.issue)) && segDe.has(r.fase) || colas.has(String(r.issue)));
  faltan.sort((a, b) => a.issue - b.issue);
  const yaMovidas = new Set();
  for (const r of faltan) {
    const id = String(r.issue);
    if (yaMovidas.has(id)) continue;
    yaMovidas.add(id);
    const s = segDe.get(r.fase);
    let pos = -1;
    for (let i = s.ini + 1; i < s.fin; i++) if (RE_CASILLA.test(lineas[i].t) && !borrar.has(i)) pos = i;
    if (pos < 0) for (let i = s.ini; i < s.fin; i++) if (lineas[i].t.trim() && !borrar.has(i)) pos = i;
    const base = lineas[pos];
    const nueva = { t: lineaDe(r, { cola: colas.get(id) || '' }), eol: base.eol || (lineas.find((l) => l.eol) || { eol: '\n' }).eol };
    if (!inserciones.has(pos)) inserciones.set(pos, []);
    inserciones.get(pos).push(nueva);
    if (!colas.has(id)) cambios.push({ id, tipo: 'anadida' });
  }

  const salida = [];
  lineas.forEach((l, i) => {
    if (!borrar.has(i)) {
      const ins = inserciones.get(i);
      if (ins && !l.eol) {
        // la linea base era la ultima del fichero y no acaba en salto: se le da el de las nuevas
        salida.push({ t: l.t, eol: ins[0].eol });
        ins.forEach((x, k) => salida.push({ t: x.t, eol: k === ins.length - 1 ? '' : x.eol }));
        return;
      }
      salida.push(l);
      if (ins) salida.push(...ins);
    }
  });
  return { texto: salida.map((l) => l.t + l.eol).join(''), cambios };
}

/** Registros (numericos y L-n) de gestion/tareas/ que VALIDAN contra el esquema (lo que no valida no se vuelca a ESTADO.md). */
function leerRegistros(root) {
  return tareas.listar(root).map((id) => tareas.leerValido(root, id)).filter(Boolean);
}

/** {ruta, texto, nuevo, cambios} del ESTADO.md del repo, o null si no hay ESTADO.md o gestion/tareas/. */
function calcular(root) {
  if (!tareas.hayTareas(root)) return null;
  const ruta = ficheroEstado(root);
  if (!ruta) return null;
  const texto = fs.readFileSync(ruta, 'utf8');
  const { texto: nuevo, cambios } = regenerar(texto, leerRegistros(root));
  return { ruta, texto, nuevo, cambios };
}

/** Aviso para validate: el indice no cuadra con los JSON. null si cuadra o si el repo no usa registros. */
function aviso(root) {
  let c;
  try { c = calcular(root); } catch { return null; }
  if (!c || !c.cambios.length) return null;
  const ids = [...new Set(c.cambios.map((x) => (/^L-/.test(x.id) ? x.id : `#${x.id}`)))];
  return `el indice de tareas de ESTADO.md no cuadra con gestion/tareas/ (${ids.length} tarea(s): ${ids.slice(0, 6).join(', ')}${ids.length > 6 ? '...' : ''}) — regeneralo con: harness.js estado-indice --escribir`;
}

function cli(root, argv) {
  const comprobar = argv.includes('--comprobar');
  const escribir = argv.includes('--escribir');
  const raros = argv.filter((a) => a !== '--comprobar' && a !== '--escribir');
  if (raros.length || (comprobar && escribir)) { console.error('uso: harness.js estado-indice [--comprobar|--escribir]'); return 1; }
  const c = calcular(root);
  if (!c) { console.log('Sin gestion/tareas/ o sin ESTADO.md: no hay indice que generar.'); return 0; }
  if (!c.cambios.length) { console.log('El indice de ESTADO.md esta al dia.'); return 0; }
  const detalle = c.cambios.slice(0, 20).map((x) => `  ${/^L-/.test(x.id) ? x.id : `#${x.id}`} (${x.tipo})`).join('\n');
  if (escribir) {
    const tmp = `${c.ruta}.${process.pid}.tmp`;
    try { fs.writeFileSync(tmp, c.nuevo); fs.renameSync(tmp, c.ruta); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* ya no esta */ } console.error(e.message); return 1; }
    console.log(`ESTADO.md regenerado: ${c.cambios.length} linea(s) de tarea.\n${detalle}`);
    return 0;
  }
  console.log(`El indice de ESTADO.md esta DESACTUALIZADO (${c.cambios.length} linea(s)):\n${detalle}\nRegeneralo con: harness.js estado-indice --escribir`);
  return comprobar ? 1 : 0;
}

module.exports = { regenerar, lineasDe, lineaDe, calcular, aviso, cli };
