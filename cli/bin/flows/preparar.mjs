// flows/preparar.mjs — lo común a crear y traer antes de tocar nada: la sesión con la forja, de qué
// cuenta es la clave SSH (solo informa) y el destino (cuenta, organización o grupo). El rol solo
// orienta: nunca bloquea.
import { DRY, argVal, C, elige, say, caja, saveConfig, fijarApi } from '../lib/core.mjs';
import { lineasPermisos } from '../lib/permisos.mjs';
import { asegurarGitCableado, apiBase } from '../lib/github.mjs';
import { asegurarGitIdentidad, cuentaSsh } from '../lib/repo.mjs';
import { resolverDestino, rolDestino } from '../lib/sesion.mjs';
import { flujoSesion, interactivo } from './login.mjs';

// De qué cuenta es la clave SSH. Una clave es de UNA cuenta: con varias cuentas en la misma forja es
// normal que no sea la de esta sesión. Solo informa, nunca bloquea: si no es de la sesión, git irá por
// HTTPS con el helper de FARO (token de la cuenta de la org), así los commits salen con la cuenta correcta.
function cuentaSshInformativa(ctx, { ssh = cuentaSsh, decir = say } = {}) {
  const { perfil, auth } = ctx;
  let sshLogin = null;
  try { sshLogin = ssh(perfil.host); } catch {}
  ctx.sshLogin = sshLogin;
  const loginTok = String(auth.login || '').toLowerCase();
  if (sshLogin && loginTok && sshLogin !== loginTok) decir(`${C.d}  Tu clave SSH es de @${sshLogin}; con @${loginTok} git irá por HTTPS con tu sesión (sin pedirte nada).${C.x}`);
  return sshLogin;
}

// opciones: dir, usarRemoto, remoto (URL), perfilFlag, org (destino ya conocido), preguntarDestino.
// Devuelve { ctx, auth, perfil, org, esOwner, fijarDestino } o null si hay que parar.
async function prepararSesion(cfg, { dir = argVal('dir'), usarRemoto = false, remoto = null, perfilFlag = argVal('perfil'), org: orgDado = null, preguntarDestino = true } = {}) {
  const ctx = await flujoSesion(cfg, { dir, perfilFlag, soloForja: argVal('forja'), usarRemoto, remoto });
  if (!ctx) return null;
  const { perfil, auth } = ctx;
  if (perfil.forja === 'github') fijarApi(apiBase(perfil.host));
  if (!DRY) {
    cuentaSshInformativa(ctx);
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
    // SSH solo si la clave es de la cuenta de la sesión; si no, credential helper HTTPS acotado a host/org.
    const { sshLogin } = ctx;
    asegurarGitCableado(r.org, sshLogin && sshLogin.toLowerCase() === String(auth.login || '').toLowerCase() ? sshLogin : null, perfil.host);
  };
  await r.fijarDestino(preguntarDestino);
  return r;
}

// Al terminar crear o traer: quién aprueba, cómo se añade gente y qué da cada nivel.
function mostrarPermisos(perfil, ruta) {
  if (!perfil || !ruta) return;
  caja(lineasPermisos({ forja: perfil.forja, host: perfil.host, ruta }), { titulo: 'Permisos' });
}

export { prepararSesion, mostrarPermisos, cuentaSshInformativa };
