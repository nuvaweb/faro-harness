// lib/tareas-migracion.js — MIGRACION del historico a gestion/tareas/<N>.json (#149, parte 2).
//
//   harness.js tarea migrar [--dry-run] [--confirmo] [--incluir-cerradas]
//
// Rellena un registro por issue a partir de lo que YA existe:
//   - ESTADO.md: las lineas de fase '- [x] #N · titulo — @quien' (fases abiertas Y cerradas).
//   - la forja (si hay token): titulo, estado, hito -> fase, etiquetas app:<id> -> apps, fechas,
//     asignado -> responsable, seccion '## Objetivo' del cuerpo, checklist -> subtareas, y los PR que
//     lo cerraron (prs + resultado inicial = titulo del PR).
//   - los cambios spec-driven (proposal 'issue: N', archivados incluidos) y sus tasks.md.
//   - los REQ-NN citados en la linea o en el issue.
//
// Las lineas SIN '#N' propio (tareas historicas sin issue, p. ej. las de un ESTADO.md anterior a la forja)
// reciben un id local L-<n> (#149 parte 3): numeracion en el orden de ESTADO.md, ESTABLE (una linea ya
// numerada conserva su id aunque cambie la casilla o se anadan lineas antes) y sin colisiones; el
// registro guarda de donde viene en extensiones['migracion.origen'] = {fase, linea, texto}.
//
// NO INVENTA: lo que no se puede deducir queda con un marcador (el titulo como objetivo provisional,
// resultado null...) y el campo va en origen.revisar; `validate` lo enseña como pendiente de revisar.
// Sin forja (sin token, GitLab...) trabaja OFFLINE con solo ESTADO.md + cambios, con mas campos a revisar.
//
// IDEMPOTENTE: un registro sin `origen` migrada lo escribio una persona y NUNCA se pisa; uno migrado
// solo se actualiza en los campos que siguen en `revisar` (y en el recuento de subtareas, calculado).
//
// SEGURIDAD: todo lo que viene de la forja o del repo se valida antes de usarse (numeros enteros
// positivos, logins y slugs con patron estricto). El id de fichero lo valida tareas-json.js.
// Sin shell: la forja se lee por el transporte del motor (ghApi) y el resto es fs.
'use strict';
const fs = require('fs');
const path = require('path');
const tareas = require('./tareas-json.js');
const tarea = require('./tarea.js');
const validador = require('./validador-json.js');

const RE_CAB = /^###\s+Fase\s+(\d+)\s*[·:]\s*.+?\s*(?:—|--|-)\s*\w+/;
const RE_TITULO_NIVEL = /^#{1,3}\s/;
const RE_CASILLA = /^[ \t]*-\s\[( |x|X)\]\s+(.*)$/;
const RE_TAREA_ID = /^[ \t]*-\s\[( |x|X)\]\s+#(\d+)\b(.*)$/;
const RE_LOCAL = /^L-(\d{1,6})\s*·\s*(.*)$/;
const RE_LOGIN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RE_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const RE_APP = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RE_REQ = /\bREQ-\d{2,}\b/g;
const ORDEN_REVISAR = ['fase', 'estado', 'objetivo', 'resultado', 'justificacion', 'apps', 'fechas.creada', 'fechas.cerrada'];
const MAX_PAGINAS = 30;

const esEntero = (n) => Number.isInteger(n) && n > 0;
const dia = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) && validador.fechaValida(s.slice(0, 10)) ? s.slice(0, 10) : null);
const numerico = (a, b) => Number(a) - Number(b);

// ---------- fuentes ----------

function textoEstado(root) {
  for (const f of ['ESTADO.md', 'INICIATIVA.md']) { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { /* siguiente */ } }
  return null;
}

function tituloYQuien(resto) {
  const base = String(resto).replace(/^\s*[·:—-]\s*/, '');
  const m = /^(.*)(\s—\s@([\w.-]+))(.*)$/.exec(base);
  if (m) return { titulo: m[1].trim(), quien: RE_LOGIN.test(m[3]) ? m[3] : null };
  const limpio = base.replace(/\s*\[(?:cu|pm|bloq|bloqueada|resp)[^\]]*\]/gi, '').trim();
  const q = /@([\w.-]+)/.exec(limpio);
  return { titulo: limpio.replace(/\s*@[\w.-]+/, '').trim(), quien: q && RE_LOGIN.test(q[1]) ? q[1] : null };
}

