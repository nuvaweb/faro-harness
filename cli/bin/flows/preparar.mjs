// flows/preparar.mjs — lo común a crear y traer antes de tocar nada: la sesión con la forja, la
// comprobación de que el SSH empuja como la misma cuenta que el token, y el destino (cuenta,
// organización o grupo). El rol solo orienta: nunca bloquea.
import { DRY, argVal, argFlag, C, elige, fail, warn, say, caja, saveConfig, fijarApi } from '../lib/core.mjs';
import { lineasPermisos } from '../lib/permisos.mjs';
import { asegurarGitCableado, apiBase } from '../lib/github.mjs';
import { asegurarGitIdentidad, cuentaSsh } from '../lib/repo.mjs';
import { resolverDestino, rolDestino } from '../lib/sesion.mjs';
import { flujoSesion, interactivo } from './login.mjs';

// El código lo mueve el SSH y la API el token: si son cuentas distintas, los commits saldrían con la
// equivocada. Se bloquea salvo --force. Devuelve false si hay que parar.
function cuentaCoherente(ctx) {
  const { perfil, auth } = ctx;
  const sshLogin = cuentaSsh(perfil.host);
  ctx.sshLogin = sshLogin;
  const loginTok = String(auth.login || '').toLowerCase();
  if (!sshLogin || !loginTok || sshLogin === loginTok) return true;
  if (argFlag('force')) {
    warn(`Tu SSH empuja como @${sshLogin} pero tu sesión es @${loginTok}. Sigo por --force: revisa que los commits salgan con la cuenta correcta.`);
    return true;
  }
  fail(`Cuenta cruzada: tu sesión (token) es @${loginTok}${auth.via ? ` (vía ${auth.via})` : ''} pero tu SSH empuja como @${sshLogin}.`);
  say(`${C.d}  Arréglalo con una de estas:${C.x}`);
  say(`${C.d}    · Conéctate con la cuenta correcta: faro --login --reautorizar,${C.x}`);
  say(`${C.d}      o exporta ${perfil.forja === 'gitlab' ? 'GITLAB_TOKEN' : 'GITHUB_TOKEN'} con el token de @${sshLogin} si esa es tu cuenta.${C.x}`);
  say(`${C.d}    · O carga en tu agente SSH la clave de @${loginTok}.${C.x}`);
  say(`${C.d}  Si usas dos cuentas a propósito, reejecuta con --force.${C.x}`);
  return false;
}

// opciones: dir, usarRemoto, remoto (URL), perfilFlag, org (destino ya conocido), preguntarDestino.
// Devuelve { ctx, auth, perfil, org, esOwner, fijarDestino } o null si hay que parar.
async function prepararSesion(cfg, { dir = argVal('dir'), usarRemoto = false, remoto = null, perfilFlag = argVal('perfil'), org: orgDado = null, preguntarDestino = true } = {}) {
  const ctx = await flujoSesion(cfg, { dir, perfilFlag, soloForja: argVal('forja'), usarRemoto, remoto });
  if (!ctx) return null;
  const { perfil, auth } = ctx;
  if (perfil.forja === 'github') fijarApi(apiBase(perfil.host));
  if (!DRY) {
    if (!cuentaCoherente(ctx)) return null;
    await asegurarGitIdentidad(auth, perfil);
  }
  const sesion = { forja: perfil.forja, host: perfil.host, token: auth.token, login: auth.login, id: auth.id };
  const r = { ctx, auth, perfil, org: null, esOwner: false };
  r.fijarDestino = async (preguntar) => {
    ctx.destino = await resolverDestino({ sesion, org: orgDado || argVal('org'), fijo: perfil.org, preguntar: preguntar && !DRY && interactivo() ? (ops) => elige('¿Dónde va el repositorio?', ops) : null });
    r.org = ctx.destino.org;
    r.esOwner = DRY || await rolDestino({ sesion, destino: ctx.destino });
    if (DRY) return;
    cfg.org = r.org; saveConfig(cfg);
    // SSH si ya autentica como la sesión; si no, credential helper HTTPS acotado a host/org.
    const { sshLogin } = ctx;
    asegurarGitCableado(r.org, sshLogin && sshLogin.toLowerCase() === String(auth.login || '').toLowerCase() ? sshLogin : (argFlag('force') ? sshLogin : null), perfil.host);
  };
  await r.fijarDestino(preguntarDestino);
  return r;
}

// Al terminar crear o traer: quién aprueba, cómo se añade gente y qué da cada nivel.
function mostrarPermisos(perfil, ruta) {
  if (!perfil || !ruta) return;
  caja(lineasPermisos({ forja: perfil.forja, host: perfil.host, ruta }), { titulo: 'Permisos' });
}

export { prepararSesion, mostrarPermisos };
