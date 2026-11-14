// lib/grafo/minado.js — minado determinista de aprendizajes candidatos (#302, T12).
//
// Sin modelo y sin red: solo lee disco. Fuentes:
//   - conversaciones de Claude Code del repo (<home>/.claude/projects/<slug>/*.jsonl, solo ESE directorio):
//     correcciones del usuario al agente y un comando de tests que falla >= 2 veces y luego pasa.
//     Opt-out: faro/config.json > grafo.aprender.conversaciones === false => ningun .jsonl se abre.
//   - git: reverts de los ultimos 200 commits y pares de ficheros que cambian juntos >= 5 veces.
//   - ADR (<gestion>/decisions/*.md) y specs: solo se ENLAZAN como `refs` cuando citan un fichero del
//     candidato; su texto no se copia.
// Cada senal queda como candidato en <cache>/candidatos/<id>.json (faro/.cache/candidatos en layout faro),
// con un fragmento de <= 400 caracteres filtrado: si contiene un secreto (lib/guardas.js) el candidato
// NO se guarda; emails, telefonos y tokens largos se enmascaran. El id es estable (hash de la fuente):
// minar dos veces no duplica, y un candidato descartado o aceptado (_estado.json) no vuelve.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const I = require('./indice.js');
const paths = require('../paths.js');
const { detectarLayout } = require('../paths.js');

const MAX_FRAGMENTO = 400;
const TOPE_JSONL = 20 * 1024 * 1024;
const MAX_JSONL = 30;
const MAX_LINEA = 2 * 1024 * 1024;
const N_COMMITS = 200;
const MIN_COCAMBIO = 5;
const MAX_COCAMBIOS = 20;
const MAX_FICHEROS_COMMIT = 30;
const MARGEN_FONDO_MS = 10 * 60 * 1000;
const TOPE_DOC = 1.5 * 1024 * 1024;
const MAX_CORRECCION = 600; // un mensaje mas largo no es una correccion tecleada, es un pegado o un informe
const MAX_TOCA_CONV = 5;
// Version del filtro: al subirla, las conversaciones se releen enteras y los pendientes que ya no pasan se borran.
const FILTRO = 3; // 3: solo lo que se repite (#309)

// Texto de un mensaje "user" que NO tecleo la persona: harness, compactacion, interrupciones, otros agentes.
const RE_NO_HUMANO = /^(<|\[Request interrupted|This session is being continued from a previous conversation|Another Claude session sent a message|\[Subagent hand-back\]|Caveat: The messages below were generated)/;
// Ficheros que cambian juntos por proceso (version, registro, gestion), no por acoplamiento.
const RE_COCAMBIO_PROCESO = /(^|\/)(CHANGELOG[^/]*|marketplace\.json|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.faro\.json|ESTADO\.md)$|(^|\/)\.claude-plugin\/[^/]+\.json$|^faro\/config\.json$|^(faro\/)?gestion\//;

const RE_CORRECCION = /^\s*(no\b|mal\b|eso no\b)|\b(eso no|te dije|no hagas|en vez de|deja de)\b/i;
const RE_DESCARTE = /\b(no hagas|en vez de|deja de)\b/i;
const RE_TEST = /\btest\b|\btests\b|\btest:/;
const RE_FALLO = /(^|\n)\s*not ok\b|\bFAIL(ED)?\b|\b[1-9]\d* (failed|failing)\b|#\s*fail\s+[1-9]/;

const sha1 = (x) => crypto.createHash('sha1').update(x).digest('hex');
const norm = (r) => String(r || '').split('\\').join('/');

// ---------- rutas ----------

/** Carpeta de candidatos: faro/.cache/candidatos (layout faro) o <gitdir>/faro-candidatos (legado). */
function dirCandidatos(root) {
  const base = path.dirname(I.rutaIndice(root));
  return path.join(base, detectarLayout(root) === 'legado' ? 'faro-candidatos' : 'candidatos');
}
const rutaEstado = (root) => path.join(dirCandidatos(root), '_estado.json');

/** Slug de Claude Code: la ruta absoluta con cada caracter no alfanumerico cambiado por '-'. */
const slugRepo = (abs) => String(abs).replace(/[^A-Za-z0-9]/g, '-');

// ---------- filtro ----------

let _guardas = null;
function secretosEn(texto) {
  if (!_guardas) _guardas = require('../guardas.js')({ fs, path, ROOT: process.cwd(), git: () => '', faroSchema: () => null });
  return _guardas.secretosEn(texto);
}

/** Enmascara emails, tokens largos y telefonos. */
function enmascarar(t) {
  return String(t)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[token]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, (m) => ((m.match(/\d/g) || []).length >= 9 ? '[tel]' : m));
}

