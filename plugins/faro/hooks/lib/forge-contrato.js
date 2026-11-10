// lib/forge-contrato.js — CONTRATO DE FORJA: las operaciones que los flujos pueden pedir sin saber en
// que forja estan. forjaMod() elige el adaptador (github.js o forge-gitlab.js) y ambos deben cumplirlas.
// Lo que una forja no ofrece no se finge aqui: se declara en CAPACIDADES (lib/forge.js).
'use strict';

const OPERACIONES = Object.freeze([
  // Peticiones de integracion
  'crearPr', 'integrarPorPeticion', 'prAbiertoDe', 'prsDeRama', 'pedirRevision', 'cmdPr', 'cmdPrVer', 'cmdPrAprobar', 'cmdPrMergear', 'estadoCi', 'estadoCiCommit',
  // Tareas: lectura y escritura
  'leerIssue', 'leerComentarios', 'adjuntosDeIssue', 'issueEstado', 'comentarIssue', 'cerrarIssue', 'editarCuerpoIssue', 'hechosTareas',
  'cmdAsignarTarea', 'cmdDescartarTarea', 'cmdMisTareas', 'cmdMoverTarea', 'cmdCerrarTarea', 'cmdAmpliarTarea',
  // Etiquetas, hitos y publicacion
  'asegurarEtiquetaApp', 'cmdHito', 'syncHitos', 'publicarRelease',
  // Equipo, cuenta y proyecto
  'cmdAuth', 'cmdRole', 'roleInfo', 'collaborators', 'approvers', 'cmdEquipo', 'cmdMiembro', 'cmdClave', 'cmdProteger',
  // Resumen de sesion
  'ghResumenCache', 'refrescarResumen', 'invalidarResumen',
]);

const faltan = (adaptador) => OPERACIONES.filter((op) => !adaptador || typeof adaptador[op] !== 'function');

module.exports = { OPERACIONES, faltan };
