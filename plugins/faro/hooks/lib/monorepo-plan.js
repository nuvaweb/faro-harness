// lib/monorepo-plan.js — gestion/monorepo-plan.json: el plan del monorepo y sus validadores (#161, #162).
//
// La skill /faro:monorepo conversa con el usuario (que es cada carpeta, rol, equipo) y vuelca las
// respuestas aqui; 'harness.js monorepo init|importar' lo lee. El plan es reproducible, retomable y
// queda en el PR como trazabilidad.
//
// Este modulo es la FRONTERA DE SEGURIDAD: ningun id, ruta, rama ni origen llega a git o al disco
// sin pasar por aqui. Patrones estrictos y cerrados (lista blanca), nunca "limpiar" lo que llega.
// Sin dependencias: fs/path nativos.
'use strict';
const fs = require('fs');
const path = require('path');

const PLAN_FILE = 'gestion/monorepo-plan.json';   // relativa al layout antiguo; la real, planFile(root) (#293)
const planFile = (root) => `${require('./paths.js')(root).dir('gestion')}/monorepo-plan.json`;
const PLAN_VERSION = 1;
const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SEGMENTO_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;       // org o repo de GitHub (no empieza por '-' ni '.')
const RAMA_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,99}$/;
const MODOS = ['subtree', 'copia'];
const CLAVES_PLAN = ['version', 'apps', 'tag', 'codeowners', 'decisiones'];
const CLAVES_APP = ['id', 'ruta', 'rol', 'funcional', 'equipo', 'origen', 'clave', 'desplazamiento'];
const CLAVES_ORIGEN = ['fuente', 'rama', 'modo', 'commit'];

const esObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const textoNoVacio = (v) => typeof v === 'string' && v.trim().length > 0;
/** Una sola linea de texto (rol, funcional): sin saltos de linea ni NUL, hasta 200 caracteres. */
const validarLinea = (v) => typeof v === 'string' && /^[^\r\n\u0000]{1,200}$/.test(v) && v.trim().length > 0;
/** Equipo/owner: 'team', '@user' o '@org/team' (un solo valor; una lista se valida uno a uno). */
const validarEquipo = (v) => typeof v === 'string' && /^@?[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)?$/.test(v);

/** ¿Es un id de app valido? (nombre de carpeta bajo apps/ y etiqueta app:<id>). */
function validarId(id) { return typeof id === 'string' && ID_RE.test(id); }

/** Ruta canonica de una app. */
const rutaDeApp = (id) => `apps/${id}`;

/** Rama valida: sin opciones (empieza por alfanumerico), sin '..', sin '.lock', sin caracteres de revision. */
function validarRama(r) {
  if (typeof r !== 'string' || !RAMA_RE.test(r)) return false;
  if (r.includes('..') || r.includes('//') || r.endsWith('/') || r.endsWith('.') || r.endsWith('.lock') || r.includes('/.')) return false;
  return true;
}

/**
 * Valida el ORIGEN de una importacion. Formas aceptadas y NADA mas:
 *   - 'org/repo'                                  -> https://github.com/org/repo.git
 *   - 'https://github.com/org/repo[.git]'         (sin credenciales, sin query, sin fragmento)
 *   - una ruta local que sea un directorio (no empieza por '-')
 * La organizacion DEBE ser la de la sesion (opts.org, sin distinguir mayusculas).
 * -> { ok, tipo:'repo'|'ruta', org, repo, url, ruta, error }
 */
