// lib/hexagonal-lenguajes.js — los ADAPTADORES por lenguaje de la verificacion hexagonal (#280) viven
// ahora en lib/grafo/extraer.js (extractor unificado del grafo FARO, #298). Este fichero solo lo
// reexporta para que lib/hexagonal.js y lib/hexagonal-fuentes.js sigan cableados sin cambios.
'use strict';
module.exports = require('./grafo/extraer.js');