/** Fragmento filtrado (<= 400) o null si el texto contiene un secreto. */
function fragmento(texto) {
  const t = String(texto || '');
  if (secretosEn(t).length) return null;
  const limpio = enmascarar(t.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim());
  return limpio.length > MAX_FRAGMENTO ? `${limpio.slice(0, MAX_FRAGMENTO - 1)}…` : limpio;
}

// ---------- estado ----------

function leerEstado(root) {
  try {
    const j = JSON.parse(fs.readFileSync(rutaEstado(root), 'utf8'));
    return {
      descartados: Array.isArray(j.descartados) ? j.descartados : [], aceptados: Array.isArray(j.aceptados) ? j.aceptados : [],
      minado: typeof j.minado === 'string' ? j.minado : null, jsonl: j.jsonl && typeof j.jsonl === 'object' && !Array.isArray(j.jsonl) ? j.jsonl : {},
      filtro: Number.isInteger(j.filtro) ? j.filtro : 1,
    };
  } catch { return { descartados: [], aceptados: [], minado: null, jsonl: {}, filtro: FILTRO }; }
}

function dirSeguro(root) {
  const dir = dirCandidatos(root);
  if (!I.dirSinEnlaces(root, dir)) return null;
  fs.mkdirSync(dir, { recursive: true });
  if (fs.lstatSync(dir).isSymbolicLink()) return null;
  return dir;
}

