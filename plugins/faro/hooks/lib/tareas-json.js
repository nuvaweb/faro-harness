// lib/tareas-json.js — REGISTRO ESTRUCTURADO DE TAREAS (#149): gestion/tareas/<id>.json.
//
// Un registro = un issue (el ENTREGABLE). Es corto, validado y se lee por campo, asi el agente no
// carga ESTADO.md ni el issue para saber en que punto esta una tarea. El esquema (tarea.schema.json)
// es un NUCLEO CERRADO: un campo desconocido es error; lo propio de cada integracion va en
// `extensiones` con claves `espacio.clave`.
//
// Dos capas de validacion, a proposito separadas (la segunda se calla en fases cerradas):
//   - ESTRUCTURA (tipo 'estructura'): el registro cumple el esquema.
//   - REGLAS (tipo 'regla'): coherencia cruzada determinista (hecha exige resultado y cambios
//     archivados, descartada exige justificacion, fechas dentro de la fase, apps existentes en un
//     monorepo, un cambio pertenece a UN solo issue...).
//
// Seguridad: el id de un registro se convierte en ruta de fichero, asi que SIEMPRE pasa por
// esIdValido (^\d+$ o ^L-\d+$) antes de tocar disco. `actualizada` la escribe este modulo al
// guardar, nunca el llamante. La escritura es atomica (temporal + rename) y estable (orden de
// claves del esquema, 2 espacios, salto final).
//
// Un repo SIN gestion/tareas/ no paga nada: hayTareas() es un unico existsSync.
'use strict';
const fs = require('fs');
const path = require('path');
const validador = require('./validador-json.js');
const fasesLite = require('./fases-lite.js');

const ID_RE = /^(?:\d+|L-\d+)$/;
const FICHERO_RE = /^(\d+|L-\d+)\.json$/;
const DIR_REL = 'gestion/tareas';
// Campos que `tarea set` puede cambiar. subtareas es CALCULADO y actualizada la pone el modulo.
const CAMPOS_EDITABLES = ['estado', 'resultado', 'justificacion', 'objetivo', 'fechas.creada', 'fechas.inicio', 'fechas.objetivo', 'fechas.cerrada'];
const ANULABLES = new Set(['resultado', 'justificacion', 'fechas.creada', 'fechas.inicio', 'fechas.objetivo', 'fechas.cerrada']);
const PROHIBIDAS = new Set(['__proto__', 'constructor', 'prototype']);

