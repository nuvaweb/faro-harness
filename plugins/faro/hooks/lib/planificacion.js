// lib/planificacion.js — DOMINIO: relacion con un PLANIFICADOR EXTERNO, leida de la forja (#218, #277).
//
// Un planificador (la herramienta que organice el trabajo: proyecto -> epicas -> milestones -> issues)
// deja en la forja lo justo para orientarse. FARO solo lo LEE con el token del harness: no hay API,
// token ni login contra el planificador, y FARO no escribe nunca estos datos.
//
// Las marcas llevan el PREFIJO que declare el repo (faro/config.json > planificacion.prefijo) o el usuario
// (~/.faro.json > planificacion). Sin prefijo declarado no hay planificador: nada se lee ni se pinta.
//
//   Proyecto          GitHub: propiedad del repo '<prefijo>_id' = PRJ-xxxx (vacia si el repo se reparte)
//                     GitLab: topic del proyecto '<prefijo>-PRJ-xxxx'
//   Epica del hito    linea '<prefijo>:epica=EPI-n · <titulo>' en la descripcion del milestone
//                     (titulo opcional; se lee por el id, sin distinguir mayusculas)
//   Fechas            las del milestone: due_on (GitHub), start_date/due_date (GitLab)
//
// ARQUITECTURA (hexagonal): este modulo es dominio PURO. No lee ficheros, red, entorno ni
// configuracion. Recibe la configuracion ya resuelta (crear(cfg)) y la forja como PUERTO
// 'api(ruta)' -> {ok,status,body,sinToken} (el adaptador de GitHub o el de GitLab). Nunca lanza:
// un fallo de lectura sale como 'error' y nada se bloquea.
'use strict';

const RE_PREFIJO = /^[a-z][a-z0-9-]{0,20}$/;
const RE_NOMBRE = /^[\p{L}\p{N} ._-]{1,40}$/u;
const escapar = (s) => s.replace(/[-]/g, '\\-');

// Configuracion valida -> {prefijo, nombre} | null. Pura: valida lo que le pasen, no lo busca.
function normalizarConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  const prefijo = typeof cfg.prefijo === 'string' ? cfg.prefijo.trim().toLowerCase() : '';
  if (!RE_PREFIJO.test(prefijo)) return null;
  const n = typeof cfg.nombre === 'string' ? cfg.nombre.trim() : '';
  const nombre = n && RE_NOMBRE.test(n) ? n : prefijo.charAt(0).toUpperCase() + prefijo.slice(1);
  return { prefijo, nombre };
}

const dia = (v) => (v ? String(v).slice(0, 10) : null);

// Un milestone normalizado, venga de GitHub o de GitLab.
function milestone(m, forge, cuenta) {
  const gl = forge === 'gitlab';
  return {
    titulo: m.title,
    cerrado: m.state === 'closed',
    fecha: dia(gl ? m.due_date : m.due_on),
    inicio: gl ? dia(m.start_date) : null,
    abiertos: cuenta ? cuenta.abiertos : (m.open_issues || 0),
    cerrados: cuenta ? cuenta.cerrados : (m.closed_issues || 0),
    descripcion: m.description || '',
  };
}

const fallo = (motivo) => ({ proyecto: null, sinPropiedad: false, epicas: [], sinEpica: [], avisos: [], error: motivo });
function motivo(r) {
  if (r.sinToken) return 'sin token del harness: harness.js auth';
  if (r.status === 401 || r.status === 403) return `sin permiso para leer (${r.status})`;
  if (r.error) return r.error;
  return `la forja respondió ${r.status}`;
}

