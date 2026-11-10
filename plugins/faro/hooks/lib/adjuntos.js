/**
 * FARO · adjuntos — lo que ACOMPAÑA a un issue (capturas, documentos, ficheros) para que el triaje
 * lo LEA, no solo sepa que existe (#108).
 *
 * Antes el triaje marcaba 'captura: true' y seguia: "se detecta su presencia, no se lee". En un bug
 * visual o en una revision de textos (caso real: partner-portal#67, cuyas 5 pantallas solo estaban
 * dentro de un PDF adjunto) eso deja fuera la mejor evidencia.
 *
 * Dos partes:
 *   - extraerAdjuntos(texto): PURA. Distingue ADJUNTOS de enlaces que NO lo son y conviven en el
 *     mismo issue ("Ver en Userback", el commit, el repo, la pagina de la app).
 *   - descargar(adjuntos, dir, opts): con RED y limites. El token solo viaja a hosts de GitHub o al
 *     host de la forja del issue (opts.ghHost); a cualquier otro host, nunca.
 */
const fs = require('fs');
const path = require('path');

const EXT_IMAGEN = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
const EXT_DOC = ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'csv', 'txt', 'log', 'json', 'xml', 'yml', 'yaml', 'md', 'html', 'htm', 'zip', 'har'];
const MAX_ADJUNTOS = 10;
const MAX_BYTES = 15 * 1024 * 1024;

