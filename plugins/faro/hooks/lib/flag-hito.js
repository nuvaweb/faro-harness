// lib/flag-hito.js — el flag con el que se ANCLA un issue a su hito (#217): --hito <N|X.Y|backlog|titulo>.
// Un hito no siempre es una fase (version del motor, Backlog, un sprint...), por eso no se llama --fase.
// --fase se acepta como ALIAS con aviso: docs y agentes viejos no se rompen. --origen-fase es otra
// cosa (documenta de que fase viene un hallazgo) y no se toca aqui.
'use strict';

const AVISO_ALIAS = 'ⓘ --fase ahora se llama --hito (un hito no siempre es una fase): lo acepto igual, pero usa --hito.';

// Saca --hito/--fase (con espacio o con '=') de los argumentos. Devuelve {valor, alias, resto}.
function extraer(raw) {
  let valor = null, alias = false;
  const resto = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--hito' || a === '--fase') { valor = raw[i + 1] || ''; alias = a === '--fase'; i++; continue; }
    const m = /^--(hito|fase)=(.*)$/.exec(a);
    if (m) { valor = m[2]; alias = m[1] === 'fase'; continue; }
    resto.push(a);
  }
  return { valor, alias, resto };
}

module.exports = { extraer, AVISO_ALIAS };
