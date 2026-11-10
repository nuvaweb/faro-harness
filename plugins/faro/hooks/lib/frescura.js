// lib/frescura.js — FRESCURA DOCUMENTAL (drift): detecta documentos potencialmente DESFASADOS.
// Tecnica estandar de la industria (doc drift/staleness, cf. Fiberplane Drift / Dosu freshness):
// comparar la ULTIMA EDICION de cada documento (git log) contra la de su FUENTE (el funcional) y
// contra la actividad documental posterior del repo. Gradacion en dos niveles para evitar falsos
// positivos binarios: DESFASADO (su fuente cambio despues) / REVISAR (aprobado, viejo y el repo
// siguio moviendose). NUNCA bloquea: es una senal para que el agente confirme vigencia con el usuario.
'use strict';
module.exports = function ({ git, docsControlados, funcionalPath }) {
  // ts (ms) del ultimo commit que toco una ruta; 0 = sin historia (no puntua, no inventamos).
  const commitTs = (rel) => {
    const out = git('log', '-1', '--format=%ct', '--', rel);
    return out ? Number(out) * 1000 : 0;
  };
  const dia = (ts) => new Date(ts).toISOString().slice(0, 10);

  // REVISAR solo a partir de esta edad (dias) y si hubo actividad documental posterior en el repo.
  const EDAD_REVISAR_DIAS = 90;

  function frescuraLines(max = 6) {
    // Solo documentos con ciclo cerrado o en revision: un draft "desfasado" es simplemente un draft.
    const docs = docsControlados().filter((d) => /^(approved|in_review)$/i.test(String(d.status || ''))).slice(0, 20);
    if (!docs.length) return [];
    const fun = funcionalPath();
    const funTs = fun ? commitTs(fun) : 0;
    const ahora = Date.now();
    // Actividad de referencia: el commit documental MAS RECIENTE entre los docs controlados.
    const tsPorDoc = new Map(docs.map((d) => [d.rel, commitTs(d.rel)]));
    const actividadTs = Math.max(funTs, ...tsPorDoc.values());
    const out = [];
    for (const d of docs) {
      if (out.length >= max) break;
      const ts = tsPorDoc.get(d.rel);
      if (!ts) continue;
      if (funTs && fun !== d.rel && funTs > ts) {
        out.push(`- ${d.id} (${d.rel}): DESFASADO — el funcional (${fun}, ${dia(funTs)}) cambio DESPUES de su ultima edicion (${dia(ts)}). Revisalo contra el funcional: o sigue vigente (sube fecha/version tras confirmar) o se marca 'obsolete'.`);
      } else if (ahora - ts > EDAD_REVISAR_DIAS * 864e5 && actividadTs > ts) {
        out.push(`- ${d.id} (${d.rel}): REVISAR — '${d.status}' sin tocar desde ${dia(ts)} mientras la documentacion del repo siguio avanzando. Confirma con el usuario si sigue vigente.`);
      }
    }
    if (!out.length) return [];
    return [
      'FRESCURA DOCUMENTAL (senal de drift, no bloquea) — documentos que pueden estar DESFASADOS:',
      ...out,
      'Al tocar cualquiera: si sigue vigente, registra la revision (version/fecha); si no, actualizalo o marcalo obsolete. No los des por buenos sin mirarlos.',
    ];
  }

  return { frescuraLines, commitTs };
};
