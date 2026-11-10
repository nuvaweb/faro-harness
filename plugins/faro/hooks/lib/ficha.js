// lib/ficha.js — FICHA AUTOCONTENIDA de un issue para el subagente implementador (#134).
//
// Un subagente arranca sin la conversacion: lo que no este en su prompt lo supone. La ficha le da,
// en < 2.000 tokens, todo lo que necesita para empezar sin reconstruir el contexto:
//   - el issue (objetivo, alcance, criterios — es donde vive el detalle del trabajo);
//   - la app a la que pertenece (etiqueta app:<id>) y sus rasgos: ruta, worker, front, contrato,
//     tests, CLAUDE.md propio;
//   - el cambio spec-driven vinculado (proposal resumida + requisitos de sus deltas + progreso del
//     tasks.md);
//   - las rutas a leer y como abrir la rama y cerrar el PR.
//
// El presupuesto manda: si el issue es largo se recorta su cuerpo (con el enlace al completo), nunca
// la estructura. Estimacion de tokens conservadora: 1 token cada 3,5 caracteres.
'use strict';
const fs = require('fs');
const path = require('path');

const PRESUPUESTO = 2000;
const estimarTokens = (txt) => Math.ceil(String(txt || '').length / 3.5);
const leer = (abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch { return null; } };