const extension = (url) => {
  const limpio = String(url).split(/[?#]/)[0];
  const m = limpio.match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : '';
};
const esAdjuntoGithub = (url) => /github\.com\/user-attachments\/(assets|files)\/|private-user-images\.githubusercontent\.com|github\.com\/[^/]+\/[^/]+\/files\//i.test(url);
const tipoDe = (url, porImagen) => {
  const ext = extension(url);
  if (porImagen || EXT_IMAGEN.includes(ext)) return 'imagen';
  return 'documento';
};

/** Adjuntos de un texto markdown/HTML, sin duplicados y en orden de aparicion. */
function extraerAdjuntos(texto) {
  const src = String(texto || '');
  const vistos = new Map();
  const add = (url, nombre, porImagen) => {
    const u = String(url).trim().replace(/[)>.,]+$/, '');
    if (!/^https?:\/\//i.test(u) || vistos.has(u)) return;
    vistos.set(u, { url: u, nombre: nombre || path.basename(u.split(/[?#]/)[0]) || 'adjunto', tipo: tipoDe(u, porImagen) });
  };
  // 1) Imagenes: ![alt](url) y <img src="url">
  for (const m of src.matchAll(/!\[([^\]]*)\]\((\S+?)(?:\s+"[^"]*")?\)/g)) add(m[2], m[1], true);
  for (const m of src.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)) add(m[1], '', true);
  // 2) Enlaces [texto](url): adjunto si el texto lo dice (📎 / adjunto / attachment) o si la URL es
  //    un fichero (extension conocida) o un adjunto de GitHub. "Ver en Userback" o un commit, no.
  for (const m of src.matchAll(/(^|[^!])\[([^\]]+)\]\((\S+?)\)/g)) {
    const [, , etiqueta, url] = m;
    const ext = extension(url);
    const dice = /📎|adjunt|attach/i.test(etiqueta);
    if (dice || esAdjuntoGithub(url) || EXT_DOC.includes(ext) || EXT_IMAGEN.includes(ext)) {
      add(url, dice ? path.basename(String(url).split(/[?#]/)[0]) : etiqueta, false);
    }
  }
  // 3) URLs sueltas de adjuntos de GitHub (al arrastrar un fichero, GitHub a veces deja solo la URL).
  for (const m of src.matchAll(/https?:\/\/(?:github\.com\/user-attachments\/(?:assets|files)\/|private-user-images\.githubusercontent\.com\/)[^\s"'<>()[\]]+/gi)) add(m[0], '', false);
  return [...vistos.values()];
}

/** Como debe leer el agente cada adjunto (lo dice el harness, no lo adivina el modelo). */
function comoLeer(a) {
  const ext = extension(a.ruta || a.url);
  if (a.tipo === 'imagen' || ext === 'pdf') return 'Read (ver el contenido)';
  if (['docx', 'doc'].includes(ext)) return 'skill docx';
  if (['xlsx', 'xls'].includes(ext)) return 'skill xlsx';
  if (ext === 'pptx') return 'skill pptx';
  if (ext === 'zip') return 'listar su contenido antes de abrir nada';
  return 'Read (texto)';
}

const hostDe = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
const esHostGithub = (h, ghHost) => h === 'github.com' || h.endsWith('.githubusercontent.com') || (!!ghHost && h === ghHost);

// SOLO hosts de adjuntos conocidos. El cuerpo de un issue lo escribe gente de FUERA (para eso existe
// el triaje): sin esta lista, una URL a la red interna o a un servicio de metadatos la descargaria
// la maquina de quien tria (SSRF). Lo demas se lista con motivo para abrirlo a mano si se confia.
const HOSTS_ADJUNTOS = ['static.userback.io'];
const hostPermitido = (h, ghHost) => esHostGithub(h, ghHost) || HOSTS_ADJUNTOS.includes(h);
const MAX_SALTOS = 5;

// Sigue redirecciones A MANO para revalidar cada salto: un host permitido podria redirigir fuera.
// El token tampoco viaja a un salto que no sea de GitHub.
async function traer(url, { token, ghHost, fetchImpl }) {
  let actual = url;
  for (let i = 0; i <= MAX_SALTOS; i++) {
    const h = hostDe(actual);
    if (new URL(actual).protocol !== 'https:' || !hostPermitido(h, ghHost)) return { motivo: `host no permitido (${h || actual}): abrelo a mano si confias en el` };
    const headers = token && esHostGithub(h, ghHost) ? { Authorization: `Bearer ${token}` } : {};
    const r = await fetchImpl(actual, { headers, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    if (r.status >= 300 && r.status < 400 && r.headers && r.headers.get('location')) { actual = new URL(r.headers.get('location'), actual).href; continue; }
    return { r };
  }
  return { motivo: 'demasiadas redirecciones' };
}

/** Descarga con limites. Devuelve cada adjunto con {ruta} o {motivo} si no se pudo: nunca lo calla. */
async function descargar(adjuntos, dir, { token = null, ghHost = null, fetchImpl = fetch } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (const [i, a] of adjuntos.entries()) {
    if (i >= MAX_ADJUNTOS) { out.push({ ...a, motivo: `limite de ${MAX_ADJUNTOS} adjuntos: no descargado` }); continue; }
    try {
      const { r, motivo } = await traer(a.url, { token, ghHost, fetchImpl });
      if (motivo) { out.push({ ...a, motivo }); continue; }
      if (!r.ok) { out.push({ ...a, motivo: `HTTP ${r.status}` }); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_BYTES) { out.push({ ...a, motivo: `pesa ${Math.round(buf.length / 1048576)} MB (limite 15)` }); continue; }
      const ext = extension(a.url) || extensionDeTipo(r.headers.get('content-type'));
      const base = path.basename(String(a.nombre || 'adjunto')).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'adjunto';
      const nombre = `${String(i + 1).padStart(2, '0')}-${base}${ext && !base.toLowerCase().endsWith(`.${ext}`) ? `.${ext}` : ''}`;
      const ruta = path.join(dir, nombre);
      fs.writeFileSync(ruta, buf);
      out.push({ ...a, ruta, bytes: buf.length });
    } catch (e) { out.push({ ...a, motivo: (e && e.name === 'TimeoutError') ? 'no respondio en 30s' : String((e && e.message) || e) }); }
  }
  return out.map((a) => (a.ruta ? { ...a, leer: comoLeer(a) } : a));
}

function extensionDeTipo(ct) {
  const t = String(ct || '').split(';')[0].trim().toLowerCase();
  return ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf', 'text/plain': 'txt', 'application/json': 'json', 'text/csv': 'csv' })[t] || '';
}

module.exports = { extraerAdjuntos, descargar, comoLeer, MAX_ADJUNTOS };
