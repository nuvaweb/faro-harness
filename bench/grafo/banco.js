// bench/grafo/banco.js — piezas del banco de medida del grafo FARO (#308).
//
// Mide si el grafo ahorra: las mismas tareas en tres BRAZOS sobre un clon desechable del repo —
//   frio    : sin índice y con el grafo apagado (ni segundo plano ni empuje): el agente explora solo.
//   empuje  : índice construido y empuje por hooks encendido (lo que trae FARO por defecto).
//   demanda : índice construido, sin empuje: el agente solo tiene `harness.js grafo …` si lo pide.
// Las métricas salen del stream-json de `claude -p` (coste, tiempo, turnos, tokens, llamadas);
// el acierto, de la comprobación de cada tarea. Nada sale de la máquina salvo la propia sesión.
'use strict';
const fs = require('fs');
const path = require('path');

const PLUGIN = path.join(__dirname, '..', '..', 'plugins', 'faro');
const lib = (rel) => require(path.join(PLUGIN, 'hooks', 'lib', rel));

const BRAZOS = ['frio', 'empuje', 'demanda'];
const EXPLORA = new Set(['Grep', 'Glob', 'Read', 'LS']);
const BUSCA_EN_BASH = /(^|[\s|;&(])(grep|rg|find|ls|cat|head|tail|sed -n)\b/;
const GRAFO_EN_BASH = /harness\.js["']?\s+grafo\b/;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Métricas de una ejecución a partir del texto stream-json (una línea JSON por evento). */
function metricas(texto) {
  const m = { completo: false, error: false, coste: null, ms: null, turnos: null,
    tokens: { entrada: 0, cacheEscrita: 0, cacheLeida: 0, salida: 0, sinCache: 0 },
    llamadas: 0, porHerramienta: {}, exploracion: 0, grafo: 0 };
  for (const l of String(texto || '').split(/\r?\n/)) {
    let ev;
    try { ev = JSON.parse(l); } catch { continue; }
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'assistant') {
      const contenido = ev.message && Array.isArray(ev.message.content) ? ev.message.content : [];
      for (const c of contenido) {
        if (!c || c.type !== 'tool_use') continue;
        const n = String(c.name || '?');
        m.llamadas++;
        m.porHerramienta[n] = (m.porHerramienta[n] || 0) + 1;
        const cmd = n === 'Bash' && c.input ? String(c.input.command || '') : '';
        if (GRAFO_EN_BASH.test(cmd)) m.grafo++;
        else if (EXPLORA.has(n) || BUSCA_EN_BASH.test(cmd)) m.exploracion++;
      }
    } else if (ev.type === 'result') {
      const u = ev.usage || {};
      m.completo = true;
      m.error = !!ev.is_error;
      m.coste = typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null;
      m.ms = typeof ev.duration_ms === 'number' ? ev.duration_ms : null;
      m.turnos = typeof ev.num_turns === 'number' ? ev.num_turns : null;
      m.tokens = { entrada: num(u.input_tokens), cacheEscrita: num(u.cache_creation_input_tokens),
        cacheLeida: num(u.cache_read_input_tokens), salida: num(u.output_tokens) };
      m.tokens.sinCache = m.tokens.entrada + m.tokens.cacheEscrita + m.tokens.salida;
    }
  }
  return m;
}

/** Deja el clon `root` listo para un brazo: config del grafo e índice. Nunca pisa otras claves. */
function prepararBrazo(root, brazo) {
  if (!BRAZOS.includes(brazo)) throw new Error(`brazo desconocido: ${brazo} (válidos: ${BRAZOS.join(', ')})`);
  const C = lib('config-repo.js');
  const I = lib('grafo/indice.js');
  const grafo = { ...(C.leer(root).grafo || {}) };
  if (brazo === 'frio') {
    grafo.fondo = false;
    grafo.empuje = false;
    const p = I.rutaIndice(root);
    for (const f of [p, `${p}.resumen.json`]) { try { fs.unlinkSync(f); } catch { /* no estaba */ } }
  } else {
    delete grafo.fondo;
    if (brazo === 'demanda') grafo.empuje = false; else delete grafo.empuje;
    if (!I.guardar(root, I.construir(root, {}))) throw new Error('no se pudo guardar el índice del grafo');
  }
  C.fusionar(root, { grafo });
}

/** Errores del fichero de tareas ([] si vale). */
function validarTareas(t) {
  const e = [];
  if (!t || typeof t !== 'object') return ['el fichero de tareas no es un objeto'];
  const repos = t.repos && typeof t.repos === 'object' ? t.repos : null;
  if (!repos || !Object.keys(repos).length) e.push('faltan los repos ({ "repos": { "<nombre>": { "ruta": "…" } } })');
  if (!Array.isArray(t.tareas) || !t.tareas.length) e.push('faltan las tareas');
  const vistos = new Set();
  for (const [i, x] of (Array.isArray(t.tareas) ? t.tareas : []).entries()) {
    const q = `tarea ${x && x.id ? x.id : '#' + (i + 1)}`;
    if (!x || !x.id) e.push(`${q}: falta id`);
    else if (vistos.has(x.id)) e.push(`${q}: id repetido`);
    else vistos.add(x.id);
    if (!x || !repos || !repos[x.repo]) e.push(`${q}: repo desconocido (${x && x.repo})`);
    if (!x || !String(x.prompt || '').trim()) e.push(`${q}: falta prompt`);
    if (!x || !String(x.comprobar || '').trim()) e.push(`${q}: falta comprobar`);
  }
  return e;
}

/** Argumentos de `claude` para una ejecución: no interactiva, stream-json, con el plugin de ESTE repo. */
function argsClaude(prompt, { pluginDir = PLUGIN, permisos = 'acceptEdits', modelo } = {}) {
  const a = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', permisos,
    '--plugin-dir', pluginDir, '--settings', JSON.stringify({ enabledPlugins: { 'faro@faro-marketplace': false } })];
  if (modelo) a.push('--model', modelo);
  return a;
}

