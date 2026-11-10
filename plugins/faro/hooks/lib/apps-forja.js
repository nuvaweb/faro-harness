// lib/apps-forja.js — el MONOREPO en la FORJA (#134): etiqueta app:<id>, CODEOWNERS y labeler por app.
//
// lib/apps.js sabe QUE apps hay; este modulo lo lleva a donde la forja lo usa:
//   - la etiqueta 'app:<id>' de un issue (asignar-tarea --app) y de un PR (labeler por ficheros
//     tocados). Es la que decide que gates y revisores se lanzan para esa app;
//   - .github/CODEOWNERS por app, a partir de 'equipo' en .faro.json (equipo = team de la org);
//   - .github/labeler.yml (actions/labeler v7): 'app:<id>' si el PR toca apps/<id>/**.
//
// Los dos ficheros se generan en un BLOQUE MARCADO: lo de fuera del bloque es del equipo y no se
// toca nunca. Regenerar con las mismas apps no cambia nada (idempotente).
//
// Sin red salvo asegurarEtiqueta*, que recibe el cliente de la API ya resuelto.
'use strict';
const fs = require('fs');
const path = require('path');
const ap = require('./apps.js');

// Color FIJO de las etiquetas de app: se distinguen de las de tipo de un vistazo.
const COLOR_APP = '5319E7';
const etiquetaApp = (id) => `app:${id}`;
const RUTA_CODEOWNERS = '.github/CODEOWNERS';
const RUTA_LABELER = '.github/labeler.yml';
const INICIO = '# >>> FARO apps — generado por harness.js codeowners. No edites DENTRO del bloque: se regenera.';
const FIN = '# <<< FARO apps';

/** Apps desplegables (no paquetes compartidos) que existen en el disco. */
const appsDeTrabajo = (lista) => (lista || []).filter((a) => a.tipo === 'app' && a.ruta && a.existe !== false);

/**
 * Valida el --app de asignar-tarea. -> {app} si existe, {error} con el motivo y las validas si no.
 */
function validarApp(root, id, { schema } = {}) {
  const lista = ap.apps(root, { schema });
  if (!ap.esMonorepo(root) && !lista.length) return { error: `--app solo aplica en un monorepo: este repo no declara "monorepo" en .faro.json ni tiene workspace.` };
  const a = lista.find((x) => x.id === id);
  if (!a) return { error: `La app '${id}' no existe en este monorepo. Apps validas: ${lista.map((x) => x.id).join(' · ') || '(ninguna)'}.` };
  if (a.existe === false) return { error: `La app '${id}' esta declarada en .faro.json pero NO existe en el workspace. Corrige la declaracion o crea su carpeta.` };
  return { app: a };
}

/**
 * Valida VARIAS apps (#211): --app a,b o --app repetido. Una tarea puede abarcar varias apps.
 * -> {apps} (sin repetidas, en el orden dado) o el {error} de la primera que no vale.
 */
function validarApps(root, ids, { schema } = {}) {
  const lista = [...new Set((ids || []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean))];
  if (!lista.length) return { error: '--app sin app: indica al menos una (--app <id> o --app a,b).' };
  const apps = [];
  for (const id of lista) {
    const v = validarApp(root, id, { schema });
    if (v.error) return v;
    apps.push(v.app);
  }
  return { apps };
}

/**
 * Aviso (no bloquea) cuando un monorepo crea un issue sin --app. Propone la app si lo que llevas
 * cambiado toca solo una. null si no es monorepo.
 */
function avisoSinApp(root, ficheros, { schema } = {}) {
  if (!ap.esMonorepo(root)) return null;
  const lista = appsDeTrabajo(ap.apps(root, { schema }));
  if (!lista.length) return null;
  const { apps: tocadas } = ap.appsAfectadas(root, ficheros || []);
  const una = tocadas.length === 1 ? tocadas[0] : null;
  const prop = una
    ? `Propuesta: --app ${una.id} (lo que llevas cambiado solo toca esa app).`
    : `Apps: ${lista.map((a) => a.id).join(' · ')}.`;
  return `ⓘ Monorepo: este issue no lleva --app. Sin la etiqueta 'app:<id>' no se sabe a que app afecta ni que gates y revisores le tocan. ${prop}`;
}

/** Asegura la etiqueta app:<id> en GitHub (la crea con su color si falta). -> nombre o null. */
async function asegurarEtiquetaGithub(ghApi, org, repo, id, descripcion) {
  const nombre = etiquetaApp(id);
  const ya = await ghApi(`repos/${org}/${repo}/labels/${encodeURIComponent(nombre)}`);
  if (ya.ok) return nombre;
  const cr = await ghApi(`repos/${org}/${repo}/labels`, { method: 'POST', body: { name: nombre, color: COLOR_APP, description: descripcion || `Trabajo de la app ${id}` } });
  // 422 = ya existia (carrera): vale igual.
  if (cr.ok || cr.status === 201 || cr.status === 422) return nombre;
  return null;
}