function frontmatter(txt) {
  const m = String(txt || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = {};
  if (m) for (const l of m[1].split(/\r?\n/)) { const mm = l.match(/^([\w-]+):\s*(.*?)\s*$/); if (mm) fm[mm[1]] = mm[2]; }
  return fm;
}

// Cuerpo de una seccion '## Titulo' (hasta la siguiente cabecera del mismo nivel o superior).
function seccion(txt, ...titulos) {
  const lineas = String(txt || '').split(/\r?\n/);
  const i = lineas.findIndex((l) => { const m = l.match(/^##\s+(.+?)\s*$/); return m && titulos.some((t) => m[1].toLowerCase().startsWith(t.toLowerCase())); });
  if (i === -1) return '';
  const resto = lineas.slice(i + 1);
  const fin = resto.findIndex((l) => /^#{1,2}\s/.test(l));
  return (fin === -1 ? resto : resto.slice(0, fin)).join('\n').trim();
}

const recortar = (txt, max) => {
  const t = String(txt || '').trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).replace(/\s+\S*$/, '')}…`;
};

/** slug del cambio ligado al issue: proposal con 'issue: N' o el cuerpo que lo cita. */
function buscarCambio(root, specBase, numero, cuerpo) {
  const dir = path.join(root, specBase, 'changes');
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { ents = []; }
  for (const e of ents) {
    if (!e.isDirectory() || e.name === 'archive') continue;
    const fm = frontmatter(leer(path.join(dir, e.name, 'proposal.md')));
    if (String(fm.issue || '').replace(/^#/, '') === String(numero)) return e.name;
  }
  const m = String(cuerpo || '').match(/changes\/([A-Za-z0-9._-]+)\/?/);
  if (m && m[1] !== 'archive' && fs.existsSync(path.join(dir, m[1]))) return m[1];
  return null;
}

/** Resumen del cambio: proposal (titulo, estado, por que, que cambia), requisitos de los deltas y tasks.md. */
function resumenCambio(root, specBase, slug) {
  const base = path.join(root, specBase, 'changes', slug);
  const prop = leer(path.join(base, 'proposal.md'));
  if (prop == null) return null;
  const fm = frontmatter(prop);
  const cuerpo = prop.replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
  const queCambia = seccion(cuerpo, 'Qué cambia', 'Que cambia').split(/\r?\n/).filter((l) => /^\s*[-*]\s/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, '').trim());
  const deltas = [];
  let caps = [];
  try { caps = fs.readdirSync(path.join(base, 'specs'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { caps = []; }
  for (const cap of caps) {
    const spec = leer(path.join(base, 'specs', cap, 'spec.md')) || '';
    const reqs = [];
    let tipo = null;
    for (const l of spec.split(/\r?\n/)) {
      const s = l.match(/^##\s+Requisitos\s+(\S+)/i); if (s) { tipo = s[1].toUpperCase(); continue; }
      const r = l.match(/^###\s+Requisito:\s*(.+?)\s*$/i); if (r) reqs.push(`${tipo ? `[${tipo}] ` : ''}${r[1]}`);
    }
    deltas.push({ capacidad: cap, requisitos: reqs });
  }
  const tasks = leer(path.join(base, 'tasks.md'));
  const t = tasks == null ? null : { total: (tasks.match(/- \[[ xX]\]/g) || []).length, hechas: (tasks.match(/- \[[xX]\]/g) || []).length };
  return {
    slug, ruta: `${specBase}/changes/${slug}/`, titulo: fm.titulo || slug, estado: fm.estado || null,
    porQue: seccion(cuerpo, 'Por qué', 'Por que'), queCambia, deltas, tasks: t,
  };
}

/** Normaliza un issue de GitHub o GitLab a lo que usa la ficha. */
function normalizarIssue(j) {
  if (!j) return null;
  const etiquetas = (j.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean);
  return {
    numero: j.number != null ? j.number : j.iid,
    titulo: j.title || '',
    estado: j.state || '',
    url: j.html_url || j.web_url || '',
    etiquetas,
    hito: j.milestone ? j.milestone.title : null,
    asignados: (j.assignees || []).map((a) => a.login || a.username).filter(Boolean),
    cuerpo: j.body != null ? j.body : (j.description || ''),
  };
}

const appsDeEtiquetas = (etiquetas) => (etiquetas || []).filter((e) => /^app:/.test(e)).map((e) => e.slice(4));

function bloqueApp(a) {
  const ras = [];
  if (a.worker) ras.push(`worker${a.worker.nombre ? ` '${a.worker.nombre}'` : ''}${a.worker.fichero ? ` (${a.worker.fichero})` : ''}`);
  if (a.front) ras.push(`front ${a.front}`);
  if (a.paquete) ras.push(`paquete ${a.paquete}${a.version ? `@${a.version}` : ''}`);
  const out = [`## App: ${a.id} (${a.ruta || 'sin carpeta'})`];
  if (a.rol) out.push(`Rol: ${a.rol}`);
  if (ras.length) out.push(`Rasgos: ${ras.join(' · ')}`);
  if (a.equipo) out.push(`Equipo: ${Array.isArray(a.equipo) ? a.equipo.join(', ') : a.equipo}`);
  const leerPrimero = [];
  if (a.claudeMd && a.ruta) leerPrimero.push(`${a.ruta}/CLAUDE.md`);
  if (a.agentsMd && a.ruta) leerPrimero.push(`${a.ruta}/AGENTS.md`);
  if (a.contrato) leerPrimero.push(`${a.contrato} (contrato: no lo rompas)`);
  if (leerPrimero.length) out.push(`Lee primero: ${leerPrimero.join(' · ')}`);
  if (a.tests) out.push(`Tests: ${a.tests.carpeta || (a.tests.colocados ? `junto al codigo (${a.ruta}/src)` : 'SIN tests — el primero lo creas tu')}`);
  return out.join('\n');
}

function bloqueCambio(c, maxPorQue) {
  const out = [`## Cambio spec-driven: ${c.slug} (${c.estado || 'sin estado'})`, `Titulo: ${c.titulo}`];
  if (c.porQue) out.push(`Por que: ${recortar(c.porQue.replace(/\s+/g, ' '), maxPorQue)}`);
  if (c.queCambia.length) out.push('Que cambia:', ...c.queCambia.slice(0, 8).map((x) => `- ${recortar(x, 160)}`), ...(c.queCambia.length > 8 ? [`- … y ${c.queCambia.length - 8} mas (proposal.md)`] : []));
  for (const d of c.deltas) {
    out.push(`Delta ${d.capacidad}: ${d.requisitos.length ? '' : '(sin requisitos)'}`);
    for (const r of d.requisitos.slice(0, 10)) out.push(`- ${recortar(r, 140)}`);
    if (d.requisitos.length > 10) out.push(`- … y ${d.requisitos.length - 10} mas`);
  }
  if (c.tasks) out.push(`tasks.md: ${c.tasks.hechas}/${c.tasks.total} hechas`);
  else out.push('tasks.md: aun no existe (lo genera /faro:aplicar desde la proposal y los deltas)');
  return out.join('\n');
}

/**
 * Compone la ficha. {issue (normalizado), apps: App[], appsDesconocidas: string[], cambio, monorepo}
 * -> texto que cabe en 'presupuesto' tokens.
 */
function componerFicha({ issue, apps = [], appsDesconocidas = [], cambio = null, monorepo = false }, { presupuesto = PRESUPUESTO } = {}) {
  const cab = [
    `# Ficha del issue #${issue.numero} — ${issue.titulo}`,
    [issue.estado && `Estado: ${issue.estado}`, issue.hito && `Hito: ${issue.hito}`, issue.etiquetas.length && `Etiquetas: ${issue.etiquetas.join(', ')}`, issue.asignados.length && `Asignado: ${issue.asignados.map((a) => `@${a}`).join(', ')}`].filter(Boolean).join(' · '),
    issue.url,
  ].filter(Boolean).join('\n');
  const partesApp = apps.map(bloqueApp);
  if (appsDesconocidas.length) partesApp.push(`⚠ Etiqueta de app sin app en el monorepo: ${appsDesconocidas.map((x) => `app:${x}`).join(', ')}`);
  if (monorepo && !apps.length && !appsDesconocidas.length) partesApp.push('⚠ Monorepo: el issue no lleva etiqueta app:<id>. Confirma a que app afecta antes de tocar codigo.');
  const rutas = [];
  for (const a of apps) if (a.ruta) rutas.push(`${a.ruta}/`);
  if (cambio) rutas.push(cambio.ruta);
  const pie = [
    '## Rutas',
    ...(rutas.length ? rutas.map((r) => `- ${r}`) : ['- (sin rutas propias: el issue dice donde)']),
    '## Como trabajar',
    `- Rama: harness.js rama <tipo> "<tema>" --issue ${issue.numero}`,
    '- TDD: escribe el test, comprueba que FALLA por la razon correcta, implementa el minimo.',
    `- No amplies alcance: lo colateral, como nota en el PR. PR a develop con "Closes #${issue.numero}".`,
  ].join('\n');
  const cuerpoLimpio = String(issue.cuerpo || '').replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').replace(/^(#{1,5}) /gm, '$1# ').trim();   // sus cabeceras, un nivel por debajo de las de la ficha
  const armar = (cuerpo, porQue) => [cab, '## Issue', cuerpo || '(issue sin cuerpo: pide el detalle antes de empezar)', ...partesApp, ...(cambio ? [bloqueCambio(cambio, porQue)] : []), pie].join('\n\n');
  // 1) Sin recortes, si cabe.
  let txt = armar(cuerpoLimpio, 600);
  if (estimarTokens(txt) <= presupuesto) return txt;
  // 2) Se recorta el cuerpo del issue (con enlace al completo) y el 'por que'.
  const fijo = estimarTokens(armar('', 300));
  const libre = Math.max(0, Math.floor((presupuesto - fijo - 30) * 3.5));
  const aviso = `\n… (recortado para la ficha: el issue completo en ${issue.url || `#${issue.numero}`})`;
  txt = armar(recortar(cuerpoLimpio, Math.max(0, libre - aviso.length)) + aviso, 300);
  if (estimarTokens(txt) <= presupuesto) return txt;
  // 3) Ultimo recurso: se corta por caracteres (la estructura de arriba ya ocupa casi todo).
  return `${txt.slice(0, Math.floor(presupuesto * 3.5) - 60)}\n… (ficha recortada al presupuesto)`;
}

module.exports = { PRESUPUESTO, estimarTokens, buscarCambio, resumenCambio, normalizarIssue, appsDeEtiquetas, componerFicha, seccion };