/**
 * Lineas de tarea de las fases de ESTADO.md.
 * -> {lineas:[{id, fase, hecha, titulo, quien, texto}], sinId:[{fase, hecha, texto}]}
 * Solo lleva id propio la linea cuyo '#N' va inmediatamente tras la casilla: 'observabilidad#55' u
 * otra referencia ajena NO es un issue de este repo y se informa aparte.
 */
function leerLineas(root) {
  const out = { lineas: [], sinId: [] };
  const texto = textoEstado(root);
  if (!texto) return out;
  let fase = null;
  const crudas = texto.split(/\r?\n/);
  for (let n = 0; n < crudas.length; n++) {
    const l = crudas[n];
    const cab = RE_CAB.exec(l);
    if (cab) { fase = Number(cab[1]); continue; }
    if (RE_TITULO_NIVEL.test(l)) { fase = null; continue; }
    if (fase === null) continue;
    const m = RE_TAREA_ID.exec(l);
    if (m) {
      const { titulo, quien } = tituloYQuien(m[3]);
      out.lineas.push({ id: m[2], fase, hecha: m[1] !== ' ', titulo, quien, texto: l.trim() });
      continue;
    }
    const c = RE_CASILLA.exec(l);
    if (!c) continue;
    // '- [x] L-3 · titulo': ya rotulada por estado-indice; el id local viene en la propia linea.
    const lab = RE_LOCAL.exec(c[2]);
    const resto = lab ? lab[2] : c[2];
    const { titulo, quien } = tituloYQuien(resto);
    out.sinId.push({ fase, hecha: c[1] !== ' ', texto: l.trim(), linea: n + 1, local: lab ? `L-${Number(lab[1])}` : null, clave: tareas.lineaSegura(resto), titulo, quien });
  }
  return out;
}

/**
 * Asigna un id L-<n> a cada linea sin #N. DETERMINISTA y ESTABLE:
 *   1. una linea ya rotulada ('- [ ] L-3 · ...') conserva su id;
 *   2. una sin rotular se empareja, por texto (sin casilla), con un registro L-n existente que aun no
 *      tenga linea (en orden de id: dos lineas iguales no colisionan);
 *   3. si no, toma el siguiente numero libre (por encima de todo id L-n ya usado en disco o en ESTADO.md).
 * -> las mismas lineas con `id` anadido.
 */
function asignarLocales(root, sinId) {
  const existentes = tareas.listar(root).filter((id) => /^L-\d+$/.test(id));
  const porClave = new Map();   // texto de la linea -> ids de registros existentes, en orden
  let maximo = 0;
  for (const id of existentes) {
    maximo = Math.max(maximo, Number(id.slice(2)));
    const r = tareas.leer(root, id);
    const o = r && r.extensiones && typeof r.extensiones === 'object' ? r.extensiones['migracion.origen'] : null;
    if (o && typeof o.texto === 'string') { if (!porClave.has(o.texto)) porClave.set(o.texto, []); porClave.get(o.texto).push(id); }
  }
  const usados = new Set();
  const final = new Map();
  sinId.forEach((l, i) => {
    if (l.local && !usados.has(l.local)) { usados.add(l.local); maximo = Math.max(maximo, Number(l.local.slice(2))); final.set(i, l.local); }
  });
  sinId.forEach((l, i) => {
    if (final.has(i)) return;     // (un rotulo repetido se trata como linea sin rotular)
    const libre = (porClave.get(l.clave) || []).find((id) => !usados.has(id));
    const id = libre || `L-${(maximo += 1)}`;
    usados.add(id);
    final.set(i, id);
  });
  return sinId.map((l, i) => ({ ...l, id: final.get(i) }));
}

