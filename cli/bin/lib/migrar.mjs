// migrar.mjs — llevar un repo a otra forja o cuenta sin perder nada: crea el destino, sube TODAS las
// ramas y tags, apunta origin al nuevo (sin token) y, solo si se pide, archiva el viejo. Archivar deja
// el viejo en solo lectura; nunca se borra.
import { execFileSync } from 'node:child_process';

// El token NUNCA va en la URL ni en los argumentos (se verían en la lista de procesos y podrían
// quedar en .git/config o en un error): viaja por entorno como cabecera HTTP acotada al host destino,
// sumada a la configuración por entorno que ya hubiera.
function entornoConToken(host, usuario, token, base = process.env) {
  const n = Number(base.GIT_CONFIG_COUNT) || 0;
  return {
    ...base, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: `http.https://${host}/.extraHeader`,
    [`GIT_CONFIG_VALUE_${n}`]: `Authorization: Basic ${Buffer.from(`${usuario}:${token}`).toString('base64')}`,
  };
}

// Quita de un texto el token (en claro y como Basic) y cualquier credencial de una URL.
function sanear(txt, token, usuario = '') {
  let s = String(txt || '').replace(/(https?:\/\/)[^/@\s]+@/g, '$1***@');
  if (token) {
    for (const t of [token, Buffer.from(`${usuario}:${token}`).toString('base64')]) s = s.split(t).join('***');
  }
  return s;
}

// git sin helpers ni preguntas: solo la credencial del entorno.
function gitReal(dir, a, env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }) {
  execFileSync('git', ['-c', 'credential.helper=', '-c', 'credential.interactive=false', '-C', dir, ...a], { stdio: 'ignore', windowsHide: true, env });
}

// alta: el adaptador de la forja destino (existe, crearRepo). cuenta = { org, personal }. url: la del
// repo destino, sin credenciales; usuario: el de HTTP de la forja (x-access-token, oauth2).
async function migrarRepo({ dir, alta, sesion, cuenta, nombre, ruta, url, usuario, remotoViejo = null, git = gitReal }) {
  const existe = await alta.existe(sesion, ruta);
  if (existe === null) throw new Error(`No pude consultar ${ruta} en ${sesion.host}.`);
  let creado = false;
  if (!existe) {
    const r = await alta.crearRepo(sesion, cuenta, { nombre, descripcion: 'migrado con FARO' });
    if (!r.ok) throw new Error(`No pude crear ${ruta}: ${r.mensaje}`);
    creado = true;
  }
  const env = entornoConToken(sesion.host, usuario, sesion.token);
  try {
    git(dir, ['push', url, 'refs/heads/*:refs/heads/*'], env);
    git(dir, ['push', url, 'refs/tags/*:refs/tags/*'], env);
    git(dir, ['remote', remotoViejo ? 'set-url' : 'add', 'origin', url]);
  } catch (e) { throw new Error(sanear(e.message, sesion.token, usuario)); }
  return { creado };
}

const apiGithub = (host) => (/(^|\.)github\.com$/i.test(host) ? 'https://api.github.com' : `https://${host}/api/v3`);

// Archiva el repo viejo (solo lectura). Sin token o con forja desconocida no llama a nada.
async function archivarRepo({ forja, host, ruta, token, fetchImpl = fetch }) {
  if (!token || !['github', 'gitlab'].includes(forja)) return { ok: false, status: 0 };
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [url, init] = forja === 'github'
    ? [`${apiGithub(host)}/repos/${ruta}`, { method: 'PATCH', body: JSON.stringify({ archived: true }), headers: { ...headers, Accept: 'application/vnd.github+json' } }]
    : [`https://${host}/api/v4/projects/${encodeURIComponent(ruta)}/archive`, { method: 'POST', headers }];
  try {
    const r = await fetchImpl(url, init);
    return { ok: !!r.ok, status: r.status };
  } catch { return { ok: false, status: 0 }; }
}

export { migrarRepo, archivarRepo, entornoConToken, sanear };
