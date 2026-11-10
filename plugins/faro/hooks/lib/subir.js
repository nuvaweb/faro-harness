// lib/subir.js — TODA subida (push) del harness pasa por aqui (#194).
//
// Antes cada sitio hacia su 'git push' y, si fallaba, mandaba al usuario a "subir a mano" o a la web
// de la forja. Pero el harness YA tiene un token valido (~/.faro.json): la credencial de git (SSH,
// credential manager) es solo UNA via. Orden:
//   1) 'git push origin <refs>' normal, sin prompts (stdin cerrado, GIT_TERMINAL_PROMPT=0).
//   2) Si falla por credenciales/red y hay token: push a la URL HTTPS de la forja con el token en una
//      cabecera ACOTADA AL HOST de la forja que vive SOLO en el entorno de ese proceso (GIT_CONFIG_*):
//      ni en .git/config, ni en la linea de comandos (visible en la lista de procesos), ni reescribiendo
//      'origin', ni enviada a otro host (submodulos, LFS, hooks que hablen con otro remoto).
//   3) Si la forja RECHAZA (rama protegida, hook) el token no lo arregla: 'rechazado', y el llamante
//      integra por PETICION via API (integrar / subirOIntegrar), que es lo que la proteccion SI admite.
//   Un rechazo por ir POR DETRAS (non-fast-forward) tampoco lo arregla el token: se dice tal cual.
//
// subir(refs, { ROOT, upstream, timeoutMs, token, urlAlternativa }) -> { ok, via, rechazado, msg, salida }
//   token/urlAlternativa: inyectables (tests); por defecto se deducen del remoto y del almacen.
'use strict';
const { spawnSync, execFileSync } = require('child_process');

const TIMEOUT_MS = 120000;   // un push real tras antivirus/red lenta pasa de 15s sin estar colgado
const RE_RECHAZO = /GH006|protected branch|\[remote rejected\]|pre-receive hook declined|You are not allowed to push code to protected branches/i;
const RE_DETRAS = /\[rejected\][^\n]*\((non-fast-forward|fetch first)\)/i;
const USUARIO_TOKEN = { github: 'x-access-token', gitlab: 'oauth2' };
const MSG_RECHAZO = 'la forja rechazo el push directo (rama protegida o regla del servidor): hay que integrarlo por peticion (API).';

function urlHttps(f) {
  if (!f || !USUARIO_TOKEN[f.forge] || !f.host || !f.path) return null;
  return `https://${f.host}/${f.path}.git`;
}

