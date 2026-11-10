// lib/semanal.js — Informe semanal ejecutivo proactivo (extraido de harness.js).
// Factory con dependencias inyectadas (patron de modulos del motor).
'use strict';
module.exports = function ({ fs, path, ROOT, SP, REPORTING, ESTADO_FILE, parseEstado, validateEstado, openRisksCount, allDocs, docDate, fmtDate, listFiles, isActive, isDone, faseLines }) {


// ¿Toca informe semanal? Solo MIRA, no escribe: el arranque de sesion lo anuncia (#125). Antes lo
// escribia el propio arranque, sin que nadie lo pidiera, y esa modificacion sin commitear contaminaba
// despues los avisos de git y de Stop.
function semanalPendiente() {
  if (!parseEstado()) return false; // sin iniciativa no hay nada que informar (onboarding pendiente)
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return !listFiles(`${REPORTING}/informes`).some((f) => {
    const m = f.name.match(/^(\d{4}-\d{2}-\d{2})-semanal-informe\.md$/);
    return m && new Date(m[1]) > weekAgo;
  });
}

// Genera el informe semanal. Solo bajo peticion explicita: 'harness.js informe-semanal' o /faro:reportar.
function ensureWeeklyReport() {
  if (!semanalPendiente()) return null;
  const now = new Date();
  const today = fmtDate(now);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const ini = parseEstado();
  const { errs } = validateEstado();
  const risks = openRisksCount();
  const recientes = allDocs()
    .filter((f) => docDate(f) > weekAgo && !/-semanal-informe\.md$/.test(f.name))
    .sort((a, b) => docDate(b) - docDate(a))
    .map((f) => `- ${f.rel} (${fmtDate(docDate(f))})`);

  // Estado global (semaforo VISUAL, circulo sin palabra): 🔴 = faseo invalido · 🟡 = riesgos
  // abiertos o semana sin actividad · 🟢 = sin incidencias. La explicacion va en "Lectura".
  const semaforo = errs.length ? '🔴' : (risks > 0 || !recientes.length) ? '🟡' : '🟢';
  const motivo = errs.length
    ? `faseo invalido (${errs.length} error/es)`
    : [risks > 0 ? `${risks} riesgo(s) abiertos` : null, !recientes.length ? 'semana sin actividad documental' : null].filter(Boolean).join(' + ') || 'sin incidencias';

  const fases = (ini && ini.fases) || [];
  const done = fases.reduce((s, f) => s + f.done, 0);
  const total = fases.reduce((s, f) => s + f.done + f.open, 0);
  const avance = total ? `${Math.round((done / total) * 100)}% (${done}/${total} tareas)` : 'n/d';
  const actual = fases.find((f) => isActive(f.estado));
  const cerradas = fases.filter((f) => isDone(f.estado)).length;

  const lines = [
    `# Informe semanal ejecutivo · ${(ini && ini.fm.iniciativa) || 'iniciativa'} — ${today}`,
    '',
    '_Generado por el harness a peticion (harness.js informe-semanal). Editable. Fechas: git log (fallback mtime)._',
    '',
    '## Resumen ejecutivo',
    '',
    `| Estado | Avance global | Fases | Fase en curso | Riesgos abiertos |`,
    `|---|---|---|---|---|`,
    `| ${semaforo} | ${avance} | ${cerradas}/${fases.length} cerradas | ${actual ? `Fase ${actual.num} · ${actual.nombre} (${actual.done}/${actual.done + actual.open})` : '—'} | ${risks} |`,
    '',
    `**Lectura:** ${motivo}.${actual ? ` Foco de la semana: ${actual.open} tarea(s) pendientes de la Fase ${actual.num}.` : ''}`,
    '',
    '## Validacion de estados (faseo)',
    ...(errs.length ? errs.map((e) => `- ⚠ ${e}`) : ['- Estados correctos: numeracion, unica fase activa, tareas e informes de cierre en regla.']),
    '',
    '## Estado por fase',
    ...(faseLines().length ? faseLines() : [`- (sin ${ESTADO_FILE})`]),
    '',
    '## Actividad documental (ultimos 7 dias)',
    ...(recientes.length ? recientes : ['- sin movimientos']),
    '',
    '## Riesgos',
    `- abiertos: ${risks} (${SP}/risks.md)`,
    '',
  ];

  const rel = `${REPORTING}/informes/${today}-semanal-informe.md`;
  try {
    fs.writeFileSync(path.join(ROOT, rel), lines.join('\n'), 'utf8');
    return rel;
  } catch {
    return null;
  }
}


  return { ensureWeeklyReport, semanalPendiente };
};