function frontmatter(txt) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(txt);
  const fm = {};
  if (m) for (const l of m[1].split(/\r?\n/)) { const x = /^([A-Za-z_]+):\s*(.*?)\s*$/.exec(l); if (x) fm[x[1]] = x[2].replace(/^["']|["']$/g, ''); }
  return fm;
}
const ESTADO_CAMBIO = { borrador: 'borrador', aprobada: 'aprobado', aprobado: 'aprobado', aplicando: 'aplicando', en_curso: 'aplicando', implementada: 'implementada', implementado: 'implementada' };

function contarCasillas(txt) {
  // '- [ ] <paso>' es el marcador de ejemplo de la plantilla del issue: no es una subtarea.
  const hechas = (txt.match(/^[ \t]*-\s\[[xX]\](?!\s*<[^>\n]*>\s*$)/gm) || []).length;
  const abiertas = (txt.match(/^[ \t]*-\s\[ \](?!\s*<[^>\n]*>\s*$)/gm) || []).length;
  return { hechas, total: hechas + abiertas };
}

/** Cambios spec-driven con 'issue: N' en su proposal (activos y archivados). -> [{slug, issue, estado, tareas}] */
function leerCambios(root) {
  const base = path.join(root, 'gestion', 'cambios', 'changes');
  const out = [];
  const recorrer = (dir, archivado) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || (!archivado && e.name === 'archive') || !RE_SLUG.test(e.name)) continue;
      let prop;
      try { prop = fs.readFileSync(path.join(dir, e.name, 'proposal.md'), 'utf8'); } catch { continue; }
      const fm = frontmatter(prop);
      if (!/^\d+$/.test(fm.issue || '')) continue;
      let tasks = null;
      try { tasks = contarCasillas(fs.readFileSync(path.join(dir, e.name, 'tasks.md'), 'utf8')); } catch { /* sin plan */ }
      out.push({ slug: e.name, issue: Number(fm.issue), estado: archivado ? 'archivado' : (ESTADO_CAMBIO[String(fm.estado || '').toLowerCase()] || 'borrador'), tareas: tasks && tasks.total ? tasks : null });
    }
  };
  recorrer(base, false);
  recorrer(path.join(base, 'archive'), true);
  return out.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/** Primer bloque de la seccion '## Objetivo' del cuerpo, en una linea. null si no hay. */
function seccionObjetivo(cuerpo) {
  const m = /^#{1,4}[ \t]*Objetivo[ \t]*\r?\n([\s\S]*?)(?=^#{1,4}[ \t]|(?![\s\S]))/im.exec(String(cuerpo || ''));
  const txt = m && m[1].trim().replace(/\s+/g, ' ');
  // La plantilla del issue trae '<que se consigue...>': un marcador sin rellenar no es un objetivo.
  return txt && !/^<[^>]*>$/.test(txt) ? txt : null;
}

/** Checklist del cuerpo: los de '## Subtareas' si existe; si no, todos los checkboxes. */
function subtareasDeCuerpo(cuerpo) {
  const txt = String(cuerpo || '');
  const m = /^#{1,4}[ \t]*Subtareas[ \t]*\r?\n([\s\S]*?)(?=^#{1,4}[ \t]|(?![\s\S]))/im.exec(txt);
  return contarCasillas(m ? m[1] : txt);
}

// ---------- forja ----------

/**
 * Issues (state=all) y PR (state=all) de la forja por el transporte del motor. null si no hay forja
 * con API, token o red: quien llama cae a OFFLINE. gh: {ghApi, ghRepo} (los de github.js).
 */
async function leerForja(gh) {
  if (!gh || typeof gh.ghApi !== 'function' || typeof gh.ghRepo !== 'function') return null;
  const R = gh.ghRepo();
  if (!R || !/^[A-Za-z0-9._-]+$/.test(R.org) || !/^[A-Za-z0-9._-]+$/.test(R.repo)) return null;
  const pag = async (ruta) => {
    const out = [];
    for (let p = 1; p <= MAX_PAGINAS; p++) {
      const r = await gh.ghApi(`${ruta}?state=all&per_page=100&page=${p}`);
      if (!r || !r.ok || !Array.isArray(r.body)) return p === 1 ? null : out;
      out.push(...r.body);
      if (r.body.length < 100) break;
    }
    return out;
  };
  const issues = await pag(`repos/${R.org}/${R.repo}/issues`);
  if (!issues) return null;
  const prs = (await pag(`repos/${R.org}/${R.repo}/pulls`)) || [];
  return { issues: issues.filter((i) => i && !i.pull_request), prs };
}