const gitL = (ROOT) => (...a) => { try { return execFileSync('git', a, { windowsHide: true, cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

function correr(ROOT, args, env, timeoutMs) {
  const r = spawnSync('git', args, {
    windowsHide: true, cwd: ROOT, encoding: 'utf8', timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
  });
  return { ok: r.status === 0, salida: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

// Via del token: {url, env} o {msg} si no la hay. La cabecera solo se aplica al host de la URL.
function viaToken(ROOT, opts) {
  let { token, urlAlternativa } = opts;
  let f = null;
  if (token === undefined || urlAlternativa === undefined) {
    f = require('./forge.js').detect(gitL(ROOT));
    if (urlAlternativa === undefined) urlAlternativa = urlHttps(f);
    if (token === undefined) token = f && f.host ? require('./credenciales.js')().tokenPara(f.host) : null;
  }
  if (!token || !urlAlternativa) return { msg: `${!token ? 'no hay token del harness' : 'el remoto no es de una forja conocida'}. Conectate una vez con: node .claude/hooks/harness.js auth (codigo de 6 digitos) y reintenta.` };
  const usuario = USUARIO_TOKEN[(f && f.forge) || 'github'] || 'x-access-token';
  const basic = Buffer.from(`${usuario}:${token}`).toString('base64');
  const host = /^https:\/\/([^/]+)\//.exec(urlAlternativa);
  return {
    url: urlAlternativa,
    env: {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: host ? `http.https://${host[1]}/.extraheader` : 'http.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
      GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '',
    },
  };
}

function subir(refs, opts = {}) {
  const { ROOT, upstream = false, timeoutMs = TIMEOUT_MS } = opts;
  const g = gitL(ROOT);
  const lista = [].concat(refs).filter(Boolean);

  const a = correr(ROOT, ['push', ...(upstream ? ['-u'] : []), 'origin', ...lista], {}, timeoutMs);
  if (a.ok) return { ok: true, via: 'git', rechazado: false, msg: '', salida: a.salida };
  if (RE_RECHAZO.test(a.salida)) return { ok: false, via: null, rechazado: true, msg: MSG_RECHAZO, salida: a.salida };
  if (RE_DETRAS.test(a.salida)) return { ok: false, via: null, rechazado: false, detras: true, msg: 'la rama remota tiene commits que tu copia local no tiene: trae primero lo de la forja (/faro:sincronizar) y reintenta.', salida: a.salida };

  const t = viaToken(ROOT, opts);
  if (!t.url) return { ok: false, via: null, rechazado: false, msg: `el push fallo y ${t.msg}`, salida: a.salida };
  const b = correr(ROOT, ['push', t.url, ...lista], t.env, timeoutMs);
  if (!b.ok) {
    if (RE_RECHAZO.test(b.salida)) return { ok: false, via: null, rechazado: true, msg: MSG_RECHAZO, salida: b.salida };
    if (RE_DETRAS.test(b.salida)) return { ok: false, via: null, rechazado: false, detras: true, msg: 'la rama remota tiene commits que tu copia local no tiene: trae primero lo de la forja (/faro:sincronizar) y reintenta.', salida: b.salida };
    return { ok: false, via: null, rechazado: false, msg: `el push fallo tambien con el token del harness${b.salida ? `: ${b.salida.split('\n').slice(-2).join(' ')}` : ''}. Si el token caduco: node .claude/hooks/harness.js auth.`, salida: `${a.salida}\n${b.salida}` };
  }
  // Se empujo a una URL, no a 'origin': git no sabe que origin/<rama> avanzo. Se refleja a mano para
  // que el resto del harness (rama publicada / al dia) vea lo mismo que veria tras un push normal.
  for (const ref of lista) {
    const rama = ref.replace(/^refs\/heads\//, '');
    if (/^refs\/tags\//.test(ref) || g('rev-parse', '--verify', '--quiet', `refs/heads/${rama}`) === null) continue;
    const sha = g('rev-parse', `refs/heads/${rama}`);
    if (sha) g('update-ref', `refs/remotes/origin/${rama}`, sha);
    if (upstream) { g('config', `branch.${rama}.remote`, 'origin'); g('config', `branch.${rama}.merge`, `refs/heads/${rama}`); }
  }
  return { ok: true, via: 'token', rechazado: false, msg: '', salida: b.salida };
}

// traer(rama): origin/<rama> al dia, con la misma cascada que subir (git normal -> token). Sin esto,
// tras fusionar por API con el token un 'git fetch' sin credencial fallaba en silencio y origin/<rama>
// seguia con el valor VIEJO: se alineaba (y se tageaba) el commit anterior a la release.
function traer(rama, opts = {}) {
  const { ROOT, timeoutMs = TIMEOUT_MS } = opts;
  const refspec = `+refs/heads/${rama}:refs/remotes/origin/${rama}`;
  const a = correr(ROOT, ['fetch', 'origin', refspec], {}, timeoutMs);
  if (a.ok) return { ok: true, via: 'git' };
  const t = viaToken(ROOT, opts);
  if (!t.url) return { ok: false, msg: `no pude traer '${rama}': ${t.msg}` };
  const b = correr(ROOT, ['fetch', t.url, refspec], t.env, timeoutMs);
  return b.ok ? { ok: true, via: 'token' } : { ok: false, msg: `no pude traer '${rama}' de la forja${b.salida ? `: ${b.salida.split('\n').slice(-1)[0]}` : ''}` };
}

// moverRama(rama, sha): la rama local pasa a 'sha'. Si es la rama en curso, con 'reset --keep' (respeta
// el arbol de trabajo); si no, moviendo la ref. Devuelve {ok, msg}: un fallo se dice, no se calla.
function moverRama(rama, sha, { ROOT }) {
  const g = gitL(ROOT);
  if (!sha) return { ok: false, msg: `sin commit al que mover '${rama}'` };
  if (g('rev-parse', '--abbrev-ref', 'HEAD') === rama) {
    const r = correr(ROOT, ['reset', '--keep', sha], {}, TIMEOUT_MS);
    return r.ok ? { ok: true } : { ok: false, msg: `no pude mover '${rama}' (estas en ella y 'reset --keep' fallo: ${r.salida.split('\n')[0]})` };
  }
  return g('update-ref', `refs/heads/${rama}`, sha) !== null ? { ok: true } : { ok: false, msg: `no pude mover la ref de '${rama}'` };
}

// integrar({ROOT, gh, head, base, titulo, cuerpo, debeContener}): peticion head -> base fusionada por la
// API y VERIFICADA: se trae base de la forja y se exige que sea el sha que la forja dice haber creado
// y que contenga 'debeContener'. Solo entonces devuelve {ok, sha}: quien llama alinea y tagea sobre eso.
async function integrar({ ROOT, gh, head, base, titulo, cuerpo, debeContener, esperaMs }) {
  if (!gh || !gh.integrarPorPeticion) return { ok: false, msg: 'esta forja no tiene adaptador para integrar por peticion.' };
  // #262: el commit que se acaba de subir ES la cabeza que debe fusionarse. Se pasa como SHA esperado:
  // GitLab lo exige (require_sha_for_merge) y puede no tenerlo calculado aun en una MR recien abierta.
  const ip = await gh.integrarPorPeticion({ head, base, titulo, cuerpo, esperaMs, sha: debeContener });
  if (!ip.ok) return { ok: false, msg: ip.msg, numero: ip.numero, url: ip.url };
  const tr = traer(base, { ROOT });
  const g = gitL(ROOT);
  const remoto = tr.ok ? g('rev-parse', `refs/remotes/origin/${base}`) : null;
  const contiene = remoto && debeContener ? g('merge-base', '--is-ancestor', debeContener, remoto) !== null : !!remoto;
  if (!tr.ok || !remoto || (ip.sha && remoto !== ip.sha) || !contiene) {
    return { ok: false, fusionada: true, numero: ip.numero, url: ip.url, msg: `la forja fusiono la peticion ${ip.numero ? `#${ip.numero} ` : ''}pero no pude comprobar el resultado en '${base}'${tr.ok ? '' : ` (${tr.msg})`}. No muevo ni tageo nada sobre un commit sin verificar: trae '${base}' (/faro:sincronizar) y revisa.` };
  }
  return { ok: true, sha: remoto, numero: ip.numero, url: ip.url };
}

// subirOIntegrar(rama, {ROOT, gh, titulo}): sube la rama; si la forja la RECHAZA por protegida, sube lo
// local a una rama temporal, la integra por peticion en 'rama', verifica y alinea la local con la forja.
// Sirve para develop (merges de consolidar, commit de cierre de publicar, commits de estado) sin perder
// ningun commit local: todos viajan en la temporal. La temporal se borra al terminar (best-effort).
async function subirOIntegrar(rama, { ROOT, gh, titulo, cuerpo, esperaMs } = {}) {
  const s = subir([rama], { ROOT });
  if (s.ok || !s.rechazado || !gh || !gh.integrarPorPeticion) return s;
  const g = gitL(ROOT);
  const local = g('rev-parse', `refs/heads/${rama}`);
  if (!local) return { ok: false, msg: `no encuentro la rama local '${rama}'` };
  const temp = `faro/integrar-${rama.replace(/[^\w.-]+/g, '-')}-${local.slice(0, 7)}`;
  const st = subir([`${local}:refs/heads/${temp}`], { ROOT });
  if (!st.ok) return { ok: false, msg: `'${rama}' esta protegida y no pude subir la rama temporal para la peticion: ${st.msg}` };
  const ip = await integrar({ ROOT, gh, head: temp, base: rama, titulo: titulo || `Integrar ${rama} local en ${rama}`, cuerpo, debeContener: local, esperaMs });
  // La peticion y la temporal se dejan abiertas a proposito: el reintento (mismo sha7) las reutiliza.
  if (!ip.ok) return { ok: false, fusionada: ip.fusionada, msg: `${ip.msg}${ip.fusionada ? '' : ` La peticion${ip.url ? ` (${ip.url})` : ''} y la rama temporal '${temp}' quedan abiertas: el reintento las reutiliza.`}`, numero: ip.numero, url: ip.url };
  const mv = moverRama(rama, ip.sha, { ROOT });
  subir([`:refs/heads/${temp}`], { ROOT });
  if (!mv.ok) return { ok: false, msg: `integrada por peticion${ip.numero ? ` #${ip.numero}` : ''}, pero ${mv.msg}` };
  return { ok: true, via: 'api', numero: ip.numero, url: ip.url, sha: ip.sha };
}

subir.urlHttps = urlHttps;
subir.RE_RECHAZO = RE_RECHAZO;
subir.traer = traer;
subir.moverRama = moverRama;
subir.integrar = integrar;
subir.subirOIntegrar = subirOIntegrar;
module.exports = subir;
