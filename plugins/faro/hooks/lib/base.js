// lib/base.js — utilidades compartidas (emision de hooks, stdin, ficheros, riesgos) (extraido de harness.js).
// Factory con CTX compartido: harness.js es el despachador; cada dominio vive en lib/<dominio>.js.
'use strict';
module.exports = function (ctx) {
  const { fs, path, ROOT, SP, SPEC_BASE, REPORTING, DOCS, FLOWS, SRC } = ctx;


// emit: contexto para el modelo; si se pasa `alert`, ademas se muestra al USUARIO (systemMessage).
function emit(ctx, event, alert) {
  const out = {
    hookSpecificOutput: { hookEventName: event, additionalContext: ctx },
    suppressOutput: true,
  };
  if (alert) out.systemMessage = alert;
  process.stdout.write(JSON.stringify(out) + '\n');
}

// decide: emite una decision de permiso en PreToolUse (deny | ask | allow) con motivo.
// Protege las ramas principales del ciclo de vida: 'deny' veta (commit/escritura directa en main),
// 'ask' fuerza confirmacion humana (merge/push hacia la principal = la aprobacion, la aplica el usuario).
function decide(decision, reason, event, alert) {
  const out = {
    hookSpecificOutput: { hookEventName: event, permissionDecision: decision, permissionDecisionReason: reason },
  };
  if (alert) out.systemMessage = alert;
  process.stdout.write(JSON.stringify(out) + '\n');
}
const deny = (reason, event, alert) => decide('deny', reason, event, alert);
const ask = (reason, event, alert) => decide('ask', reason, event, alert);

function readStdin(cb) {
  let input = '';
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    let payload;
    try { payload = JSON.parse(input); } catch { return; }
    cb(payload);
  });
}

function listFiles(dir) {
  try {
    return fs.readdirSync(path.join(ROOT, dir))
      .filter((name) => !name.startsWith('.'))
      .map((name) => {
        const full = path.join(ROOT, dir, name);
        const st = fs.statSync(full);
        return st.isFile() ? { name, rel: `${dir}/${name}`, mtime: st.mtime } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function walkFiles(dir, depth = 0) {
  if (depth > 3) return [];
  let entries;
  try { entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) out.push(...walkFiles(`${dir}/${e.name}`, depth + 1));
    else out.push({ name: e.name, rel: `${dir}/${e.name}`, mtime: fs.statSync(path.join(ROOT, dir, e.name)).mtime });
  }
  return out;
}

const fmtDate = (d) => d.toISOString().slice(0, 10);

function openRisksCount() {
  try {
    const text = fs.readFileSync(path.join(ROOT, `${SP}/risks.md`), 'utf8');
    return (text.match(/\|\s*abiert[oa]\b[^|]*\|/gi) || []).length;
  } catch {
    return 0;
  }
}
// Estados validos de una fila RAID (columna Estado de la tabla risks.md). Igual que estado_fase,
// el usuario puede escribir en su idioma habitual; aqui solo se reconocen las formas canonicas +
// sinonimos directos — si un dia hace falta mas variedad, se amplia esta lista, no se hardcodea logica.
const RISK_ESTADOS = ['abierto', 'abierta', 'mitigado', 'mitigada', 'cerrado', 'cerrada', 'aceptado', 'aceptada', 'materializado', 'materializada'];
// GUARDIAN de riesgos: filas de la tabla RAID con un Estado que NO es ninguno de los reconocidos
// (typo, valor libre) — no rompe validate (RAID es prosa de gestion, no un contrato rigido), pero
// avisa para que no se pierda un riesgo por un estado mal escrito.
function riskEstadoIssues() {
  let text; try { text = fs.readFileSync(path.join(ROOT, `${SP}/risks.md`), 'utf8'); } catch { return []; }
  const rows = text.match(/^\|.+\|.+\|.+\|.+\|.+\|.+\|\s*$/gm) || [];
  const issues = [];
  for (const row of rows) {
    const cols = row.split('|').map((c) => c.trim()).filter((c, i, a) => !(i === 0 && c === '') && !(i === a.length - 1 && c === ''));
    const last = cols[cols.length - 1];
    if (!last || /^-+$/.test(last) || /^estado$/i.test(last)) continue; // separador de tabla / cabecera
    if (!RISK_ESTADOS.some((e) => last.toLowerCase().includes(e))) {
      issues.push(`fila con Estado no reconocido: "${last}" (usa uno de: ${RISK_ESTADOS.slice(0, 6).join(' | ')}…)`);
    }
  }
  return issues;
}

// ANDAMIAJE (no cuenta como actividad documental): plantillas/, README de carpeta, .gitkeep, render-doc.mjs, html/.
function isScaffold(rel) {
  const r = String(rel || '').replace(/\\/g, '/');
  return /(^|\/)plantillas\//.test(r) || /(^|\/)README\.md$/i.test(r) || /\.gitkeep$/i.test(r) || /render-doc\.mjs$/i.test(r) || /(^|\/)html\//.test(r);
}
function allDocs() {
  return [
    ...walkFiles(SPEC_BASE), ...listFiles(`${SP}/brainstorming`),
    ...listFiles(`${SP}/decisions`), ...listFiles(`${REPORTING}/informes`),
    ...walkFiles(DOCS), ...listFiles(FLOWS), ...listFiles(SRC), ...walkFiles(`${REPORTING}/presentaciones`),
  ].filter((f) => f && !isScaffold(f.rel));
}

function progressOf(relPath) {
  const text = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const done = (text.match(/- \[x\]/gi) || []).length;
  const open = (text.match(/- \[ \]/g) || []).length;
  const total = done + open;
  return total ? `${done}/${total} tareas (${Math.round((done / total) * 100)}%)` : 'sin checklist';
}


  return { emit, decide, deny, ask, readStdin, listFiles, walkFiles, fmtDate, openRisksCount, RISK_ESTADOS, riskEstadoIssues, isScaffold, allDocs, progressOf };
};