/** Igual en GitLab (projects/:id/labels; 409 = ya existia). */
async function asegurarEtiquetaGitlab(api, proyecto, id, descripcion) {
  const nombre = etiquetaApp(id);
  const cr = await api(`projects/${encodeURIComponent(proyecto)}/labels`, { method: 'POST', body: { name: nombre, color: `#${COLOR_APP}`, description: descripcion || `Trabajo de la app ${id}` } });
  if (cr.ok || cr.status === 201 || cr.status === 409) return nombre;
  return null;
}

/** Equipo(s) de una app -> owners de CODEOWNERS ('@org/team'; '@x' o 'org/team' se respetan). */
function ownersDe(org, equipo) {
  const lista = Array.isArray(equipo) ? equipo : (equipo ? [equipo] : []);
  return lista.map((e) => String(e).trim()).filter((e) => /^@?[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)?$/.test(e)).map((e) => {
    if (e.startsWith('@')) return e;
    if (e.includes('/')) return `@${e}`;
    return org ? `@${org}/${e}` : null;
  }).filter(Boolean);
}

function bloqueCodeowners(lista, org) {
  const filas = [];
  for (const a of appsDeTrabajo(lista)) {
    const o = ownersDe(org, a.equipo);
    if (o.length) filas.push(`/${a.ruta}/ ${o.join(' ')}`);
  }
  return [INICIO, ...filas, FIN].join('\n');
}

function bloqueLabeler(lista, excluir = new Set()) {
  const filas = [];
  for (const a of appsDeTrabajo(lista)) {
    const n = etiquetaApp(a.id);
    if (excluir.has(n)) continue;
    filas.push(`'${n}':`, '  - changed-files:', `      - any-glob-to-any-file: '${a.ruta}/**'`);
  }
  return [INICIO, ...filas, FIN].join('\n');
}

/** Quita el bloque marcado de un texto (para ver lo manual). */
function sinBloque(txt) {
  const t = String(txt || '');
  const i = t.indexOf(INICIO);
  if (i === -1) return t;
  const j = t.indexOf(FIN, i);
  if (j === -1) return t;
  return t.slice(0, i) + t.slice(j + FIN.length);
}

/**
 * Sustituye el bloque marcado por 'bloque', o lo inserta si no existe ('arriba' en CODEOWNERS: alli
 * gana la ULTIMA regla que casa, asi que lo manual que va debajo sigue mandando). Idempotente.
 */
function fusionarBloque(previo, bloque, { arriba = false } = {}) {
  const t = String(previo || '');
  const i = t.indexOf(INICIO);
  if (i !== -1) {
    const j = t.indexOf(FIN, i);
    if (j !== -1) return t.slice(0, i) + bloque + t.slice(j + FIN.length);
  }
  if (!t.trim()) return `${bloque}\n`;
  return arriba ? `${bloque}\n\n${t}` : `${t.replace(/\s*$/, '')}\n\n${bloque}\n`;
}

/** Claves de nivel raiz de un labeler.yml escritas a mano (fuera del bloque). */
function clavesManuales(txt) {
  const out = new Set();
  for (const l of sinBloque(txt).split(/\r?\n/)) {
    const m = l.match(/^(['"]?)([^'"#\s][^'"]*?)\1:\s*$/);
    if (m) out.add(m[2]);
  }
  return out;
}

/**
 * Calcula los dos ficheros. -> {ficheros: [{ruta, previo, texto, cambia}], avisos}
 * org = dueño del repo en la forja (para '@org/team').
 */
function generar(root, { org, schema } = {}) {
  const lista = ap.apps(root, { schema });
  const trabajo = appsDeTrabajo(lista);
  const avisos = [];
  for (const a of trabajo) if (!ownersDe(org, a.equipo).length) avisos.push(`la app '${a.id}' no declara 'equipo' en .faro.json: queda fuera de CODEOWNERS`);
  const leer = (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; } };
  const coPrev = leer(RUTA_CODEOWNERS);
  const lbPrev = leer(RUTA_LABELER);
  const manual = clavesManuales(lbPrev);
  for (const a of trabajo) if (manual.has(etiquetaApp(a.id))) avisos.push(`'${etiquetaApp(a.id)}' ya esta en ${RUTA_LABELER} fuera del bloque: se respeta la entrada manual`);
  const co = fusionarBloque(coPrev, bloqueCodeowners(lista, org), { arriba: true });
  const lb = fusionarBloque(lbPrev, bloqueLabeler(lista, manual));
  return {
    apps: trabajo,
    avisos,
    ficheros: [
      { ruta: RUTA_CODEOWNERS, previo: coPrev, texto: co, cambia: co !== coPrev },
      { ruta: RUTA_LABELER, previo: lbPrev, texto: lb, cambia: lb !== lbPrev },
    ],
  };
}

