// lib/navegacion.js — NAVEGAR por el grafo de gestion (#157): resolver una referencia EN VIVO,
// saber quien la cita y detectar referencias rotas.
//
//   resolver(root, texto) -> {ref, tipo, ruta, estado, resumen:[..], relacionados:[refs], datos}
//                            lanza Error con .codigo = 'invalida'|'no-existe'|'ambigua'
//   citas(root, texto)    -> [{tipo, ruta}]       (quien cita la referencia)
//   rotas(root)           -> [{origen, ref, motivo}]  (registros que citan algo que no existe)
//   avisoRotas(root)      -> string|null          (una linea para `validate`, nunca bloquea)
//   lineaNavegacion()     -> la linea del indice de sesion
//
// BARATO por diseno: cada tipo va a SU fichero (tarea -> gestion/tareas/<N>.json, cambio -> su
// carpeta, REQ/R -> una pasada por su fichero, app -> lib/apps.js, fase -> ESTADO.md). Solo `doc`
// (un doc_id puede estar en cualquier .md) y `refs` recorren carpetas, y lo hacen por nombre y
// con tope. Sin dependencias del motor: lo despacha harness.js antes de cargarlo.
//
// SEGURIDAD: ninguna ruta se construye con texto que no haya pasado por referencias.analizar
// (patron estricto: sin '.', separadores ni espacios). El id de tarea ademas pasa por esIdValido.
'use strict';
const fs = require('fs');
const path = require('path');
const refs = require('./referencias.js');
const tareas = require('./tareas-json.js');
const fasesLite = require('./fases-lite.js');

const CAMBIOS_REL = 'gestion/cambios/changes';
const REQS_REL = 'gestion/requisitos.md';
const RIESGOS_REL = 'gestion/risks.md';
const TOPE_FICHEROS = 4000;
const NO_ENTRAR = new Set(['node_modules', '.git', '.claude', '.hg', 'dist', 'build']);

