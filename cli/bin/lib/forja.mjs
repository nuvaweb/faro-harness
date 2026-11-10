// forja.mjs — que forja hay detras de un remoto (github | gitlab | desconocida). Port fiel de
// lib/forge.js del plugin faro, para que wizard y harness decidan IGUAL.
//
// Solo es GitHub/GitLab si el HOST lo es: una ruta local con barras casaba antes con la regex
// 'org/repo' y el CLI creia estar en GitHub. GitLab anida subgrupos sin limite: se conserva la ruta
// completa (es el id de su API, codificada con encodeURIComponent). GitHub es SIEMPRE owner/repo.
// Si no hay senal, 'desconocida' es una respuesta valida y honesta: no se adivina. Un servidor propio
// solo se reconoce si su forja esta DECLARADA (git config, ver forja-propia.mjs) o un perfil lo nombra:
// un host con 'gitlab' en el nombre no es por eso un GitLab ni merece recibir un token.
const RE_GITHUB = /(^|\.)github\.com$/i;
const RE_GITLAB = /(^|\.)gitlab\.com$/i;

function hostDe(remote) {
  const r = String(remote || '').trim();
  if (!r) return null;
  // scp-like: git@host:ruta.git
  const scp = r.match(/^[^@\s]+@([^:]+):(.+)$/);
  if (scp) return { host: scp[1], rutaRaw: scp[2] };
  // url: proto://[user[:pass]@]host[:puerto]/ruta
  const url = r.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
  if (url) return { host: url[1], rutaRaw: url[2] };
  return null;   // ruta local o formato no reconocido
}

// perfiles: los conocidos. declarada: forja declarada en git config para ese host ('github'|'gitlab').
function detectarForja(remote, perfiles = [], declarada = null) {
  const vacio = { forja: 'desconocida', host: null, owner: null, project: null, path: null, remote: remote || null, selfHosted: false, declarada: false };
  const hd = hostDe(remote);
  if (!hd) return vacio;
  const host = hd.host.toLowerCase();
  const path = hd.rutaRaw.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!path) return { ...vacio, host };
  const segs = path.split('/').filter(Boolean);
  if (segs.length < 2) return { ...vacio, host, path, project: segs[0] || null };
  let forja = 'desconocida', selfHosted = false, decl = false;
  if (RE_GITHUB.test(host)) forja = 'github';
  else if (RE_GITLAB.test(host)) forja = 'gitlab';
  else if (['github', 'gitlab'].includes(declarada)) { forja = declarada; selfHosted = true; decl = true; }
  else {
    const p = (perfiles || []).find((x) => x.host && x.host.toLowerCase() === host);
    if (p) { forja = p.forja; selfHosted = true; decl = true; }
  }
  // GitHub es SIEMPRE owner/repo: si vinieran mas segmentos, los dos ultimos mandan.
  const gh = forja === 'github' && segs.length > 2 ? segs.slice(-2) : segs;
  return { forja, host, selfHosted, declarada: decl, owner: gh[0], project: gh[gh.length - 1], path: gh.join('/'), remote };
}

export { hostDe, detectarForja };
