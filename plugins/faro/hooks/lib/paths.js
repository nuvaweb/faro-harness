// paths.js — MAPA UNICO de areas logicas -> carpeta fisica del repo. Fuente de verdad de la taxonomia:
// renombrar una carpeta = cambiar aqui su valor (+ git mv + fallback legado), SIN cazar literales por el harness.
// TAXONOMIA VIGENTE: documentos/ fuentes/ gestion/{cambios,...} flujos/ borrador/.
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = function (ROOT) {
  // Base UNICA del flujo spec-driven: gestion/cambios/ (specs vivas + changes).
  const specBase = 'gestion/cambios';

  // area logica -> carpeta fisica actual.
  const AREAS = {
    documentos: 'documentos',  // documentacion controlada (doc_id)
    fuentes: 'fuentes',        // material de partida (source material / insumos)
    gestion: 'gestion',        // direccion del trabajo (decisiones, riesgos, kpis, reporting)
    cambios: specBase,         // flujo spec-driven (specs + changes)
    flujos: 'flujos',          // exports tecnicos ejecutables (n8n)
    borrador: 'borrador',      // scratch desechable
    notebooks: 'notebooks',    // capa tecnica: notebooks Jupyter (estandar Cookiecutter Data Science)
    scripts: 'scripts',        // utilidades del repo (no es la capa de codigo del producto: eso es src/)
    // SUBRUTAS de reporting (dentro de gestion/). Fuente UNICA: evita literales 'gestion/...' sueltos
    // en el harness (bug historico: onepager/estadisticas escribian en gestion/ en vez de gestion/reporting/).
    reporting: 'gestion/reporting',                  // informes de fase + presentaciones a direccion
    informes: 'gestion/reporting/informes',          // informes por-tema y por-fase
    presentaciones: 'gestion/reporting/presentaciones',  // presentaciones (viva + snapshots por-tema)
  };

  const dir = (area) => (Object.prototype.hasOwnProperty.call(AREAS, area) ? AREAS[area] : area);
  return { AREAS, dir, specBase };
};