let _schema = null;
function esquema() { return _schema || (_schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tarea.schema.json'), 'utf8'))); }

// ---------- ids y rutas ----------

const esIdValido = (id) => typeof id === 'string' && ID_RE.test(id);
function exigirId(id) { if (!esIdValido(id)) throw new Error(`id de tarea no valido '${String(id).slice(0, 40)}': debe ser un numero (7) o L-<n> (L-3)`); return id; }
const dirTareas = (root) => path.join(root, ...DIR_REL.split('/'));
function rutaTarea(root, id) { return path.join(dirTareas(root), `${exigirId(id)}.json`); }
function hayTareas(root) { try { return fs.statSync(dirTareas(root)).isDirectory(); } catch { return false; } }

/** Como se muestra un id: '#7' o 'L-3' (las tareas locales no llevan almohadilla). */
const etiqueta = (id) => (/^L-/.test(String(id)) ? String(id) : `#${id}`);
const claveOrden = (id) => (/^\d+$/.test(id) ? [0, Number(id)] : [1, Number(id.slice(2))]);
const comparar = (a, b) => { const x = claveOrden(a); const y = claveOrden(b); return x[0] - y[0] || x[1] - y[1]; };

/** Ids de los registros presentes, en orden estable (numericos y luego L-n). */
function listar(root) {
  if (!hayTareas(root)) return [];
  let nombres = [];
  try { nombres = fs.readdirSync(dirTareas(root)); } catch { return []; }
  return nombres.map((n) => FICHERO_RE.exec(n)).filter(Boolean).map((m) => m[1]).sort(comparar);
}

/** El registro parseado, o null si no existe o no es JSON legible. */
function leer(root, id) {
  const ruta = rutaTarea(root, id);
  if (!esFicheroRegular(ruta)) return null;
  try { return JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch { return null; }
}

/** Fichero regular y NO symlink (lstat): un enlace en gestion/tareas/ podria apuntar fuera del repo. */
function esFicheroRegular(ruta) {
  try { const st = fs.lstatSync(ruta); return st.isFile() && !st.isSymbolicLink(); } catch { return false; }
}

// ---------- estructura ----------

const validarEstructura = (registro) => validador.validar(esquema(), registro);

// ---------- reglas cruzadas ----------

const idDeIssue = (r) => String(r && r.issue);

/**
 * Reglas deterministas de coherencia de UN registro.
 * ctx: {root, id, fases:[{num,estado,objetivo,inicio}], monorepo:bool, appsIds:[], otros?:[{id,registro}]}
 * -> [{tipo:'regla', ruta, mensaje}]
 */
function validarReglas(r, ctx) {
  const out = [];
  const mal = (ruta, mensaje) => out.push({ tipo: 'regla', ruta, mensaje });
  if (!r || typeof r !== 'object') return out;
  const f = r.fechas && typeof r.fechas === 'object' ? r.fechas : {};
  const vacio = (v) => typeof v !== 'string' || !v.trim();

  if (ctx.id != null && idDeIssue(r) !== String(ctx.id)) mal('issue', `issue (${idDeIssue(r)}) no coincide con el nombre del fichero (${ctx.id}.json)`);
  if (vacio(r.objetivo)) mal('objetivo', 'objetivo es obligatorio: una frase con lo que se quiere conseguir');

  if (ctx.monorepo) {
    if (!Array.isArray(r.apps) || r.apps.length === 0) mal('apps', 'en un monorepo apps es obligatoria: indica sobre que app(s) trabaja el issue');
    else for (const a of r.apps) if (!(ctx.appsIds || []).includes(a)) mal('apps', `la app '${a}' no existe en el monorepo (apps: ${(ctx.appsIds || []).join(', ') || 'ninguna'})`);
  }

  if (r.estado === 'hecha') {
    if (vacio(r.resultado)) mal('resultado', 'hecha exige resultado: que se entrego');
    if (!f.cerrada) mal('fechas.cerrada', 'hecha exige fechas.cerrada');
    const abiertos = (Array.isArray(r.cambios) ? r.cambios : []).filter((c) => c && c.estado !== 'archivado');
    if (abiertos.length) mal('cambios', `hecha exige todos sus cambios archivados; sin archivar: ${abiertos.map((c) => `${c.slug} (${c.estado})`).join(', ')}`);
    const s = r.subtareas;
    if (s && typeof s === 'object' && s.hechas < s.total && vacio(r.justificacion)) mal('subtareas', `hecha con subtareas sin cerrar (${s.hechas}/${s.total}): ciérralas o descártalas con justificacion`);
  }
  if (r.estado === 'descartada' && vacio(r.justificacion)) mal('justificacion', 'descartada exige justificacion: por que no se hace');

  if (f.inicio && f.objetivo && f.inicio > f.objetivo) mal('fechas.inicio', `fechas.inicio (${f.inicio}) es posterior a fechas.objetivo (${f.objetivo})`);
  const fase = (ctx.fases || []).find((x) => x.num === r.fase);
  if (fase && f.objetivo) {
    if (fase.objetivo && f.objetivo > fase.objetivo) mal('fechas.objetivo', `fechas.objetivo (${f.objetivo}) pasa del objetivo de la fase ${fase.num} (${fase.objetivo})`);
    if (fase.inicio && f.objetivo < fase.inicio) mal('fechas.objetivo', `fechas.objetivo (${f.objetivo}) es anterior al inicio de la fase ${fase.num} (${fase.inicio})`);
  }

  const mios = new Set((Array.isArray(r.cambios) ? r.cambios : []).map((c) => c && c.slug));
  for (const o of ctx.otros || []) {
    for (const c of (o.registro && Array.isArray(o.registro.cambios)) ? o.registro.cambios : []) {
      if (c && mios.has(c.slug)) mal('cambios', `el cambio '${c.slug}' ya pertenece al issue ${etiqueta(o.id)}: un cambio pertenece a UN solo issue (parte el cambio o fusiona los issues)`);
    }
  }
  return out;
}

// ---------- validacion del conjunto ----------

function contexto(root) {
  let monorepo = false;
  let appsIds = [];
  try {
    const apps = require('./apps.js');
    monorepo = apps.esMonorepo(root);
    if (monorepo) appsIds = apps.apps(root).map((a) => a.id);
  } catch { /* sin apps.js legible: sin reglas de monorepo */ }
  return { root, fases: fasesLite.leerFases(root), monorepo, appsIds };
}

/**
 * Valida TODOS los registros (o solo `soloId`, pero cruzando contra el resto para los duplicados).
 * -> {total, problemas:[{id, tipo:'estructura'|'regla', ruta, mensaje, faseCerrada}]}
 */
function validarTodo(root, { id: soloId } = {}) {
  const base = contexto(root);
  const problemas = [];
  const leidos = [];
  let nombres = [];
  try { nombres = hayTareas(root) ? fs.readdirSync(dirTareas(root)) : []; } catch { /* sin acceso */ }
  for (const n of nombres.sort()) {
    if (!n.endsWith('.json')) continue;
    const m = FICHERO_RE.exec(n);
    if (!m) { problemas.push({ id: n, tipo: 'estructura', ruta: n, mensaje: `nombre de fichero no valido '${n}': debe ser <numero>.json o L-<n>.json`, faseCerrada: false }); continue; }
    const rutaFichero = path.join(dirTareas(root), n);
    if (!esFicheroRegular(rutaFichero)) {
      problemas.push({ id: m[1], tipo: 'estructura', ruta: n, mensaje: `'${n}' no es un fichero regular (enlaces simbolicos no admitidos)`, faseCerrada: false });
      continue;
    }
    let registro = null;
    // El mensaje de JSON.parse puede citar el contenido del fichero: no se vuelca.
    try { registro = JSON.parse(fs.readFileSync(rutaFichero, 'utf8')); } catch {
      problemas.push({ id: m[1], tipo: 'estructura', ruta: n, mensaje: 'JSON ilegible (no es JSON valido)', faseCerrada: false });
      continue;
    }
    leidos.push({ id: m[1], registro });
  }
  leidos.sort((a, b) => comparar(a.id, b.id));
  for (const { id, registro } of leidos) {
    if (soloId && id !== soloId) continue;
    const fase = base.fases.find((x) => x.num === (registro && registro.fase));
    const faseCerrada = !!fase && fase.estado === 'done';
    const estructura = validarEstructura(registro);
    for (const e of estructura) problemas.push({ id, tipo: 'estructura', ruta: e.split(':')[0], mensaje: e, faseCerrada });
    if (!registro || typeof registro !== 'object' || Array.isArray(registro)) continue;
    const reglas = validarReglas(registro, { ...base, id, otros: leidos.filter((o) => o.id !== id) });
    for (const e of reglas) problemas.push({ id, tipo: 'regla', ruta: e.ruta, mensaje: e.mensaje, faseCerrada });
  }
  if (soloId && !leidos.some((l) => l.id === soloId) && !problemas.some((p) => p.id === soloId)) {
    problemas.push({ id: soloId, tipo: 'estructura', ruta: `${soloId}.json`, mensaje: `no existe ${DIR_REL}/${soloId}.json`, faseCerrada: false });
  }
  return { total: soloId ? 1 : leidos.length, problemas };
}

/**
 * Avisos para `validate`: todos en fases abiertas; en fases cerradas solo los estructurales.
 * Cero coste sin gestion/tareas/.
 */
function avisos(root) {
  if (!hayTareas(root)) return [];
  const out = validarTodo(root).problemas
    .filter((p) => !(p.faseCerrada && p.tipo === 'regla'))
    .map((p) => `${etiqueta(p.id)}: ${p.mensaje}`);
  const rev = pendientesDeRevisar(root);
  if (rev.length) out.push(`${rev.length} registro(s) migrado(s) pendiente(s) de revisar (${rev.slice(0, 5).map((x) => etiqueta(x.id)).join(', ')}${rev.length > 5 ? '...' : ''}): sus campos dudosos estan en origen.revisar — detalle: harness.js tarea validar`);
  return out;
}

/** Registros migrados (#149 parte 2) con campos aun por revisar: [{id, revisar:[campos]}]. */
function pendientesDeRevisar(root) {
  const out = [];
  for (const id of listar(root)) {
    const r = leer(root, id);
    const rev = r && r.origen && Array.isArray(r.origen.revisar) ? r.origen.revisar.filter((x) => typeof x === 'string') : [];
    if (rev.length) out.push({ id, revisar: rev });
  }
  return out;
}

// ---------- escritura ----------

/** Copia del registro con las claves en el orden del esquema (las desconocidas, al final, ordenadas). */
function ordenar(registro, schema = esquema()) {
  if (Array.isArray(registro)) return registro.map((x) => ordenar(x, schema && schema.items));
  if (!registro || typeof registro !== 'object') return registro;
  const props = (schema && schema.properties) || {};
  const out = {};
  for (const k of Object.keys(props)) if (Object.prototype.hasOwnProperty.call(registro, k)) out[k] = ordenar(registro[k], props[k]);
  for (const k of Object.keys(registro).filter((x) => !Object.prototype.hasOwnProperty.call(props, x)).sort()) out[k] = ordenar(registro[k], null);
  return out;
}

const iso = (ahora) => (ahora instanceof Date ? ahora : new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Guarda el registro: pone fechas.actualizada, valida la ESTRUCTURA (lanza con .errores si falla),
 * ordena las claves y escribe de forma atomica. Las reglas cruzadas NO se exigen aqui (una migracion
 * escribe registros a revisar); `establecer` si las exige sobre lo que cambia.
 * opts: {ahora: Date}
 */
function escribir(root, id, registro, opts = {}) {
  const ruta = rutaTarea(root, id);
  const copia = JSON.parse(JSON.stringify(registro));
  if (!copia.fechas || typeof copia.fechas !== 'object') copia.fechas = {};
  copia.fechas.actualizada = iso(opts.ahora);
  const errores = validarEstructura(copia);
  if (errores.length) { const e = new Error(`registro ${id} no valido:\n  ${errores.join('\n  ')}`); e.errores = errores; throw e; }
  const final = ordenar(copia);
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  const tmp = `${ruta}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(final, null, 2) + '\n');
    fs.renameSync(tmp, ruta);
  } catch (e) { try { fs.unlinkSync(tmp); } catch { /* ya no esta */ } throw e; }
  return final;
}

// ---------- lectura/escritura por campo ----------

function segmentos(campo) {
  const segs = String(campo || '').split('.');
  if (!segs.length || segs.some((s) => !/^[A-Za-z0-9_-]+$/.test(s) || PROHIBIDAS.has(s))) throw new Error(`campo no valido '${String(campo).slice(0, 60)}'`);
  return segs;
}

/** Valor en la ruta 'a.b.c' (indices de array permitidos); lanza si no existe. */
function obtenerCampo(registro, campo) {
  let v = registro;
  for (const s of segmentos(campo)) {
    if (v == null || typeof v !== 'object' || !Object.prototype.hasOwnProperty.call(v, s)) throw new Error(`el campo '${campo}' no existe en el registro`);
    v = v[s];
  }
  return v;
}

/** Una linea con el valor: texto tal cual, null -> 'null', objetos/arrays como JSON compacto. */
function campoALinea(v) { return typeof v === 'string' ? v : JSON.stringify(v); }

/**
 * Cambia UN campo simple (CAMPOS_EDITABLES), valida y guarda. Solo falla por problemas NUEVOS:
 * lo que ya estaba mal antes del cambio no lo bloquea. 'null' pone null en los campos anulables.
 * -> el registro guardado. Lanza Error (con .errores) sin tocar el disco si el cambio no es valido.
 */
function establecer(root, id, campo, valor, opts = {}) {
  exigirId(id);
  if (!CAMPOS_EDITABLES.includes(campo)) throw new Error(`'${campo}' no se edita con set. Editables: ${CAMPOS_EDITABLES.join(', ')} (subtareas se calcula; fechas.actualizada la pone el motor)`);
  const txt = String(valor);
  if (/[\r\n]/.test(txt)) throw new Error('el valor debe ir en una sola linea');
  const actual = leer(root, id);
  if (!actual) throw new Error(`no existe un registro legible para la tarea ${id} (${DIR_REL}/${id}.json)`);
  const nuevo = JSON.parse(JSON.stringify(actual));
  const partes = campo.split('.');
  const valorFinal = txt === 'null' && ANULABLES.has(campo) ? null : txt;
  if (partes.length === 1) nuevo[partes[0]] = valorFinal;
  else { if (!nuevo[partes[0]] || typeof nuevo[partes[0]] !== 'object') nuevo[partes[0]] = {}; nuevo[partes[0]][partes[1]] = valorFinal; }

  const base = contexto(root);
  const otros = listar(root).filter((x) => x !== id).map((x) => ({ id: x, registro: leer(root, x) })).filter((o) => o.registro);
  const ctx = { ...base, id, otros };
  const mensajes = (r) => [...validarEstructura(r), ...validarReglas(r, ctx).map((e) => e.mensaje)];
  const antes = new Set(mensajes(actual));
  const nuevos = mensajes(nuevo).filter((m) => !antes.has(m));
  if (nuevos.length) { const e = new Error(`${campo} = '${txt.slice(0, 60)}' no es valido:\n  ${nuevos.join('\n  ')}`); e.errores = nuevos; throw e; }
  return escribir(root, id, nuevo, opts);
}

/**
 * El registro SOLO si cumple el esquema y su `issue` coincide con el id del fichero; si no, null.
 * Para quien vuelca registros a otro sitio (ESTADO.md, resumen.json): lo que no valida no se propaga.
 */
function leerValido(root, id) {
  const r = leer(root, id);
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if (validarEstructura(r).length) return null;
  if (/^\d+$/.test(String(id)) && String(r.issue) !== String(id)) return null;
  return r;
}

/** Texto de UNA linea para mostrar o copiar a otro fichero: sin control, espacios colapsados y recortado. */
function lineaSegura(valor, max = 200) {
  const s = String(valor === undefined || valor === null ? '' : valor).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

module.exports = {
  ID_RE, DIR_REL, etiqueta, CAMPOS_EDITABLES,
  leerValido, lineaSegura,
  esquema, esIdValido, rutaTarea, dirTareas, hayTareas, listar, leer,
  validarEstructura, validarReglas, validarTodo, avisos, pendientesDeRevisar,
  ordenar, escribir, establecer, obtenerCampo, campoALinea, comparar,
};