function parseFuente(fuente, { org, permitirRuta = false } = {}) {
  const no = (error) => ({ ok: false, error });
  if (typeof fuente !== 'string' || !fuente || /[\0\r\n]/.test(fuente) || fuente.startsWith('-')) return no('origen vacío o con forma no permitida');
  let o = null; let r = null;
  let m = fuente.match(/^([^/\s:@?#]+)\/([^/\s:@?#]+)$/);
  if (!m) m = fuente.match(/^https:\/\/github\.com\/([^/\s:@?#]+)\/([^/\s:@?#]+?)(?:\.git)?\/?$/);
  if (m) {
    o = m[1]; r = m[2].replace(/\.git$/, '');
    if (!SEGMENTO_RE.test(o) || !SEGMENTO_RE.test(r) || r === '..' || o === '..' || r.endsWith('.lock')) return no('organización o repositorio con caracteres no permitidos');
    if (org && o.toLowerCase() !== String(org).toLowerCase()) return no(`el origen es de otra organización (${o}); solo se importa de ${org}`);
    return { ok: true, tipo: 'repo', org: o, repo: r, url: `https://github.com/${o}/${r}.git` };
  }
  if (!permitirRuta) return no('solo se admiten org/repo o https://github.com/org/repo (las rutas locales solo como argumento de la línea de comandos)');
  if (/^(\\\\|\/\/)/.test(fuente)) return no('las rutas de red (UNC) no se admiten');
  if (/^[a-z][a-z0-9+.-]*:/i.test(fuente) && !/^[A-Za-z]:[\\/]/.test(fuente)) return no('solo se admiten org/repo, https://github.com/org/repo o una ruta local');
  if (fuente.includes('@') && !fs.existsSync(fuente)) return no('solo se admiten org/repo, https://github.com/org/repo o una ruta local');
  try {
    if (fs.statSync(fuente).isDirectory()) return { ok: true, tipo: 'ruta', ruta: path.resolve(fuente), repo: path.basename(path.resolve(fuente)) };
  } catch { /* cae al error */ }
  return no('el origen no es org/repo, una URL de GitHub ni un directorio existente');
}

/** Errores del plan (lista vacia = valido). */
function validarPlan(plan, { org } = {}) {
  const err = [];
  if (!esObjeto(plan)) return ['el plan debe ser un objeto JSON'];
  for (const k of Object.keys(plan)) if (!CLAVES_PLAN.includes(k)) err.push(`monorepo-plan: clave '${k}' desconocida (válidas: ${CLAVES_PLAN.join(', ')}).`);
  if (plan.version !== PLAN_VERSION) err.push(`monorepo-plan: version debe ser ${PLAN_VERSION}.`);
  if (!Array.isArray(plan.apps)) err.push('monorepo-plan: apps debe ser una lista de apps.');
  else if (!plan.apps.length) err.push('monorepo-plan: hace falta al menos una app.');
  else {
    const vistos = new Set();
    plan.apps.forEach((a, i) => {
      const donde = `monorepo-plan: apps[${i}]`;
      if (!esObjeto(a)) { err.push(`${donde} debe ser un objeto.`); return; }
      for (const k of Object.keys(a)) if (!CLAVES_APP.includes(k)) err.push(`${donde}: clave '${k}' desconocida (válidas: ${CLAVES_APP.join(', ')}).`);
      if (!validarId(a.id)) err.push(`${donde}: id inválido (minúsculas, dígitos y guiones; hasta 40 caracteres).`);
      else if (vistos.has(a.id)) err.push(`${donde}: id '${a.id}' repetido.`);
      else vistos.add(a.id);
      if (!validarLinea(a.rol)) err.push(`${donde}: falta 'rol' o no es una sola línea de hasta 200 caracteres (una frase de qué es la app).`);
      if (a.ruta !== undefined && a.ruta !== rutaDeApp(a.id)) err.push(`${donde}: ruta debe ser '${rutaDeApp(a.id)}' (o no ponerla).`);
      if (a.funcional !== undefined && !validarLinea(a.funcional)) err.push(`${donde}: funcional debe ser una sola línea de texto.`);
      if (a.equipo !== undefined && !validarEquipo(a.equipo)) err.push(`${donde}: equipo inválido (team, @usuario o @org/team; sin espacios ni saltos de línea).`);
      if (a.clave !== undefined && !(typeof a.clave === 'string' && /^[A-Za-z0-9]{1,12}$/.test(a.clave))) err.push(`${donde}: clave debe ser alfanumérica de hasta 12 caracteres.`);
      if (a.desplazamiento !== undefined && !(Number.isInteger(a.desplazamiento) && a.desplazamiento >= 0 && a.desplazamiento <= 100000)) err.push(`${donde}: desplazamiento debe ser un entero >= 0.`);
      if (a.origen !== undefined) {
        const o = a.origen;
        if (!esObjeto(o)) { err.push(`${donde}: origen debe ser un objeto { fuente, rama, modo }.`); return; }
        for (const k of Object.keys(o)) if (!CLAVES_ORIGEN.includes(k)) err.push(`${donde}.origen: clave '${k}' desconocida (válidas: ${CLAVES_ORIGEN.join(', ')}).`);
        const f = parseFuente(o.fuente, { org });
        if (!f.ok) err.push(`${donde}.origen.fuente: ${f.error}.`);
        if (o.rama !== undefined && !validarRama(o.rama)) err.push(`${donde}.origen.rama inválida.`);
        if (o.modo !== undefined && !MODOS.includes(o.modo)) err.push(`${donde}.origen.modo debe ser ${MODOS.join(' o ')}.`);
        if (o.commit !== undefined && !(typeof o.commit === 'string' && /^[0-9a-f]{7,40}$/.test(o.commit))) err.push(`${donde}.origen.commit debe ser un hash hexadecimal.`);
      }
    });
  }
  if (plan.tag !== undefined && !(typeof plan.tag === 'string' && plan.tag.includes('{app}') && plan.tag.includes('{version}'))) err.push("monorepo-plan: tag debe incluir {app} y {version} (por defecto '{app}@{version}').");
  if (plan.codeowners !== undefined && typeof plan.codeowners !== 'boolean') err.push('monorepo-plan: codeowners debe ser true o false.');
  if (plan.decisiones !== undefined) {
    if (!Array.isArray(plan.decisiones)) err.push('monorepo-plan: decisiones debe ser una lista.');
    else plan.decisiones.forEach((d, i) => {
      if (!esObjeto(d) || !textoNoVacio(d.id) || !textoNoVacio(d.respuesta) || Object.keys(d).some((k) => !['id', 'respuesta'].includes(k))) err.push(`monorepo-plan: decisión [${i}] inválida (necesita id y respuesta).`);
    });
  }
  return err;
}

/** Lee el plan del repo. -> null si no existe; {plan, errores}. Un JSON roto NO lanza: devuelve errores. */
function leerPlan(root, { org } = {}) {
  const PLAN_FILE = planFile(root);
  const abs = path.join(root, PLAN_FILE);
  let txt;
  try { const st = fs.lstatSync(abs); if (st.isSymbolicLink() || !st.isFile() || st.size > 1048576) return { plan: null, errores: [`${PLAN_FILE}: no es un fichero regular (enlaces simbólicos no permitidos).`] }; txt = fs.readFileSync(abs, 'utf8'); } catch { return null; }
  let plan;
  try { plan = JSON.parse(txt); } catch (e) { return { plan: null, errores: [`${PLAN_FILE}: JSON inválido (${e.message}).`] }; }
  const errores = validarPlan(plan, { org });
  return { plan, errores };
}

/** Escribe el plan (atomico: temporal + rename). */
function escribirPlan(root, plan) {
  const abs = path.join(root, planFile(root));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(plan, null, 2) + '\n');
  fs.renameSync(tmp, abs);
  return abs;
}

/** Respuesta ya dada a una decision (reanudar sin repreguntar), o null. */
function respuesta(plan, id) {
  const d = plan && Array.isArray(plan.decisiones) ? plan.decisiones.find((x) => x && x.id === id) : null;
  return d ? d.respuesta : null;
}

module.exports = { validarLinea, validarEquipo, PLAN_FILE, planFile, PLAN_VERSION, ID_RE, MODOS, validarId, rutaDeApp, validarRama, parseFuente, validarPlan, leerPlan, escribirPlan, respuesta };
