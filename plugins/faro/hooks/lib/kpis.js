// lib/kpis.js — KPIs de negocio (gestion/kpis.md) (extraido de harness.js).
// Factory con CTX compartido: harness.js es el despachador; cada dominio vive en lib/<dominio>.js.
'use strict';
module.exports = function (ctx) {
  const { fs, path, ROOT, SP, NO_INSTANCIA, parseEstado } = ctx;


// Formato validado: secciones '## KPI-NN · <nombre>' con campos '- definicion/linea_base/objetivo/fuente:'
// y mediciones como sub-lista bajo '- mediciones:' ('  - AAAA-MM-DD: <valor> — evidencia: <ruta>').
const KPIS_FILE = `${SP}/kpis.md`;
const KPI_FIELDS = ['definicion', 'linea_base', 'objetivo', 'fuente'];
const KPI_STALE_DAYS = 30;

function parseKpis() {
  let text;
  try { text = fs.readFileSync(path.join(ROOT, KPIS_FILE), 'utf8'); } catch { return null; }
  const kpis = [];
  const re = /^##\s+(KPI-\d+)\s*[·:]\s*(.+)$/gm;
  let m;
  while ((m = re.exec(text))) kpis.push({ id: m[1], nombre: m[2].trim(), start: m.index });
  kpis.forEach((k, i) => {
    const seg = text.slice(k.start, i + 1 < kpis.length ? kpis[i + 1].start : text.length);
    k.campos = {};
    for (const f of KPI_FIELDS) {
      const mm = seg.match(new RegExp(`^[-*]\\s*${f}\\s*:\\s*(.+)$`, 'mi'));
      if (mm) k.campos[f] = mm[1].trim();
    }
    k.mediciones = [];
    const mre = /^[ \t]+[-*]\s*(\d{4}-\d{2}-\d{2})\s*:\s*(.+)$/gm;
    let t;
    while ((t = mre.exec(seg))) k.mediciones.push({ fecha: t[1], valor: t[2].trim() });
    k.mediciones.sort((a, b) => a.fecha.localeCompare(b.fecha));
  });
  return kpis;
}

// Errores de FORMATO de KPIs (bloquean en validate); la frescura de mediciones es aviso, no error.
function kpiIssues() {
  const kpis = parseKpis();
  if (kpis === null || !kpis.length) return []; // sin archivo o sin KPIs definidos: valido (son opcionales)
  const errs = [];
  for (const k of kpis) {
    for (const f of KPI_FIELDS) if (!k.campos[f]) errs.push(`${k.id} (${k.nombre}): falta '${f}:'`);
  }
  return errs;
}

// Estado de KPIs para el resumen de sesion: definidos, sin medicion o desactualizados.
function kpiLines() {
  if (NO_INSTANCIA || !parseEstado()) return [];
  const kpis = parseKpis();
  if (kpis === null || !kpis.length) {
    return [`KPIs de negocio: sin definir (${KPIS_FILE}) — define cada KPI con definicion, linea base, objetivo y fuente; el agente analista-kpis los valida contra la evidencia y los informes/presentacion DEBEN incorporarlos.`];
  }
  const now = Date.now();
  const lines = [`KPIs de negocio (${KPIS_FILE}): ${kpis.length} definido(s). Los informes de fase y la presentacion DEBEN incorporarlos; validacion de evidencia: agente analista-kpis.`];
  for (const k of kpis) {
    const last = k.mediciones.length ? k.mediciones[k.mediciones.length - 1] : null;
    const staleDays = last ? Math.round((now - new Date(last.fecha)) / 86400000) : null;
    const estado = !last
      ? 'SIN MEDICION — mide y anota la primera medicion con evidencia'
      : staleDays > KPI_STALE_DAYS
        ? `medicion DESACTUALIZADA (hace ${staleDays}d: ${last.valor}) — sugiere remedir o lanzar el agente analista-kpis`
        : `ultima medicion ${last.fecha}: ${last.valor}`;
    lines.push(`- ${k.id} · ${k.nombre} · objetivo: ${k.campos.objetivo || '?'} · ${estado}`);
  }
  return lines;
}


  return { parseKpis, kpiIssues, kpiLines };
};