function escribirAtomico(root, abs, datos) {
  if (!dirSeguro(root)) return false;
  try { if (fs.lstatSync(abs).isSymbolicLink()) return false; } catch { /* no existe */ }
  const tmp = `${abs}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try { fs.writeFileSync(tmp, JSON.stringify(datos, null, 2) + '\n', { flag: 'wx' }); fs.renameSync(tmp, abs); return true; } catch { try { fs.rmSync(tmp, { force: true }); } catch { /* nada */ } return false; }
}

function guardarEstado(root, est) { return escribirAtomico(root, rutaEstado(root), est); }

const RE_ID_CAND = /^[0-9a-f]{12,40}$/;
const idValido = (id) => typeof id === 'string' && RE_ID_CAND.test(id);

/** Ruta del fichero de un candidato, o null si el id no es valido o la ruta saldria de la carpeta. */
function rutaCandidato(root, id) {
  if (!idValido(id)) return null;
  const dir = path.resolve(dirCandidatos(root));
  const abs = path.resolve(dir, `${id}.json`);
  return path.dirname(abs) === dir ? abs : null;
}

/** Marca un candidato como 'descartados' o 'aceptados' y borra su fichero. Lanza si el id no es valido. */
function marcar(root, id, lista) {
  const abs = rutaCandidato(root, id);
  if (!abs || !['descartados', 'aceptados'].includes(lista)) throw new Error(`id de candidato no válido: ${String(id).slice(0, 60)}`);
  const est = leerEstado(root);
  if (!est[lista].includes(id)) est[lista].push(id);
  const ok = guardarEstado(root, est);
  try { if (fs.lstatSync(abs).isFile()) fs.unlinkSync(abs); } catch { /* ya no estaba */ }
  return ok;
}

/** Candidatos pendientes (ni descartados ni aceptados), mas valiosos primero. */
function pendientes(root) {
  const est = leerEstado(root);
  const fuera = new Set([...est.descartados, ...est.aceptados]);
  const dir = dirCandidatos(root);
  const out = [];
  let ents = [];
  try { if (!I.dirSinEnlaces(root, dir)) return []; ents = fs.readdirSync(dir); } catch { return []; }
  for (const f of ents) {
    if (!/^[0-9a-f]{12,40}\.json$/.test(f)) continue;
    const idf = f.slice(0, -5);
    try {
      const abs = path.join(dir, f);
      if (!fs.lstatSync(abs).isFile()) continue;
      const c = JSON.parse(fs.readFileSync(abs, 'utf8'));
      if (c && c.id === idf && !fuera.has(c.id)) out.push(c); // el id debe ser el del nombre
    } catch { /* ilegible */ }
  }
  return out.sort((a, b) => (b.puntuacion || 0) - (a.puntuacion || 0) || String(a.id).localeCompare(String(b.id)));
}

// ---------- conversaciones ----------

function textoDe(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n');
}
function textoResultado(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('\n');
  return '';
}

/** Rels del repo citados en un texto (tokens con / y extension), relativizando absolutas dentro del repo. */
function rutasEn(root, texto) {
  const out = new Set();
  const rootN = norm(path.resolve(root)).toLowerCase();
  for (const m of String(texto || '').matchAll(/[A-Za-z0-9_.:\\/-]*[\\/][A-Za-z0-9_.\\/-]*\.[A-Za-z0-9]{1,6}\b/g)) {
    let r = norm(m[0]).replace(/^\.\//, '');
    if (/^[A-Za-z]:\//.test(r) || r.startsWith('/')) {
      if (!r.toLowerCase().startsWith(rootN + '/')) continue;
      r = r.slice(rootN.length + 1);
    }
    if (!r || r.startsWith('../') || r.includes('://') || r.includes(':')) continue;
    out.add(r);
  }
  return [...out];
}

/** Rel de una ruta de fichero (absoluta o relativa al repo), o null si cae fuera. Respeta espacios y acentos. */
function relDeRuta(root, ruta) {
  if (typeof ruta !== 'string' || !ruta || /[\u0000-\u001f]/.test(ruta)) return null;
  for (const base of raices(root)) {
    const rel = norm(path.relative(base, path.resolve(base, ruta)));
    if (rel && !rel.startsWith('../') && rel !== '..' && !path.isAbsolute(rel)) return rel;
  }
  return null;
}

/** Raiz del repo tal cual y resuelta (enlaces), sin duplicados. */
function raices(root) {
  const out = [path.resolve(root)];
  try { const r = fs.realpathSync(root); if (!out.includes(r)) out.push(r); } catch { /* sin realpath */ }
  return out;
}

/** Comparador de `cwd`: true si es el repo o un subdirectorio (mayusculas y separadores normalizados en Windows). */
function cwdDelRepo(root) {
  const n = (p) => { const x = norm(path.resolve(p)).replace(/\/+$/, ''); return process.platform === 'win32' ? x.toLowerCase() : x; };
  const rs = raices(root).map(n);
  return (cwd) => typeof cwd === 'string' && !!cwd && (() => { const c = n(cwd); return rs.some((r) => c === r || c.startsWith(`${r}/`)); })();
}

/** Lee un .jsonl linea a linea, con tope de bytes; devuelve los objetos parseables. */
function leerJsonl(abs) {
  const out = [];
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(256 * 1024);
    let resto = Buffer.alloc(0); let leidos = 0;
    const procesa = (b) => {
      if (!b.length || b.length > MAX_LINEA) return;
      try { out.push(JSON.parse(b.toString('utf8'))); } catch { /* linea rota */ }
    };
    while (leidos < TOPE_JSONL) {
      const k = fs.readSync(fd, buf, 0, Math.min(buf.length, TOPE_JSONL - leidos), null);
      if (k <= 0) break;
      leidos += k;
      let datos = Buffer.concat([resto, buf.subarray(0, k)]);
      let i;
      while ((i = datos.indexOf(10)) !== -1) { procesa(datos.subarray(0, i)); datos = datos.subarray(i + 1); }
      resto = datos.length > MAX_LINEA ? Buffer.alloc(0) : Buffer.from(datos);
    }
    if (leidos < TOPE_JSONL) procesa(resto);
  } finally { fs.closeSync(fd); }
  return out;
}

/**
 * Coste de la sesion de una ref de conversacion (`<sesion>.jsonl#Lnn`, #311): minutos entre el primer y el
 * ultimo timestamp y tokens de entrada+salida del asistente. Solo numeros: no se copia texto. null si no se puede.
 */
function costeSesion(root, home, ref) {
  const m = String(ref || '').match(/^([A-Za-z0-9._-]+\.jsonl)#L\d+$/);
  if (!m || !home) return null;
  const slugs = new Set([slugRepo(path.resolve(root))]);
  try { slugs.add(slugRepo(fs.realpathSync(root))); } catch { /* sin realpath */ }
  for (const s of slugs) {
    const abs = path.join(home, '.claude', 'projects', s, m[1]);
    try { if (!fs.lstatSync(abs).isFile()) continue; } catch { continue; }
    let ini = Infinity; let fin = -Infinity; let tokens = 0;
    for (const e of leerJsonl(abs)) {
      const t = Date.parse(e && e.timestamp);
      if (Number.isFinite(t)) { ini = Math.min(ini, t); fin = Math.max(fin, t); }
      const u = e && e.type === 'assistant' && e.message && e.message.usage;
      if (u) for (const k of ['input_tokens', 'output_tokens']) if (Number.isFinite(u[k]) && u[k] > 0) tokens += u[k];
    }
    const minutos = fin >= ini ? Math.round((fin - ini) / 60000) : 0;
    return minutos || tokens ? { minutos, tokens } : null;
  }
  return null;
}

/** true solo si el evento es texto tecleado por la persona (ni harness, ni resumen, ni agentes, ni tool_result). */
function esHumano(ev, msg, texto) {
  if (ev.isMeta || ev.isCompactSummary || ev.isSidechain || ev.isVisibleInTranscriptOnly) return false;
  if (msg.role && msg.role !== 'user') return false;
  if (Array.isArray(msg.content) && msg.content.some((p) => p && p.type === 'tool_result')) return false;
  return !RE_NO_HUMANO.test(texto);
}

function senalesConversacion(root, nombre, eventos, emitir, enIndice) {
  let previoAsistente = null; // { texto, rutas }
  const delRepo = cwdDelRepo(root); // un slug puede ser de otro repo (C:/x/a-b y C:/x/a_b colisionan)
  const tests = new Map(); // tool_use id -> comando
  const racha = new Map(); // comando -> fallos seguidos
  eventos.forEach((ev, n) => {
    const msg = ev && ev.message;
    if (!msg || typeof msg !== 'object' || ev.isSidechain) return; // la rama de un subagente no es la conversacion
    if (!delRepo(ev.cwd)) return; // sin cwd o de otro repo: no es de esta conversacion
    if (ev.type === 'assistant') {
      const partes = Array.isArray(msg.content) ? msg.content : [];
      const rutas = [];
      for (const p of partes) {
        if (!p || p.type !== 'tool_use' || !p.input) continue;
        if (typeof p.input.file_path === 'string') { const r = relDeRuta(root, p.input.file_path); if (r) rutas.push(r); }
        if (p.name === 'Bash' && typeof p.input.command === 'string' && RE_TEST.test(p.input.command)) tests.set(p.id, p.input.command.trim());
      }
      previoAsistente = { texto: textoDe(msg.content), rutas };
      return;
    }
    if (ev.type !== 'user') return;
    const partes = Array.isArray(msg.content) ? msg.content : [];
    for (const p of partes) {
      if (!p || p.type !== 'tool_result' || !tests.has(p.tool_use_id)) continue;
      const cmd = tests.get(p.tool_use_id);
      const fallo = p.is_error === true || (p.is_error !== false && RE_FALLO.test(textoResultado(p.content)));
      const k = racha.get(cmd) || 0;
      if (fallo) { racha.set(cmd, k + 1); continue; }
      racha.delete(cmd);
      if (k >= 2) {
        emitir({
          fuente: { tipo: 'conversacion', ref: `${nombre}#L${n + 1}` }, tipo_sugerido: 'cuidado',
          toca: rutasEn(root, cmd).filter(enIndice).slice(0, MAX_TOCA_CONV), texto: `«${cmd}» falló ${k} veces seguidas y luego pasó`, puntuacion: 2 + Math.min(k, 5),
        });
      }
    }
    const texto = textoDe(msg.content).trim();
    if (!texto) return;
    if (!previoAsistente || !esHumano(ev, msg, texto)) { previoAsistente = null; return; }
    if (texto.length <= MAX_CORRECCION && RE_CORRECCION.test(texto)) {
      emitir({
        fuente: { tipo: 'conversacion', ref: `${nombre}#L${n + 1}` }, tipo_sugerido: RE_DESCARTE.test(texto) ? 'descartado' : 'cuidado',
        toca: [...new Set([...rutasEn(root, texto), ...previoAsistente.rutas])].filter(enIndice).slice(0, MAX_TOCA_CONV), texto: `usuario: ${texto}`, puntuacion: 3,
      });
    }
    previoAsistente = null;
  });
}

/**
 * Lee las conversaciones del repo. Las sesiones sin cambios (misma firma) no se reabren: sus senales salen de
 * `guardadas` (las de la ultima lectura, ya filtradas). Devuelve las senales por sesion de las que se miraron.
 */
function minarConversaciones(root, home, emitir, vistos, enIndice, guardadas) {
  const porSesion = {};
  const slugs = new Set([slugRepo(path.resolve(root))]);
  try { slugs.add(slugRepo(fs.realpathSync(root))); } catch { /* sin realpath */ }
  for (const s of slugs) {
    const dir = path.join(home, '.claude', 'projects', s);
    let ents;
    try { if (!fs.lstatSync(dir).isDirectory()) continue; ents = fs.readdirSync(dir); } catch { continue; }
    const ficheros = [];
    for (const f of ents) {
      if (!f.endsWith('.jsonl')) continue;
      try { const st = fs.lstatSync(path.join(dir, f)); if (st.isFile()) ficheros.push({ f, st }); } catch { /* nada */ }
    }
    ficheros.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    for (const { f, st } of ficheros.slice(0, MAX_JSONL)) {
      if (porSesion[f]) continue;
      const firma = `${st.size}:${st.mtimeMs}`;
      if (vistos[f] === firma && Array.isArray(guardadas[f])) { porSesion[f] = guardadas[f]; continue; } // sin cambios
      const xs = [];
      try { senalesConversacion(root, f, leerJsonl(path.join(dir, f)), (c) => xs.push(c), enIndice); vistos[f] = firma; } catch { continue; /* ilegible */ }
      // Se guardan ya filtradas: lo que lleva un secreto no se escribe ni en la cache.
      porSesion[f] = xs.map((c) => ({ ...c, texto: fragmento(c.texto) })).filter((c) => c.texto !== null && !secretosEn(String(c.fuente.ref)).length);
    }
  }
  for (const xs of Object.values(porSesion)) for (const c of xs) emitir(c);
  for (const f of Object.keys(vistos)) if (!porSesion[f]) delete vistos[f];
  return porSesion;
}

// ---------- repeticion (#309) ----------

// Solo se propone lo que se repite: una correccion o una racha de tests en >= N sesiones, un comentario de
// revision en >= N PR. Huella determinista (sin modelo): mismo comando de tests, o palabras clave parecidas.
const MIN_REPETICION = 2;
const AGRUPABLES = new Set(['conversacion', 'revision']);
const VACIAS = new Set(('para como esto esta este estos estas pero porque otra otro otras otros nada hagas haces hacer dije '
  + 'deja dejes sigue vale aqui ahora todo toda todos cuando donde solo tambien entonces quiero mira tienes tiene hace '
  + 'with that this from have should would there').split(' '));

function palabras(texto) {
  const t = String(texto || '').replace(/^(usuario|revisi[oó]n en [^:\s]*)\s*:\s*/i, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return new Set((t.match(/[a-z]{4,}/g) || []).filter((w) => !VACIAS.has(w)));
}
const comandoRacha = (texto) => { const m = /^«(.+)» falló \d+ veces/.exec(String(texto)); return m ? m[1] : null; };
/** Sesion (jsonl) o PR del que viene una senal: dos senales del mismo origen no son repeticion. */
const origenDe = (s) => (s.fuente.tipo === 'revision' ? String(s.fuente.ref).split('/')[0] : String(s.fuente.ref).replace(/#L\d+$/, ''));

function parecidas(a, b) {
  if (a.fuente.tipo !== b.fuente.tipo) return false;
  if (a.cmd || b.cmd) return a.cmd === b.cmd;
  const cruzan = a.toca.some((t) => b.toca.includes(t));
  let comun = 0;
  for (const w of a.pal) if (b.pal.has(w)) comun++;
  const union = a.pal.size + b.pal.size - comun;
  if (!union) return cruzan;
  return comun / union >= (cruzan ? 0.25 : 0.5);
}

/** Grupos de senales parecidas (enlace simple, en orden de ref: determinista). */
function agrupar(senales) {
  const xs = senales.map((s) => ({ s, pal: palabras(s.texto), cmd: comandoRacha(s.texto), toca: s.toca, fuente: s.fuente }))
    .sort((a, b) => (String(a.fuente.ref) < String(b.fuente.ref) ? -1 : String(a.fuente.ref) > String(b.fuente.ref) ? 1 : 0));
  const grupos = [];
  for (const x of xs) {
    const g = grupos.find((gr) => gr.some((y) => parecidas(x, y)));
    if (g) g.push(x); else grupos.push([x]);
  }
  return grupos.map((g) => g.map((x) => x.s));
}

const rutaSenales = (root) => path.join(dirCandidatos(root), '_senales.json');
function leerSenales(root) {
  try { const j = JSON.parse(fs.readFileSync(rutaSenales(root), 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { return {}; }
}

// ---------- git ----------

function git(root, args) {
  try {
    const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return r.status === 0 ? String(r.stdout) : null;
  } catch { return null; }
}

function minarGit(root, emitir, idx) {
  // Solo codigo o test que existe en el indice y no cambia por proceso (version, registro, gestion).
  const esCodigo = (r) => {
    const n = idx && Object.prototype.hasOwnProperty.call(idx.ficheros, r) ? idx.ficheros[r] : null;
    return !!n && !RE_COCAMBIO_PROCESO.test(r) && (n.tipo === 'codigo' || n.tipo === 'test') && !!n.lenguaje;
  };
  const log = git(root, ['log', '-n', String(N_COMMITS), '--no-merges', '--name-only', '--format=%x00%H%x09%s']);
  if (!log) return;
  const commits = [];
  for (const bloque of log.split('\0').slice(1)) {
    const [cab, ...resto] = bloque.split(/\r?\n/);
    const [hash, ...s] = cab.split('\t');
    commits.push({ hash, asunto: s.join('\t'), ficheros: resto.map((l) => l.trim()).filter(Boolean) });
  }
  const pares = new Map();
  for (const c of commits) {
    if (/^Revert "/.test(c.asunto)) {
      emitir({ fuente: { tipo: 'revert', ref: c.hash }, tipo_sugerido: 'descartado', toca: c.ficheros.slice(0, 10), texto: `${c.hash.slice(0, 8)} ${c.asunto}`, puntuacion: 4 });
    }
    if (c.ficheros.length < 2 || c.ficheros.length > MAX_FICHEROS_COMMIT) continue;
    const fs2 = [...new Set(c.ficheros)].filter(esCodigo).sort();
    for (let i = 0; i < fs2.length; i++) for (let j = i + 1; j < fs2.length; j++) { const k = `${fs2[i]}\n${fs2[j]}`; pares.set(k, (pares.get(k) || 0) + 1); }
  }
  [...pares].filter(([, n]) => n >= MIN_COCAMBIO).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_COCAMBIOS).forEach(([k, n]) => {
    const [a, b] = k.split('\n');
    emitir({ fuente: { tipo: 'cochange', ref: `${a}|${b}` }, tipo_sugerido: 'cuidado', toca: [a, b], texto: `${a} y ${b} cambiaron juntos en ${n} de los últimos ${commits.length} commits`, puntuacion: 1 + Math.min(n / MIN_COCAMBIO, 3) });
  });
}

// ---------- ADR y specs (solo enlace) ----------

function documentosReferencia(root) {
  const P = paths(root);
  const out = [];
  const anadir = (abs, rel) => {
    try {
      const st = fs.lstatSync(abs);
      if (st.isFile() && st.size <= TOPE_DOC) out.push({ rel, txt: fs.readFileSync(abs, 'utf8') });
    } catch { /* nada */ }
  };
  const recorrer = (abs, rel, filtro, prof) => {
    if (prof > 6 || out.length > 1000) return;
    let ents;
    try { if (!I.dirSinEnlaces(root, abs) || !fs.lstatSync(abs).isDirectory()) return; ents = fs.readdirSync(abs).sort(); } catch { return; }
    for (const e of ents) {
      const a = path.join(abs, e);
      let st; try { st = fs.lstatSync(a); } catch { continue; }
      if (st.isDirectory()) recorrer(a, `${rel}/${e}`, filtro, prof + 1);
      else if (st.isFile() && filtro(e, `${rel}/${e}`)) anadir(a, `${rel}/${e}`);
    }
  };
  const dec = `${P.dir('gestion')}/decisions`;
  recorrer(path.join(root, dec), dec, (e) => /\.md$/i.test(e), 5);
  recorrer(path.join(root, P.specBase), P.specBase, (e, r) => /\/specs\//.test(r) && /\.md$/i.test(e), 0);
  return out;
}

// ---------- minar ----------

function idDe(fuente) { return sha1(`${fuente.tipo}\0${fuente.ref}`).slice(0, 16); }

/**
 * Mina las fuentes locales y deja candidatos nuevos. Devuelve { nuevos, total }. Nunca usa red.
 * `extra`: senales ya leidas por quien llama (la forja en `conocer`, #303) con la misma forma que las
 * locales ({ fuente, tipo_sugerido, toca, texto, puntuacion }); pasan por el MISMO filtro.
 */
function minar(root, { home = os.homedir(), ahora = Date.now, extra = [] } = {}) {
  const est = leerEstado(root);
  const fuera = new Set([...est.descartados, ...est.aceptados]);
  const vistos = est.filtro === FILTRO ? { ...est.jsonl } : {}; // filtro nuevo: se releen todas
  const guardadas = est.filtro === FILTRO ? leerSenales(root) : {};
  let idx = I.cargar(root); // toca y co-cambios solo con ficheros que existen: el indice manda
  // Se reconstruye si no esta fresco, salvo que un fallo reciente (marca .fallo < 24 h) frene al fondo.
  let fallo = false;
  try { fallo = Date.now() - fs.lstatSync(`${I.rutaIndice(root)}.fallo`).mtimeMs < 24 * 3600 * 1000; } catch { /* sin marca */ }
  try { if (!fallo && (!idx || !I.fresco(root, idx))) idx = require('./cli.js').construirYGuardar(root, ahora).idx; } catch { /* se usa el que haya */ }
  const enIndice = (r) => !!idx && typeof r === 'string' && !/[\u0000-\u001f\u007f]/.test(r) && Object.prototype.hasOwnProperty.call(idx.ficheros, r);
  const brutos = [];
  const emitir = (c) => brutos.push(c);
  for (const c of Array.isArray(extra) ? extra : []) if (c && c.fuente && Array.isArray(c.toca)) emitir(c);

  let conv = true;
  let minimo = MIN_REPETICION;
  try {
    const a = (require('../config-repo.js').leer(root).grafo || {}).aprender || {};
    if (a.conversaciones === false) conv = false;
    if (Number.isInteger(a.repeticion) && a.repeticion >= 1) minimo = a.repeticion;
  } catch { /* defectos */ }
  const conversaciones = conv && !!home;
  const porSesion = conversaciones ? minarConversaciones(root, home, emitir, vistos, enIndice, guardadas) : null;
  minarGit(root, emitir, idx);

  // Filtro primero (secretos fuera, datos personales enmascarados); luego se agrupa lo agrupable.
  const limpios = [];
  for (const b of brutos) {
    const texto = fragmento(b.texto);
    if (texto === null || secretosEn(String(b.fuente.ref)).length) continue; // contiene un secreto: no se guarda
    limpios.push({ ...b, texto });
  }
  const conRevisiones = limpios.some((b) => b.fuente.tipo === 'revision');
  const finales = limpios.filter((b) => !AGRUPABLES.has(b.fuente.tipo));
  for (const g of agrupar(limpios.filter((b) => AGRUPABLES.has(b.fuente.tipo)))) {
    const ids = g.map((s) => idDe(s.fuente));
    if (ids.some((id) => fuera.has(id))) continue; // aceptado o descartado: el grupo no vuelve
    const origenes = new Set(g.map(origenDe));
    if (origenes.size < minimo) continue;
    // Representante estable: el que ya tenga fichero; si no, el de ref menor.
    const existente = g.find((s) => { const abs = rutaCandidato(root, idDe(s.fuente)); try { return !!abs && fs.lstatSync(abs).isFile(); } catch { return false; } });
    const rep = existente || g[0];
    finales.push({
      ...rep, toca: [...new Set(g.flatMap((s) => s.toca))],
      puntuacion: Math.max(...g.map((s) => s.puntuacion || 0)) + Math.min(origenes.size - 1, 3),
      ocurrencias: g.map((s) => String(s.fuente.ref)).sort(),
    });
  }

  let docs = null;
  const cita = require('./historia.js').cita;
  let nuevos = 0;
  const producidos = new Set();
  const dir = finales.length ? dirSeguro(root) : null;
  for (const b of dir ? finales : []) {
    const id = idDe(b.fuente);
    if (fuera.has(id)) continue;
    const abs = rutaCandidato(root, id);
    if (!abs) continue;
    const ref = String(b.fuente.ref);
    producidos.add(id);
    const toca = [...new Set(b.toca.map(norm))].filter((t) => !t.includes('@') && !secretosEn(t).length).slice(0, 10);
    const puntuacion = Math.round(b.puntuacion * 10) / 10;
    let previo = null;
    try { fs.lstatSync(abs); previo = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { /* nuevo o ilegible */ }
    if (previo) {
      // Existente: solo se actualiza si el grupo crecio (otra sesion u otro PR con lo mismo).
      if (b.ocurrencias && previo.id === id && JSON.stringify(previo.ocurrencias) !== JSON.stringify(b.ocurrencias)) {
        escribirAtomico(root, abs, { ...previo, toca, puntuacion, ocurrencias: b.ocurrencias });
      }
      continue;
    }
    if (docs === null) docs = documentosReferencia(root);
    const refs = docs.filter((d) => toca.some((t) => cita(d.txt, t))).map((d) => d.rel).slice(0, 5);
    const fuente = { tipo: b.fuente.tipo, ref, ...(b.fuente.externa === true ? { externa: true } : {}) };
    const cand = { id, fuente, tipo_sugerido: b.tipo_sugerido, toca, fragmento: b.texto, refs, puntuacion, ...(b.ocurrencias ? { ocurrencias: b.ocurrencias } : {}), creado: new Date(ahora()).toISOString() };
    if (escribirAtomico(root, abs, cand)) nuevos++;
  }
  // Pendientes de una fuente leida entera que ya no salen (filtro mas estricto, version ruidosa o sin repeticion): fuera.
  // Las conversaciones se miran enteras (releidas o guardadas); las revisiones, solo si la forja respondio.
  for (const c of pendientes(root)) {
    const t = c.fuente && c.fuente.tipo;
    const entera = t === 'revert' || t === 'cochange' || (t === 'conversacion' && conversaciones) || (t === 'revision' && conRevisiones);
    if (!entera || producidos.has(c.id)) continue;
    const abs = rutaCandidato(root, c.id);
    try { if (abs && fs.lstatSync(abs).isFile()) fs.unlinkSync(abs); } catch { /* ya no estaba */ }
  }
  const actual = leerEstado(root); // otro proceso pudo descartar mientras minabamos
  if (dirSeguro(root)) {
    if (porSesion) escribirAtomico(root, rutaSenales(root), porSesion);
    guardarEstado(root, { descartados: actual.descartados, aceptados: actual.aceptados, minado: new Date(ahora()).toISOString(), jsonl: vistos, filtro: FILTRO });
    try { require('./cli.js').asegurarGitignore(root); } catch { /* opcional */ }
  }
  return { nuevos, total: pendientes(root).length };
}

/** Cuantos candidatos pendientes hay, sin parsearlos: ficheros <id>.json menos los de _estado.json. */
function contarPendientes(root) {
  let ents;
  try { ents = fs.readdirSync(dirCandidatos(root)); } catch { return 0; }
  const ids = ents.filter((f) => /^[0-9a-f]{12,40}\.json$/.test(f)).map((f) => f.slice(0, -5));
  if (!ids.length) return 0;
  const est = leerEstado(root);
  const fuera = new Set([...est.descartados, ...est.aceptados]);
  return ids.filter((id) => !fuera.has(id)).length;
}

/** true si el ultimo minado tiene mas de 10 min (o no hay). Para el fondo. */
function tocaMinar(root, ahora = Date.now) {
  const m = Date.parse(leerEstado(root).minado || '');
  return !Number.isFinite(m) || ahora() - m >= MARGEN_FONDO_MS || ahora() < m;
}

module.exports = { palabras, costeSesion, minar, tocaMinar, pendientes, contarPendientes, rutasEn, marcar, idValido, leerEstado, dirCandidatos, enmascarar, fragmento, slugRepo, idDe };