// ---------- construccion ----------

const iso = (ahora) => (ahora instanceof Date ? ahora : new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
const nombresEtiquetas = (i) => (Array.isArray(i.labels) ? i.labels : []).map((l) => (typeof l === 'string' ? l : l && l.name)).filter((n) => typeof n === 'string');
const faseDeHito = (i) => { const m = i && i.milestone && /^Fase\s+(\d+)\b/i.exec(String(i.milestone.title || '')); return m ? Number(m[1]) : null; };
const loginDe = (i) => {
  const a = (i && i.assignee) || (Array.isArray(i && i.assignees) && i.assignees[0]) || null;
  return a && typeof a.login === 'string' && RE_LOGIN.test(a.login) ? a.login : null;
};

function esMonorepo(root) {
  try { return require('./apps.js').esMonorepo(root); } catch { return false; }
}

function construirRegistro(id, { linea, issue, prs, cambios, monorepo, ahora }) {
  const n = Number(id);
  const revisar = new Set();
  const issueOk = !!issue;
  // Todo texto de la forja es dato no confiable: una linea, sin caracteres de control y recortado (~200).
  const ls = tareas.lineaSegura;
  const titulo = (issueOk && typeof issue.title === 'string' && ls(issue.title)) || (linea && ls(linea.titulo)) || `Issue ${n}`;
  if (!issueOk && !(linea && linea.titulo)) revisar.add('titulo');

  // fase: hito de la forja, o la fase donde ESTADO.md tiene la linea
  const fHito = faseDeHito(issue);
  let fase;
  if (linea) { fase = linea.fase; if (fHito !== null && fHito !== linea.fase) revisar.add('fase'); }
  else if (fHito !== null) fase = fHito;
  else { fase = 0; revisar.add('fase'); }

  // estado
  let estado;
  let evidencia = null;
  const misPrs = issueOk ? (prs || []).filter((p) => esEntero(p.number) && tarea.issuesDePr(p).has(n)) : [];
  if (issueOk) {
    const ev = tarea.evaluarTarea(issue, misPrs, { ramas: [] });
    evidencia = ev.evidencia;
    if (issue.state === 'closed') estado = issue.state_reason === 'not_planned' ? 'descartada' : 'hecha';
    else if (ev.estado === 'en-revision' || ev.estado === 'en-curso') estado = 'en_curso';
    else if (ev.estado === 'hecha') { estado = 'en_curso'; revisar.add('estado'); }
    else estado = 'pendiente';
  } else {
    estado = linea && linea.hecha ? 'hecha' : 'pendiente';
    revisar.add('estado');
  }

  const objetivoCrudo = issueOk ? seccionObjetivo(issue.body) : null;
  const objetivo = objetivoCrudo ? ls(objetivoCrudo) || null : null;
  if (!objetivo) revisar.add('objetivo');

  let resultado = null;
  if (estado === 'hecha') {
    resultado = (evidencia && typeof evidencia.titulo === 'string' && ls(evidencia.titulo)) || null;
    if (!resultado) revisar.add('resultado');
  }
  if (estado === 'descartada') revisar.add('justificacion');

  const creada = issueOk ? dia(issue.created_at) : null;
  if (!creada) revisar.add('fechas.creada');
  const cerrada = issueOk && (estado === 'hecha' || estado === 'descartada') ? dia(issue.closed_at) : null;
  if ((estado === 'hecha' || estado === 'descartada') && !cerrada) revisar.add('fechas.cerrada');

  const apps = [...new Set(issueOk ? nombresEtiquetas(issue).filter((l) => l.startsWith('app:')).map((l) => l.slice(4)).filter((a) => RE_APP.test(a)) : [])].sort();
  if (monorepo && !apps.length) revisar.add('apps');

  const textoReq = [linea && linea.texto, issueOk && issue.title, issueOk && issue.body].filter((x) => typeof x === 'string').join('\n');
  const requisitos = [...new Set(textoReq.match(RE_REQ) || [])].sort();

  // subtareas CALCULADAS: checklist del issue + tasks.md de sus cambios
  let hechas = 0; let total = 0; const fuente = [];
  const delIssue = issueOk ? subtareasDeCuerpo(issue.body) : { hechas: 0, total: 0 };
  if (delIssue.total) { hechas += delIssue.hechas; total += delIssue.total; fuente.push('issue'); }
  for (const c of cambios) if (c.tareas) { hechas += c.tareas.hechas; total += c.tareas.total; fuente.push(`tasks:${c.slug}`); }

  const r = {
    v: 1, issue: n, titulo, fase, estado,
    responsable: (issueOk && loginDe(issue)) || (linea && linea.quien) || null,
    ...(apps.length ? { apps } : {}),
    objetivo: objetivo || titulo, resultado, justificacion: null, requisitos,
    cambios: cambios.map((c) => ({ slug: c.slug, estado: c.estado })),
    prs: [...new Set(misPrs.map((p) => p.number))].sort(numerico),
    fechas: { creada, inicio: null, objetivo: null, cerrada, actualizada: iso(ahora) },
    subtareas: { hechas, total, fuente },
  };
  const orden = (c) => { const i = ORDEN_REVISAR.indexOf(c); return i < 0 ? 99 : i; };
  r.origen = { tipo: 'migrada', revisar: [...revisar].sort((a, b) => orden(a) - orden(b) || (a < b ? -1 : 1)) };
  return r;
}

/** Registro de una tarea historica SIN issue (id L-<n>): solo lo que dice la linea de ESTADO.md. */
function construirRegistroLocal(id, linea, { monorepo, ahora }) {
  const titulo = tareas.lineaSegura(linea.titulo) || `Tarea ${id}`;
  const revisar = new Set(['estado', 'objetivo', 'fechas.creada']);
  if (linea.hecha) { revisar.add('resultado'); revisar.add('fechas.cerrada'); }
  if (monorepo) revisar.add('apps');
  const r = {
    v: 1, issue: id, titulo, fase: linea.fase, estado: linea.hecha ? 'hecha' : 'pendiente',
    responsable: linea.quien || null,
    objetivo: titulo, resultado: null, justificacion: null,
    requisitos: [...new Set(String(linea.texto).match(RE_REQ) || [])].sort(),
    cambios: [], prs: [],
    fechas: { creada: null, inicio: null, objetivo: null, cerrada: null, actualizada: iso(ahora) },
    subtareas: { hechas: 0, total: 0, fuente: [] },
  };
  const orden = (c) => { const i = ORDEN_REVISAR.indexOf(c); return i < 0 ? 99 : i; };
  r.origen = { tipo: 'migrada', revisar: [...revisar].sort((a, b) => orden(a) - orden(b) || (a < b ? -1 : 1)) };
  r.extensiones = { 'migracion.origen': { fase: linea.fase, linea: linea.linea, texto: linea.clave } };
  return r;
}

// Lista BLANCA de campos que origen.revisar puede nombrar: lo que dice el fichero es dato no confiable y
// nunca decide por si solo que ruta del registro se escribe (ni atraviesa __proto__/constructor/prototype).
const CAMPOS_REVISABLES = new Set([...ORDEN_REVISAR, 'titulo']);
const SEG_PROHIBIDO = new Set(['__proto__', 'constructor', 'prototype']);
const rutaSegura = (p) => typeof p === 'string' && CAMPOS_REVISABLES.has(p) && !p.split('.').some((k) => SEG_PROHIBIDO.has(k));
const getPath = (o, p) => p.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o);
function setPath(o, p, valor) {
  if (!rutaSegura(p)) return;
  const ks = p.split('.');
  let v = o;
  for (const k of ks.slice(0, -1)) { if (v[k] == null || typeof v[k] !== 'object') v[k] = {}; v = v[k]; }
  if (valor === undefined) delete v[ks[ks.length - 1]]; else v[ks[ks.length - 1]] = valor;
}