// Workflow que aplica el labeler.yml en cada PR (para el CI generado). Version de la accion verificada
// en la fuente (github.com/actions/labeler/releases, 2026-10-11): v7.
// SEGURIDAD: 'pull_request_target' corre con permisos de escritura y secretos del repo base, asi que
// NO hace checkout del PR (ni de nada): actions/labeler lee labeler.yml de la rama base por API y
// etiqueta por la lista de ficheros cambiados. Permisos minimos: leer contenido, escribir PR.
const RUTA_WORKFLOW_LABELER = '.github/workflows/labeler.yml';
const PASO_LABELER = [
  'on: pull_request_target',
  'permissions:',
  '  contents: read',
  '  pull-requests: write',
  'jobs:',
  '  labeler:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/labeler@v7',
].join('\n');
const WORKFLOW_LABELER = [
  '# .github/workflows/labeler.yml generado por FARO (node .claude/hooks/harness.js ci).',
  '# Etiqueta cada PR con app:<id> segun los ficheros que toca (config: .github/labeler.yml).',
  '# SEGURIDAD: pull_request_target tiene permisos de escritura y acceso a secretos, por eso este',
  '# workflow NO hace checkout del codigo del PR: solo etiqueta por ficheros cambiados. No le anadas',
  '# pasos que ejecuten codigo del PR. Si este fichero ya existe, el harness no lo toca.',
  'name: Etiquetas por app (FARO)',
  PASO_LABELER,
  '',
].join('\n');

/** Escribe el workflow del labeler SIN sobrescribir. -> 'creado' | 'existe'. */
function escribirWorkflowLabeler(root) {
  const abs = path.join(root, RUTA_WORKFLOW_LABELER);
  if (fs.existsSync(abs)) return 'existe';
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, WORKFLOW_LABELER);
  return 'creado';
}

/**
 * harness.js codeowners [--comprobar]: genera/actualiza los dos ficheros. Con --comprobar no escribe
 * y sale 1 si estan desactualizados (para CI). -> codigo de salida.
 */
function cmdCodeowners(root, { org, schema, comprobar = false, log = console.log } = {}) {
  if (!ap.esMonorepo(root)) { log('codeowners: este repo no es un monorepo (sin "monorepo" en .faro.json). Nada que generar.'); return 0; }
  const g = generar(root, { org, schema });
  if (!g.apps.length) { log('codeowners: el monorepo no tiene apps en el workspace. Nada que generar.'); return 0; }
  for (const a of g.avisos) log(`⚠ ${a}`);
  const pend = g.ficheros.filter((f) => f.cambia);
  if (comprobar) {
    if (!pend.length) { log(`✅ ${g.ficheros.map((f) => f.ruta).join(' y ')} al dia con las apps (${g.apps.map((a) => a.id).join(', ')}).`); return 0; }
    log(`✗ Desactualizado: ${pend.map((f) => f.ruta).join(', ')}. Regeneralo con: harness.js codeowners`);
    return 1;
  }
  if (!pend.length) { log(`✅ Sin cambios: ${g.ficheros.map((f) => f.ruta).join(' y ')} ya reflejan las apps (${g.apps.map((a) => a.id).join(', ')}).`); return 0; }
  for (const f of pend) {
    const abs = path.join(root, f.ruta);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.texto);
    log(`✅ ${f.previo ? 'Actualizado' : 'Creado'} ${f.ruta} (bloque FARO; lo de fuera no se toca).`);
  }
  log(`   Para que el labeler etiquete los PR hace falta su workflow (actions/labeler@v7):\n${PASO_LABELER.split('\n').map((l) => `     ${l}`).join('\n')}`);
  return 0;
}

module.exports = {
  COLOR_APP, RUTA_CODEOWNERS, RUTA_LABELER, RUTA_WORKFLOW_LABELER, INICIO, FIN, PASO_LABELER, WORKFLOW_LABELER, escribirWorkflowLabeler,
  etiquetaApp, validarApp, validarApps, avisoSinApp, asegurarEtiquetaGithub, asegurarEtiquetaGitlab,
  ownersDe, bloqueCodeowners, bloqueLabeler, fusionarBloque, sinBloque, clavesManuales, generar, cmdCodeowners,
};