// Planificador configurado -> sus operaciones; sin configuracion valida -> null (no hay planificador).
function crear(cfg) {
  const c = normalizarConfig(cfg);
  if (!c) return null;
  const { prefijo, nombre: NOMBRE } = c;
  const P = escapar(prefijo);
  const RE_MARCA = new RegExp(`${P}:epica=([A-Za-z][A-Za-z0-9]*-[1-9]\\d*)\\b[ \\t]*(?:·[ \\t]*([^\\n]*))?`, 'i');
  const RE_LINEA = new RegExp(`^.*${P}:epica=.*$`, 'im');
  const PROPIEDAD = `${prefijo.replace(/-/g, '_')}_id`;
  const RE_TOPIC = new RegExp(`^${P}-(PRJ-[A-Za-z0-9-]+)$`, 'i');

  // La marca de una descripcion: {id, titulo} | null (sin marca o marca que no se entiende).
  function leerMarca(descripcion) {
    const m = descripcion ? RE_MARCA.exec(String(descripcion)) : null;
    return m ? { id: m[1].toUpperCase(), titulo: (m[2] || '').trim() } : null;
  }
  // La linea con '<prefijo>:epica=' que NO lleva un id valido (para avisar de ella), o null.
  function marcaRota(descripcion) {
    if (!descripcion || leerMarca(descripcion)) return null;
    const l = RE_LINEA.exec(String(descripcion));
    return l ? l[0].trim() : null;
  }

  // Compone el arbol a partir de lo leido. Puro.
  function componer({ proyecto = null, sinPropiedad = false, milestones = [] }) {
    const epicas = new Map(); const sinEpica = []; const avisos = [];
    for (const m of milestones) {
      const marca = leerMarca(m.descripcion);
      const { descripcion, ...ms } = m;
      if (!marca) {
        const rota = marcaRota(descripcion);
        if (rota) avisos.push(`Marca que no entiendo en el milestone '${m.titulo}': ${rota} (se espera ${prefijo}:epica=EPI-n · <título>).`);
        sinEpica.push(ms);
        continue;
      }
      if (!epicas.has(marca.id)) epicas.set(marca.id, { id: marca.id, titulo: marca.titulo, milestones: [] });
      const e = epicas.get(marca.id);
      if (!e.titulo && marca.titulo) e.titulo = marca.titulo;
      e.milestones.push(ms);
    }
    const lista = [...epicas.values()].map((e) => ({ ...e, pendientes: e.milestones.filter((x) => !x.cerrado).length }));
    return { proyecto, sinPropiedad, epicas: lista, sinEpica, avisos, error: null };
  }

  async function leerGithub(api, f) {
    const base = `repos/${f.owner}/${f.project}`;
    const p = await api(`${base}/properties/values`);
    let proyecto = null, sinPropiedad = false;
    if (p.ok) {
      const v = (Array.isArray(p.body) ? p.body : []).find((x) => x && x.property_name === PROPIEDAD);
      if (!v) sinPropiedad = true; else proyecto = (v.value && String(v.value).trim()) || null;
    } else if (p.status === 404 || p.status === 422) sinPropiedad = true;
    else return fallo(motivo(p));
    const m = await api(`${base}/milestones?state=all&per_page=100`);
    if (!m.ok) return fallo(motivo(m));
    return componer({ proyecto, sinPropiedad, milestones: (m.body || []).map((x) => milestone(x, 'github')) });
  }

  async function leerGitlab(api, f) {
    const pid = encodeURIComponent(f.path);
    const p = await api(`projects/${pid}`);
    if (!p.ok) return fallo(motivo(p));
    const topic = ((p.body && (p.body.topics || p.body.tag_list)) || []).map((t) => RE_TOPIC.exec(t)).find(Boolean);
    const m = await api(`projects/${pid}/milestones?per_page=100`);
    if (!m.ok) return fallo(motivo(m));
    // GitLab no da el avance en el milestone: una lectura de estadisticas por milestone.
    const lista = await Promise.all((m.body || []).map(async (x) => {
      const s = await api(`projects/${pid}/issues_statistics?milestone=${encodeURIComponent(x.title)}`);
      const k = s.ok && s.body && s.body.statistics && s.body.statistics.counts;
      return milestone(x, 'gitlab', { abiertos: (k && k.opened) || 0, cerrados: (k && k.closed) || 0 });
    }));
    return componer({ proyecto: topic ? topic[1].toUpperCase() : null, milestones: lista });
  }

  // Lee la relacion de ESTE repo (una sola lectura; en un monorepo las apps comparten el proyecto).
  async function leerRelacion(api, forja) {
    try {
      if (!forja || !forja.owner || !forja.project) return fallo('el remoto no es de una forja conocida');
      if (forja.forge === 'gitlab') return await leerGitlab(api, forja);
      if (forja.forge === 'github') return await leerGithub(api, forja);
      return fallo(`forja ${forja.forge} sin lector`);
    } catch (e) { return fallo((e && e.message) || String(e)); }
  }

  const NO_ESTA = `Este repo no está en ${NOMBRE} (no se ha creado o asociado el proyecto).`;
  const SIN_PROP = `la organización no tiene la propiedad ${PROPIEDAD}`;
  const nombreEpica = (e) => (e.titulo ? `${e.id} · ${e.titulo}` : e.id);
  function lineaMs(m) {
    const total = m.abiertos + m.cerrados;
    const fecha = m.inicio && m.fecha ? `${m.inicio} → ${m.fecha}` : (m.fecha || 'sin fecha');
    return `${m.titulo} · ${m.cerrado ? 'cerrado' : fecha} · ${m.cerrados}/${total}`;
  }

  // El arbol completo, linea a linea (harness.js planificacion).
  function pintar(rel) {
    if (!rel) return [];
    if (rel.error) return [`No se pudo leer la relación con ${NOMBRE} (${rel.error}).`];
    const out = [];
    if (!rel.epicas.length) {
      if (rel.proyecto) out.push(`Proyecto ${rel.proyecto}, milestones sin épica: asígnalos en ${NOMBRE}.`);
      else out.push(rel.sinPropiedad ? `${NO_ESTA.slice(0, -1)}: ${SIN_PROP}.` : NO_ESTA);
    } else {
      out.push(rel.proyecto ? `${NOMBRE} · proyecto ${rel.proyecto}` : `${NOMBRE} · el proyecto no está fijado en el repo${rel.sinPropiedad ? ` (${SIN_PROP})` : ''}: las épicas salen de las marcas de los milestones.`);
      for (const e of rel.epicas) {
        out.push(`  ${nombreEpica(e)} — ${e.pendientes} milestone(s) pendiente(s)`);
        for (const m of e.milestones) out.push(`    - ${lineaMs(m)}`);
      }
    }
    if (rel.sinEpica.length && (rel.epicas.length || rel.proyecto)) out.push(`  Sin épica: ${rel.sinEpica.map((m) => (m.fecha || m.cerrado ? m.titulo : `${m.titulo} (sin fecha)`)).join(', ')}`);
    for (const a of rel.avisos) out.push(`  ⚠ ${a}`);
    return out;
  }

  // Una linea para el arranque de sesion.
  function resumenCorto(rel) {
    if (!rel) return '';
    if (rel.error) return `No se pudo leer la relación con ${NOMBRE} (${rel.error}).`;
    if (!rel.epicas.length && !rel.proyecto) return rel.sinPropiedad ? `${NO_ESTA.slice(0, -1)}: ${SIN_PROP}.` : NO_ESTA;
    const ep = rel.epicas.map((e) => {
      const prox = e.milestones.filter((m) => !m.cerrado).map((m) => `${m.titulo}${m.fecha ? ` vence ${m.fecha}` : ' sin fecha'}`);
      return `${nombreEpica(e)}${prox.length ? ` (${prox.join(', ')})` : ' (cerrada)'}`;
    });
    const partes = [rel.proyecto ? `proyecto ${rel.proyecto}` : 'proyecto sin fijar en el repo'];
    partes.push(ep.length ? `${ep.length} épica(s): ${ep.join(' · ')}` : `milestones sin épica: asígnalos en ${NOMBRE}`);
    if (rel.sinEpica.length && ep.length) partes.push(`${rel.sinEpica.length} milestone(s) sin épica`);
    if (rel.avisos.length) partes.push(`${rel.avisos.length} marca(s) que no entiendo (harness.js planificacion)`);
    return `${NOMBRE}: ${partes.join(' · ')}.`;
  }

  // La epica de un milestone que la forja ya trae dentro del issue (con su descripcion): 'EPI-n · titulo' | ''.
  function textoEpica(ms) {
    const e = leerMarca(ms && ms.description);
    return e ? nombreEpica(e) : '';
  }
  // La linea para un log de cierre: 'Épica de <Nombre>: EPI-n · titulo.' | ''.
  function lineaEpica(ms) {
    const t = textoEpica(ms);
    return t ? `Épica de ${NOMBRE}: ${t}.` : '';
  }

  // La epica de un milestone por su titulo: {id, titulo} | null.
  function epicaDe(rel, tituloMilestone) {
    if (!rel || !rel.epicas || !tituloMilestone) return null;
    const e = rel.epicas.find((x) => x.milestones.some((m) => m.titulo === tituloMilestone));
    return e ? { id: e.id, titulo: e.titulo } : null;
  }

  return { nombre: NOMBRE, prefijo, PROPIEDAD, leerMarca, componer, leerRelacion, pintar, resumenCorto, epicaDe, textoEpica, lineaEpica };
}

module.exports = { crear, normalizarConfig };
