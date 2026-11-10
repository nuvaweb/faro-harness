// paths.js — MAPA UNICO de areas logicas -> carpeta fisica del repo. Fuente de verdad de la taxonomia:
// renombrar una carpeta = cambiar aqui su valor (+ git mv + fallback legado), SIN cazar literales por el harness.
//
// LAYOUT (#293): todo lo de FARO cuelga de faro/ en la raiz —faro/{gestion,fuentes,documentos,flujos,
// borrador,notebooks}/, faro/ESTADO.md y faro/config.json (el antiguo .faro.json)—. Un repo adoptado
// antes conserva el layout antiguo en la raiz hasta que lo migra (`harness.js migrar-layout`): el
// motor lo detecta aqui y resuelve TODAS las rutas segun el layout (lectura dual). Un repo sin nada
// de FARO nace con el nuevo. scripts/ es del producto y se queda en la raiz.
'use strict';
const fs = require('fs');
const path = require('path');

const BASE = 'faro';

// Lo que se mueve al migrar: [ruta antigua en la raiz, ruta nueva]. Orden = orden del plan.
const MIGRACION = [
  ['gestion', `${BASE}/gestion`],
  ['fuentes', `${BASE}/fuentes`],
  ['documentos', `${BASE}/documentos`],
  ['flujos', `${BASE}/flujos`],
  ['borrador', `${BASE}/borrador`],
  ['notebooks', `${BASE}/notebooks`],
  ['ESTADO.md', `${BASE}/ESTADO.md`],
  ['INICIATIVA.md', `${BASE}/ESTADO.md`],
  ['.faro.json', `${BASE}/config.json`],
];

const existe = (root, rel) => { try { return fs.existsSync(path.join(root, rel)); } catch { return false; } };

/** 'faro' si el repo ya tiene faro/ con algo de FARO, 'legado' si conserva el layout antiguo; un repo sin nada nace 'faro'. */
function detectarLayout(root) {
  if (['ESTADO.md', 'config.json', 'gestion'].some((f) => existe(root, `${BASE}/${f}`))) return 'faro';
  if (['ESTADO.md', 'INICIATIVA.md', '.faro.json', 'gestion'].some((f) => existe(root, f))) return 'legado';
  return 'faro';
}

function paths(ROOT) {
  const root = ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const layout = detectarLayout(root);
  const legado = layout === 'legado';
  const en = (rel) => (legado ? rel : `${BASE}/${rel}`);

  // Base UNICA del flujo spec-driven: <gestion>/cambios/ (specs vivas + changes).
  const specBase = en('gestion/cambios');

  // area logica -> carpeta fisica segun el layout.
  const AREAS = {
    documentos: en('documentos'),  // documentacion controlada (doc_id)
    fuentes: en('fuentes'),        // material de partida (source material / insumos)
    gestion: en('gestion'),        // direccion del trabajo (decisiones, riesgos, kpis, reporting)
    cambios: specBase,             // flujo spec-driven (specs + changes)
    flujos: en('flujos'),          // exports tecnicos ejecutables (n8n)
    borrador: en('borrador'),      // scratch desechable
    notebooks: en('notebooks'),    // capa tecnica: notebooks Jupyter (estandar Cookiecutter Data Science)
    scripts: 'scripts',            // utilidades del repo: del producto, siempre en la raiz
    // SUBRUTAS de reporting (dentro de gestion/). Fuente UNICA: evita literales 'gestion/...' sueltos.
    reporting: en('gestion/reporting'),
    informes: en('gestion/reporting/informes'),
    presentaciones: en('gestion/reporting/presentaciones'),
  };

  // ESTADO del trabajo. En el layout antiguo, el legado INICIATIVA.md manda si es el unico que existe.
  const ESTADO = legado
    ? (existe(root, 'INICIATIVA.md') && !existe(root, 'ESTADO.md') ? 'INICIATIVA.md' : 'ESTADO.md')
    : `${BASE}/ESTADO.md`;
  // Configuracion del repo (NO confundir con ~/.faro.json, el almacen de credenciales del usuario).
  // Migracion a medias (faro/ ya existe pero la config sigue en .faro.json): se sigue leyendo .faro.json, nunca
  // se ignora en silencio. Misma regla que lib/tdd.js y cli/bin/lib/layout.mjs.
  const CONFIG = legado || (!existe(root, `${BASE}/config.json`) && existe(root, '.faro.json')) ? '.faro.json' : `${BASE}/config.json`;

  const dir = (area) => (Object.prototype.hasOwnProperty.call(AREAS, area) ? AREAS[area] : area);
  const abs = (rel) => path.join(root, rel);
  // Ruta LOGICA (la del layout antiguo, como la escriben faro-schema.json y los textos: 'gestion/decisions/',
  // 'documentos/plantillas/x.md', 'ESTADO.md', '.faro.json') -> ruta FISICA segun el layout de este repo.
  // Lo que no es de FARO (src/, scripts/, apps/...) se devuelve tal cual.
  const ruta = (rel) => {
    const r = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (legado) return r;
    if (r === 'ESTADO.md' || r === 'INICIATIVA.md') return ESTADO;
    if (r === '.faro.json') return CONFIG;
    const seg = r.split('/')[0];
    return MIGRACION.some(([de]) => de === seg) ? `${BASE}/${r}` : r;
  };
  return { AREAS, dir, abs, ruta, specBase, ESTADO, CONFIG, layout, legado, BASE, root };
}

module.exports = paths;
module.exports.BASE = BASE;
module.exports.MIGRACION = MIGRACION;
module.exports.detectarLayout = detectarLayout;