const error = (codigo, mensaje) => Object.assign(new Error(mensaje), { codigo });
const leer = (root, rel) => { try { return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8'); } catch { return null; } };
const esDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const corto = (s, n = 140) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const limpio = (s) => String(s).replace(/[^\x20-\x7e -￿]/g, '?').slice(0, 40);
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function frontmatter(texto) {
  const m = texto && /^---\r?\n([\s\S]*?)\r?\n---/.exec(texto);
  const fm = {};
  if (!m) return fm;
  for (const l of m[1].split(/\r?\n/)) {
    const x = /^([A-Za-z_][\w-]*):\s*(.*?)\s*$/.exec(l);
    if (x) fm[x[1]] = x[2].replace(/^["']|["']$/g, '');
  }
  return fm;
}

/** .md bajo una carpeta (rutas relativas a root, con '/'), con tope y sin carpetas pesadas. */
function ficherosMd(root, relDir, { saltar = [], presupuesto = { n: TOPE_FICHEROS } } = {}) {
  const out = [];
  const rec = (rel) => {
    let ents = [];
    try { ents = fs.readdirSync(path.join(root, ...rel.split('/')), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (presupuesto.n <= 0) return;
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) { if (!NO_ENTRAR.has(e.name) && !saltar.includes(r)) rec(r); }
      else if (e.isFile() && /\.md$/i.test(e.name)) { presupuesto.n -= 1; out.push(r); }
    }
  };
  rec(relDir);
  return out;
}

const todasTareas = (root) => tareas.listar(root).map((id) => ({ id, r: tareas.leer(root, id) })).filter((x) => x.r && typeof x.r === 'object');
const idRef = (id) => (/^\d+$/.test(id) ? `#${id}` : id);
const unicos = (a) => [...new Set(a)];

// ---------- resolutores ----------

function resolverTarea(root, a) {
  const id = a.id;
  if (!tareas.esIdValido(id)) throw error('invalida', `referencia no válida '${limpio(a.ref)}'`);
  const r = tareas.leer(root, id);
  if (r && typeof r === 'object') {
    const s = r.subtareas || {};
    const f = r.fechas || {};
    return {
      ref: idRef(id), tipo: 'tarea', ruta: `gestion/tareas/${id}.json`, estado: r.estado,
      resumen: [
        corto(r.titulo),
        corto(`Objetivo: ${r.objetivo}`),
        `Fase ${r.fase} · subtareas ${s.hechas || 0}/${s.total || 0} · objetivo ${f.objetivo || '-'}${r.prs && r.prs.length ? ` · PR ${r.prs.map((p) => `#${p}`).join(' ')}` : ''}`,
      ],
      relacionados: [
        ...(Number.isInteger(r.fase) ? [`fase:${r.fase}`] : []),
        ...(r.requisitos || []),
        ...(r.cambios || []).map((c) => `cambio:${c.slug}`),
        ...(r.apps || []).map((x) => `app:${x}`),
      ],
      datos: r,
    };
  }
  // Repos aun sin registro JSON: la casilla de ESTADO.md.
  const txt = leer(root, 'ESTADO.md');
  const m = txt && new RegExp(`^[ \\t]*[-*][ \\t]*\\[([ xX])\\][ \\t]*#${esc(id)}\\b[ \\t]*[·:-]?[ \\t]*(.*)$`, 'm').exec(txt);
  if (m) return { ref: idRef(id), tipo: 'tarea', ruta: 'ESTADO.md', estado: m[1] === ' ' ? 'pendiente' : 'hecha', resumen: [corto(m[2])], relacionados: [], datos: { titulo: m[2].trim() } };
  throw error('no-existe', `no existe la tarea ${idRef(id)}: ni gestion/tareas/${id}.json ni una casilla en ESTADO.md`);
}

function resolverCambio(root, a) {
  const slug = a.id;
  let rel = `${CAMBIOS_REL}/${slug}`;
  let archivado = false;
  if (!esDir(path.join(root, ...rel.split('/')))) {
    rel = `${CAMBIOS_REL}/archive/${slug}`;
    archivado = true;
    if (!esDir(path.join(root, ...rel.split('/')))) throw error('no-existe', `no existe el cambio '${slug}': ni ${CAMBIOS_REL}/${slug}/ ni ${CAMBIOS_REL}/archive/${slug}/`);
  }
  const texto = leer(root, `${rel}/proposal.md`) || '';
  const fm = frontmatter(texto);
  const citadoPor = todasTareas(root).filter((t) => (t.r.cambios || []).some((c) => c && c.slug === slug)).map((t) => idRef(t.id));
  const reqs = unicos(texto.match(/\bREQ-\d{2,4}\b/g) || []).slice(0, 6);
  return {
    ref: `cambio:${slug}`, tipo: 'cambio', ruta: rel, estado: archivado ? 'archivado' : (fm.estado || '(sin estado)'),
    resumen: [corto(fm.titulo || slug), corto(fm.descripcion || '')].filter(Boolean),
    relacionados: [...(fm.issue && /^\d+$/.test(fm.issue) ? [`#${fm.issue}`] : []), ...citadoPor, ...reqs],
    datos: { ...fm, archivado },
  };
}

function resolverReq(root, a) {
  const texto = leer(root, REQS_REL);
  if (texto == null) throw error('no-existe', `no existe ${a.ref}: falta ${REQS_REL}`);
  const lineas = texto.split(/\r?\n/);
  const n = Number(a.id);
  const i = lineas.findIndex((l) => { const m = /^##\s+REQ-(\d+)\b/.exec(l); return m && Number(m[1]) === n; });
  if (i < 0) throw error('no-existe', `no existe ${a.ref} en ${REQS_REL}`);
  let fin = lineas.length;
  for (let j = i + 1; j < lineas.length; j++) if (/^##\s/.test(lineas[j])) { fin = j; break; }
  const seg = lineas.slice(i, fin);
  const campo = (k) => { const x = seg.map((l) => new RegExp(`^[-*]\\s*${k}\\s*:\\s*(.+)$`, 'i').exec(l)).find(Boolean); return x ? x[1].trim() : null; };
  const nombre = seg[0].replace(/^##\s+REQ-\d+\s*[·:]\s*/, '').trim();
  const estado = campo('estado');
  const origen = campo('origen');
  return {
    ref: a.ref, tipo: 'req', ruta: `${REQS_REL}:${i + 1}`, estado: estado || '(sin estado)',
    resumen: [corto(nombre), ...(origen ? [`Origen: ${corto(origen, 120)}`] : [])],
    relacionados: todasTareas(root).filter((t) => (t.r.requisitos || []).some((q) => Number(String(q).replace(/\D/g, '')) === n)).map((t) => idRef(t.id)),
    datos: { nombre, estado, origen },
  };
}

function resolverRiesgo(root, a) {
  const texto = leer(root, RIESGOS_REL);
  if (texto == null) throw error('no-existe', `no existe ${a.ref}: falta ${RIESGOS_REL}`);
  const lineas = texto.split(/\r?\n/);
  const n = Number(a.id);
  let cab = null;
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i];
    if (/^\|/.test(l) && /\bID\b/i.test(l) && !cab) cab = l.split('|').slice(1, -1).map((c) => c.trim().toLowerCase());
    const fila = /^\|\s*R-?(\d+)\s*\|/.exec(l);
    if (fila && Number(fila[1]) === n) {
      const cols = l.split('|').slice(1, -1).map((c) => c.trim());
      const idx = (re, def) => { const k = cab ? cab.findIndex((c) => re.test(c)) : -1; return k >= 0 ? k : def; };
      const desc = cols[idx(/desc|riesgo|titulo|t[ií]tulo/, 2)] || '';
      const estado = cols[idx(/estado|status/, cols.length - 1)] || '(sin estado)';
      const imp = cols[idx(/impacto/, -1)];
      return { ref: a.ref, tipo: 'riesgo', ruta: `${RIESGOS_REL}:${i + 1}`, estado, resumen: [corto(desc), ...(imp ? [`Impacto: ${imp}`] : [])], relacionados: [], datos: { desc, estado, impacto: imp || null } };
    }
    const cab2 = /^#{2,4}\s+R-?(\d+)\b\s*[·:-]?\s*(.*)$/.exec(l);
    if (cab2 && Number(cab2[1]) === n) {
      let fin = lineas.length;
      for (let j = i + 1; j < lineas.length; j++) if (/^#{1,4}\s/.test(lineas[j])) { fin = j; break; }
      const seg = lineas.slice(i, fin).join('\n');
      const est = /^[-*]?\s*estado\s*:\s*(.+)$/im.exec(seg);
      return { ref: a.ref, tipo: 'riesgo', ruta: `${RIESGOS_REL}:${i + 1}`, estado: est ? est[1].trim() : '(sin estado)', resumen: [corto(cab2[2])], relacionados: [], datos: { desc: cab2[2].trim() } };
    }
  }
  throw error('no-existe', `no existe ${a.ref} en ${RIESGOS_REL}`);
}

// Cabecera (1 KB) de un .md: el frontmatter cabe de sobra y evita leer documentos enteros.
function cabecera(root, rel) {
  let fd;
  try {
    fd = fs.openSync(path.join(root, ...rel.split('/')), 'r');
    const buf = Buffer.alloc(1024);
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, 1024, 0));
  } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ya cerrado */ } }
}

/**
 * Ficheros con ese doc_id. Primero por NOMBRE (el ID viaja en el nombre: <doc_id>-<slug>.md), que es
 * barato; solo si ninguno lo declara se mira la cabecera de los demas .md. Un doc_id repetido en
 * otro fichero con otro nombre lo senala validate ([docs] duplicado).
 */
function buscarDocs(root, id) {
  const minus = id.toLowerCase();
  const docIdDe = (f) => { const m = /^doc_id:\s*["']?([A-Za-z0-9-]+)/m.exec(cabecera(root, f)); return m ? m[1].toUpperCase() : null; };
  const verifica = (f) => docIdDe(f) === id;
  const nombre = (f) => f.split('/').pop().toLowerCase();
  // documentos/ primero (es donde viven); gestion/ solo si alli no esta.
  for (const [dir, opts] of [['documentos', {}], ['gestion', { saltar: ['gestion/tareas'] }]]) {
    const todos = ficherosMd(root, dir, opts);
    const porNombre = todos.filter((f) => nombre(f) === minus + '.md' || nombre(f).startsWith(minus + '-')).filter(verifica);
    const halladas = porNombre.length ? porNombre : todos.filter(verifica);
    if (halladas.length) return halladas;
  }
  return [];
}

function resolverDoc(root, a) {
  const f = buscarDocs(root, a.id);
  if (!f.length) throw error('no-existe', `no existe un documento controlado con doc_id ${a.ref} (busca en documentos/ y gestion/)`);
  if (f.length > 1) throw error('ambigua', `referencia ambigua: ${a.ref} está en ${f.length} ficheros:\n  ${f.slice(0, 5).join('\n  ')}`);
  const texto = leer(root, f[0]) || '';
  const fm = frontmatter(texto);
  const citados = unicos((texto.slice(texto.indexOf('---', 3)).match(/\bREQ-\d{2,4}\b/g) || [])).slice(0, 6);
  return {
    ref: a.ref, tipo: 'doc', ruta: f[0], estado: fm.status || '(sin status)',
    resumen: [corto(fm.title || path.basename(f[0])), `v${fm.version || '?'} · ${fm.date || 's/f'}${fm.author ? ` · ${fm.author}` : ''}`],
    relacionados: citados, datos: fm,
  };
}

function resolverApp(root, a) {
  const apps = require('./apps.js');
  if (!apps.esMonorepo(root)) throw error('no-existe', `no existe app:${a.id}: este repo no declara monorepo (.faro.json > monorepo)`);
  const app = apps.apps(root).find((x) => x.id === a.id);
  if (!app) throw error('no-existe', `no existe app:${a.id}: no está declarada ni descubierta (apps: ${apps.apps(root).map((x) => x.id).join(', ') || 'ninguna'})`);
  const rasgos = apps.rasgosTexto(app);
  const claude = app.ruta ? (app.claudeMd ? `${app.ruta}/CLAUDE.md` : 'sin CLAUDE.md') : null;
  return {
    ref: `app:${a.id}`, tipo: 'app', ruta: app.ruta || '(declarada, sin carpeta)', estado: app.existe ? 'existe' : 'declarada sin carpeta',
    resumen: [corto(app.rol || app.paquete || a.id), ...(rasgos ? [corto(`Rasgos: ${rasgos}`)] : []), ...(claude ? [`CLAUDE.md: ${claude}`] : []), ...(app.contrato ? [`Contrato: ${app.contrato}`] : [])],
    relacionados: [...(app.funcional ? [app.funcional] : []), ...todasTareas(root).filter((t) => (t.r.apps || []).includes(a.id)).map((t) => idRef(t.id))],
    datos: { id: app.id, ruta: app.ruta, tipo: app.tipo, rol: app.rol, version: app.version, paquete: app.paquete, contrato: app.contrato, claudeMd: app.claudeMd, funcional: app.funcional, equipo: app.equipo },
  };
}

function resolverFase(root, a) {
  const n = Number(a.id);
  const f = fasesLite.leerFases(root).find((x) => x.num === n);
  if (!f) throw error('no-existe', `no existe fase:${n} en ESTADO.md`);
  const ids = todasTareas(root).filter((t) => t.r.fase === n).map((t) => idRef(t.id));
  let rel = ids;
  if (!rel.length) {
    const txt = fasesLite.textoEstado(root) || '';
    const ini = txt.search(new RegExp(`^###\\s+Fase\\s+${n}\\b`, 'm'));
    if (ini >= 0) {
      const resto = txt.slice(ini + 4);
      const fin = resto.search(/^###\s/m);
      rel = unicos((resto.slice(0, fin < 0 ? undefined : fin).match(/^\s*[-*]\s*\[[ xX]\]\s*(#\d+)/gm) || []).map((l) => l.replace(/^[^#]*/, '')));
    }
  }
  return {
    ref: `fase:${n}`, tipo: 'fase', ruta: 'ESTADO.md', estado: f.estado,
    resumen: [corto(f.nombre), `Inicio ${f.inicio || '-'} · objetivo ${f.objetivo || '-'} · ${rel.length} tarea(s)`],
    relacionados: rel, datos: f,
  };
}

const RESOLUTORES = { tarea: resolverTarea, cambio: resolverCambio, req: resolverReq, riesgo: resolverRiesgo, doc: resolverDoc, app: resolverApp, fase: resolverFase };

function resolver(root, texto) {
  const a = refs.analizar(texto);
  if (!a) throw error('invalida', `referencia no válida '${limpio(texto)}'. Formas: ${refs.ejemplos().join(' · ')}`);
  return RESOLUTORES[a.tipo](root, a);
}

// ---------- quien cita ----------

function regexCita(a) {
  const num = (s) => `0*${Number(s)}(?!\\d)`;
  switch (a.tipo) {
    case 'req': return new RegExp(`(?<![\\w-])REQ-${num(a.id)}`);
    case 'riesgo': return new RegExp(`(?<![\\w-])R-?${num(a.id)}`);
    case 'tarea': return /^\d+$/.test(a.id)
      ? new RegExp(`(?<![\\w&/])#${esc(a.id)}(?!\\d)|^issue:\\s*${esc(a.id)}\\s*$`, 'm')
      : new RegExp(`(?<![\\w-])${esc(a.id)}(?!\\d)`);
    case 'cambio': return new RegExp(`(?<![\\w-])(?:cambio:)?${esc(a.id)}(?![\\w-])`);
    case 'app': return new RegExp(`(?<![\\w-])app:${esc(a.id)}(?![\\w.-])`);
    case 'fase': return new RegExp(`(?<![\\w-])fase:${esc(a.id)}(?!\\d)|^fase:\\s*${esc(a.id)}\\s*$`, 'm');
    default: return new RegExp(esc(a.ref), 'i');
  }
}

function tipoDeRuta(rel) {
  if (rel === 'ESTADO.md' || rel === 'INICIATIVA.md') return 'estado';
  if (rel.startsWith(`${CAMBIOS_REL}/`)) return 'cambio';
  if (rel.startsWith('gestion/cambios/specs/')) return 'spec';
  if (rel.startsWith('documentos/')) return 'doc';
  return 'gestion';
}

function citas(root, texto) {
  const a = refs.analizar(texto);
  if (!a) throw error('invalida', `referencia no válida '${limpio(texto)}'. Formas: ${refs.ejemplos().join(' · ')}`);
  const out = [];
  // 1) Registros JSON de tareas (campos exactos, sin leer texto libre).
  for (const { id, r } of todasTareas(root)) {
    let cita = false;
    if (a.tipo === 'req') cita = (r.requisitos || []).some((q) => Number(String(q).replace(/\D/g, '')) === Number(a.id));
    else if (a.tipo === 'cambio') cita = (r.cambios || []).some((c) => c && c.slug === a.id);
    else if (a.tipo === 'app') cita = (r.apps || []).includes(a.id);
    else if (a.tipo === 'fase') cita = r.fase === Number(a.id);
    else if (a.tipo === 'tarea') cita = id !== a.id && /^\d+$/.test(a.id) && (r.prs || []).includes(Number(a.id));
    if (cita) out.push({ tipo: 'tarea', ruta: `gestion/tareas/${id}.json` });
  }
  // 2) Texto: ESTADO.md, gestion/ (sin tareas/) y documentos/.
  const propios = new Set();
  if (a.tipo === 'req') propios.add(REQS_REL);
  if (a.tipo === 'riesgo') propios.add(RIESGOS_REL);
  if (a.tipo === 'doc') buscarDocs(root, a.id).forEach((f) => propios.add(f));
  const re = regexCita(a);
  const dirsPropios = a.tipo === 'cambio' ? [`${CAMBIOS_REL}/${a.id}/`, `${CAMBIOS_REL}/archive/${a.id}/`] : [];
  const presupuesto = { n: TOPE_FICHEROS };
  const ficheros = ['ESTADO.md', 'INICIATIVA.md',
    ...ficherosMd(root, 'gestion', { saltar: ['gestion/tareas'], presupuesto }),
    ...ficherosMd(root, 'documentos', { presupuesto })];
  for (const rel of ficheros) {
    if (propios.has(rel) || dirsPropios.some((d) => rel.startsWith(d))) continue;
    const t = leer(root, rel);
    if (t && re.test(t)) out.push({ tipo: tipoDeRuta(rel), ruta: rel });
  }
  return out;
}

// ---------- referencias rotas (validate) ----------

function rotas(root) {
  if (!tareas.hayTareas(root)) return [];
  const registros = todasTareas(root);
  if (!registros.length) return [];
  const reqs = new Set();
  const txt = leer(root, REQS_REL) || '';
  for (const m of txt.matchAll(/^##\s+REQ-(\d+)\b/gm)) reqs.add(Number(m[1]));
  let appsIds = null;
  try { const apps = require('./apps.js'); if (apps.esMonorepo(root)) appsIds = new Set(apps.apps(root).map((x) => x.id)); } catch { /* sin apps.js legible */ }
  const hayCambio = (slug) => esDir(path.join(root, ...CAMBIOS_REL.split('/'), slug)) || esDir(path.join(root, ...CAMBIOS_REL.split('/'), 'archive', slug));
  const out = [];
  for (const { id, r } of registros) {
    const origen = idRef(id);
    for (const q of Array.isArray(r.requisitos) ? r.requisitos : []) {
      const a = refs.analizar(String(q));
      if (a && a.tipo === 'req' && !reqs.has(Number(a.id))) out.push({ origen, ref: a.ref, motivo: 'requisito que no está en requisitos.md' });
    }
    for (const c of Array.isArray(r.cambios) ? r.cambios : []) {
      const a = c && refs.analizar(`cambio:${c.slug}`);   // un slug raro no llega a tocar disco
      if (a && a.tipo === 'cambio' && !hayCambio(a.id)) out.push({ origen, ref: a.ref, motivo: 'cambio sin carpeta' });
    }
    if (appsIds) for (const x of Array.isArray(r.apps) ? r.apps : []) {
      const a = refs.analizar(`app:${x}`);
      if (a && a.tipo === 'app' && !appsIds.has(a.id)) out.push({ origen, ref: a.ref, motivo: 'app no declarada' });
    }
  }
  return out;
}

function avisoRotas(root) {
  const lista = rotas(root);
  if (!lista.length) return null;
  const ej = lista.slice(0, 5).map((x) => `${x.origen}→${x.ref}`).join(', ');
  const mas = lista.length > 5 ? ` (+${lista.length - 5} más)` : '';
  return `${lista.length} referencia(s) rota(s) en las tareas: ${ej}${mas}. Revisa que existan en requisitos.md, en gestion/cambios/changes/ o en las apps declaradas (harness.js ir <ref>).`;
}

const lineaNavegacion = () => 'Navegar: harness.js ir <ref> (#N · REQ-NN · R-NN · cambio:slug · fase:N · app:id · DOC-ID) · refs <ref> = quién la cita.';

module.exports = { resolver, citas, rotas, avisoRotas, lineaNavegacion, buscarDocs, frontmatter };