const media = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const pct = (v, ref) => (v == null || !ref ? '' : ` (${v >= ref ? '+' : ''}${Math.round(((v - ref) / ref) * 100)}%)`);

/** Informe markdown: una fila por brazo con medias y, salvo frío, la diferencia frente a frío. */
function informe(resultados) {
  const rs = Array.isArray(resultados) ? resultados : [];
  if (!rs.length) return '# Banco del grafo FARO\n\nSin ejecuciones.\n';
  const por = {};
  for (const r of rs) (por[r.brazo] = por[r.brazo] || []).push(r);
  const resumen = (b) => {
    const xs = por[b] || [];
    const val = (f) => media(xs.map((r) => f(r.metricas || {})).filter((v) => typeof v === 'number'));
    return { n: xs.length, ok: xs.filter((r) => r.acierto).length,
      coste: val((m) => m.coste), sinCache: val((m) => m.tokens && m.tokens.sinCache),
      llamadas: val((m) => m.llamadas), exploracion: val((m) => m.exploracion),
      grafo: val((m) => m.grafo), s: val((m) => (m.ms == null ? null : m.ms / 1000)) };
  };
  const ref = por.frio ? resumen('frio') : null;
  const orden = [...BRAZOS.filter((b) => por[b]), ...Object.keys(por).filter((b) => !BRAZOS.includes(b))];
  const f = (v, d) => (v == null ? '—' : v.toFixed(d));
  const lineas = ['# Banco del grafo FARO', '',
    '| brazo | ejecuciones | acierto | coste medio (USD) | tokens sin caché | llamadas | exploración | grafo | tiempo (s) |',
    '|---|---|---|---|---|---|---|---|---|'];
  for (const b of orden) {
    const x = resumen(b);
    const cmp = (k) => (b === 'frio' || !ref ? '' : pct(x[k], ref[k]));
    lineas.push(`| ${b} | ${x.n} | ${x.ok}/${x.n} | ${f(x.coste, 3)}${cmp('coste')} | ${f(x.sinCache, 0)}${cmp('sinCache')} | ` +
      `${f(x.llamadas, 1)}${cmp('llamadas')} | ${f(x.exploracion, 1)} | ${f(x.grafo, 1)} | ${f(x.s, 1)}${cmp('s')} |`);
  }
  return lineas.join('\n') + '\n';
}

module.exports = { BRAZOS, metricas, prepararBrazo, validarTareas, argsClaude, informe };