/** Un migrado se actualiza solo en los campos que siguen en revisar (y en subtareas, calculado). */
function fusionar(existente, nuevo) {
  const out = JSON.parse(JSON.stringify(existente));
  const pendientes = [];
  const revisar = Array.isArray(existente.origen.revisar) ? existente.origen.revisar : [];
  for (const c of revisar) {
    if (!rutaSegura(c)) continue;                        // campo no reconocido: ni se aplica ni se conserva
    if (nuevo.origen.revisar.includes(c)) { pendientes.push(c); continue; }
    const v = getPath(nuevo, c);
    setPath(out, c, v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  }
  out.subtareas = nuevo.subtareas;
  out.origen = { tipo: 'migrada', revisar: pendientes };
  return out;
}

const sinActualizada = (r) => { const c = JSON.parse(JSON.stringify(r)); if (c.fechas) delete c.fechas.actualizada; return JSON.stringify(tareas.ordenar(c)); };

/**
 * El plan de la migracion, SIN escribir nada.
 * forja: {issues, prs} o null (offline). -> {offline, registros:[{id, accion, registro, revisar, errores}], sinId, resumen}
 * accion: 'crear' | 'actualizar' | 'igual' | 'omitir' (editado a mano o ilegible).
 */
function construirPlan(root, { forja = null, ahora = new Date(), incluirCerradas = false } = {}) {
  const { lineas, sinId } = leerLineas(root);
  const cambios = leerCambios(root);
  const monorepo = esMonorepo(root);
  const porLinea = new Map();
  for (const l of lineas) if (!porLinea.has(l.id)) porLinea.set(l.id, l);
  const issues = new Map();
  const prs = [];
  if (forja) {
    for (const i of forja.issues || []) if (i && esEntero(i.number) && !i.pull_request && !issues.has(String(i.number))) issues.set(String(i.number), i);
    for (const p of forja.prs || []) if (p && esEntero(p.number)) prs.push(p);
  }
  const ids = new Set(porLinea.keys());
  for (const [id, i] of issues) if (i.state !== 'closed' || incluirCerradas) ids.add(id);

  const registros = [];
  // existente + nuevo -> {accion, registro, ...}. Un registro sin `origen` migrada lo escribio una persona.
  const procesar = (id, construir) => {
    let existente = null;
    let ilegible = false;
    try {
      if (fs.existsSync(tareas.rutaTarea(root, id))) { existente = tareas.leer(root, id); ilegible = !existente || typeof existente !== 'object'; }
    } catch { ilegible = true; }
    if (existente && (ilegible || !existente.origen || existente.origen.tipo !== 'migrada')) {
      registros.push({ id, accion: 'omitir', registro: existente, revisar: [], motivo: ilegible ? 'JSON ilegible' : 'editado a mano', errores: [] });
      return;
    }
    if (ilegible) { registros.push({ id, accion: 'omitir', registro: null, revisar: [], motivo: 'JSON ilegible', errores: [] }); return; }
    const nuevo = construir();
    let registro = nuevo;
    let accion = 'crear';
    if (existente) {
      registro = fusionar(existente, nuevo);
      accion = sinActualizada(registro) === sinActualizada(existente) ? 'igual' : 'actualizar';
      if (accion === 'igual') registro = existente;
    }
    const errores = validador.validar(tareas.esquema(), registro);
    registros.push({ id, accion, registro, revisar: (registro.origen && registro.origen.revisar) || [], errores });
  };
  for (const id of [...ids].sort(numerico)) {
    procesar(id, () => construirRegistro(id, { linea: porLinea.get(id) || null, issue: issues.get(id) || null, prs, cambios: cambios.filter((c) => String(c.issue) === id), monorepo, ahora }));
  }
  // tareas historicas SIN #N: ids locales L-<n>, estables (ver asignarLocales)
  const locales = asignarLocales(root, sinId).sort((x, y) => tareas.comparar(x.id, y.id));
  for (const l of locales) procesar(l.id, () => construirRegistroLocal(l.id, l, { monorepo, ahora }));
  const cuenta = (a) => registros.filter((r) => r.accion === a).length;
  return {
    offline: !forja, registros, sinId,
    cambiosSinRegistro: cambios.filter((c) => !ids.has(String(c.issue))).map((c) => c.slug),
    resumen: { total: registros.length, locales: locales.length, crear: cuenta('crear'), actualizar: cuenta('actualizar'), igual: cuenta('igual'), omitir: cuenta('omitir'), dudosos: registros.filter((r) => r.accion !== 'omitir' && r.revisar.length).length },
  };
}

/** Escribe lo que el plan crea o actualiza. -> {escritos, errores:[{id, mensaje}]} */
function aplicar(root, plan, { ahora = new Date() } = {}) {
  let escritos = 0;
  const errores = [];
  for (const r of plan.registros) {
    if (r.accion !== 'crear' && r.accion !== 'actualizar') continue;
    if (r.errores && r.errores.length) { errores.push({ id: r.id, mensaje: r.errores.join('; ') }); continue; }
    try { tareas.escribir(root, r.id, r.registro, { ahora }); escritos += 1; } catch (e) { errores.push({ id: r.id, mensaje: String(e.message).split('\n')[0] }); }
  }
  return { escritos, errores };
}

// ---------- CLI ----------

const USO = 'uso: harness.js tarea migrar [--dry-run] [--confirmo] [--incluir-cerradas]';

function informe(plan) {
  const s = plan.resumen;
  const l = [];
  l.push(`Migración de tareas (#149) — ${plan.offline ? 'modo OFFLINE (sin forja o sin token): solo ESTADO.md + cambios spec-driven, más campos por revisar' : 'con forja'}.`);
  l.push(`${s.total} registro(s): ${s.crear} por crear · ${s.actualizar} por actualizar · ${s.igual} sin cambios · ${s.omitir} editados a mano (se respetan).`);
  l.push(`Dudosos (con campos en origen.revisar): ${s.dudosos}.`);
  const dud = plan.registros.filter((r) => r.accion !== 'omitir' && r.revisar.length);
  for (const r of dud.slice(0, 15)) l.push(`  ${tareas.etiqueta(r.id)}: ${r.revisar.join(', ')}`);
  if (dud.length > 15) l.push(`  ... y ${dud.length - 15} más`);
  const malos = plan.registros.filter((r) => r.errores && r.errores.length);
  for (const r of malos.slice(0, 10)) l.push(`  ERROR ${tareas.etiqueta(r.id)}: ${r.errores[0]}`);
  if (plan.cambiosSinRegistro.length) l.push(`Cambios spec-driven que citan un issue sin registro (de otro repo o fuera de ESTADO.md): ${plan.cambiosSinRegistro.length} — no se enlazan.`);
  if (plan.sinId.length) l.push(`Líneas de ESTADO.md sin #N propio: ${plan.sinId.length} — reciben un id local L-<n> (gestion/tareas/L-<n>.json, sin issue).`);
  return l;
}

async function cli(root, argv, { gh = null, ahora = new Date() } = {}) {
  const conocidos = new Set(['--dry-run', '--confirmo', '--incluir-cerradas']);
  if (argv.some((a) => !conocidos.has(a))) { console.error(USO); return 1; }
  const dry = argv.includes('--dry-run');
  const confirmo = argv.includes('--confirmo');
  let forja = null;
  try { forja = await leerForja(gh); } catch { forja = null; }
  const plan = construirPlan(root, { forja, ahora, incluirCerradas: argv.includes('--incluir-cerradas') });
  console.log(informe(plan).join('\n'));
  if (dry || !confirmo) {
    console.log(dry ? 'Simulación (--dry-run): no se ha escrito nada.' : 'Es solo el plan. Para escribir los registros: harness.js tarea migrar --confirmo');
    return plan.registros.some((r) => r.errores && r.errores.length) ? 1 : 0;
  }
  const r = aplicar(root, plan, { ahora });
  console.log(`Escritos ${r.escritos} registro(s) en gestion/tareas/.`);
  for (const e of r.errores) console.error(`${tareas.etiqueta(e.id)}: ${e.mensaje}`);
  if (r.escritos) console.log('Siguiente: revisa los campos pendientes (harness.js tarea validar) y regenera el índice: harness.js estado-indice --escribir');
  return r.errores.length ? 1 : 0;
}

module.exports = { leerLineas, asignarLocales, leerCambios, seccionObjetivo, subtareasDeCuerpo, leerForja, construirPlan, aplicar, cli };
