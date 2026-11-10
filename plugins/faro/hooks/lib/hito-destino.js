// lib/hito-destino.js — Resuelve el hito de una tarea con las mismas reglas en las dos forjas: el numero
// de una fase de ESTADO.md, 'backlog' o el titulo literal de un hito que ya existe. Cada adaptador aporta
// su acceso a los hitos y que identificador usa para escribir uno (idDe).
'use strict';
const { NOMBRE_BACKLOG } = require('./tarea.js');

// --hito que no es fase (#217): el TITULO literal de un hito que ya existe (sprint, version...).
// Solo por titulo: '--hito 2' es la Fase 2, nunca el milestone numero 2 de la forja.
const hitoPorTitulo = (lista, ref) => (lista || []).find((m) => String(m.title).toLowerCase() === String(ref).toLowerCase()) || null;
const noExiste = (v, fs) => `${/^\d+$/.test(String(v)) ? `Fase ${v}` : `El hito '${v}'`} no existe: ni es una fase de ESTADO.md ni un hito de la forja. Fases disponibles:\n${fs.map((x) => `  · Fase ${x.num} · ${x.nombre}`).join('\n') || '  (ninguna)'}\n  · backlog (si aun no se decide cuando)\n  · o el titulo de un hito que ya exista`;

// Devuelve hitoDestino(ref) -> {numero, titulo}, o null con el motivo ya impreso.
function crear({ hitos, buscarHito, crearHito, fases, tituloFase, idDe }) {
  return async function hitoDestino(faseArg) {
    if (!hitos || !buscarHito) return null;
    const lista = await hitos('all');
    if (String(faseArg).toLowerCase() === 'backlog') {
      const m = buscarHito(lista, NOMBRE_BACKLOG);
      if (m) return { numero: idDe(m), titulo: m.title };
      if (!crearHito) { console.log(`No existe el hito '${NOMBRE_BACKLOG}' y no puedo crearlo.`); return null; }
      const cr = await crearHito(NOMBRE_BACKLOG, { description: 'Trabajo aceptado sin fase asignada todavia.' });
      if (cr.error) { console.log(`No pude crear el hito ${NOMBRE_BACKLOG} (HTTP ${cr.error.status}).`); return null; }
      return { numero: idDe(cr.hito), titulo: NOMBRE_BACKLOG };
    }
    const listaFases = (fases ? fases() : []) || [];
    const f = listaFases.find((x) => x.num === Number(faseArg));
    if (!f) {
      const literal = hitoPorTitulo(lista, faseArg);
      if (literal) return { numero: idDe(literal), titulo: literal.title };
      console.log(noExiste(faseArg, listaFases));
      return null;
    }
    const titulo = tituloFase ? tituloFase(f) : `Fase ${f.num} — ${f.nombre}`;
    let m = buscarHito(lista, titulo);
    if (!m) {
      if (!crearHito) { console.log(`La Fase ${f.num} no tiene hito y no puedo crearlo.`); return null; }
      const cr = await crearHito(titulo);
      if (cr.error) { console.log(`No pude crear el hito de la Fase ${f.num} (HTTP ${cr.error.status}).`); return null; }
      m = cr.hito;
    }
    return { numero: idDe(m), titulo };
  };
}

// SALIR DEL BACKLOG O DE LA BANDEJA = entrar al trabajo (#72, #84): la tarea llega con la estructura de
// su tipo, y un 'reporte' se tria antes. Devuelve las lineas del rechazo, o null si puede pasar.
function bloqueoAlEntrarEnFase({ num, tipo, cuerpo, tieneHito, destino, comoCompletar }) {
  if (tipo === 'reporte') return [`La tarea #${num} es un REPORTE: todavia nadie ha decidido si es trabajo. Triala antes (/faro:triaje) y dale su tipo real; despues, muevela.`];
  const huecos = require('./ciclo.js').huecosDeIssue(cuerpo || '', tipo || undefined);
  if (!huecos.length) return null;
  return [
    `No muevo la tarea #${num} a '${destino}': al salir de ${tieneHito ? 'el Backlog' : 'la bandeja de entrada'} necesita el formato de su tipo${tipo ? ` (${tipo})` : ''}.`,
    `   Le falta: ${huecos.join(' · ')}.`,
    `   ${comoCompletar}`,
  ];
}

module.exports = { crear, hitoPorTitulo, noExiste, bloqueoAlEntrarEnFase };
