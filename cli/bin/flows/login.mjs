// flows/login.mjs — CONECTAR con una forja (modo propio `faro --login`) y SESIÓN compartida por todos
// los flujos (flujoSesion): resuelve el perfil (flag > remoto > único > pregunta), hace login por el
// adaptador del perfil, deja el helper de credenciales de git acotado y explica en llano cómo ha
// quedado la sesión.
//
// Por qué existe: los mensajes de todo el CLI mandaban a `faro --login --reautorizar` y ese modo no
// existía (caía en el menú). Y el login del wizard tiene que dejar al PLUGIN conectado a la vez:
// mismo fichero (~/.faro.json > tokens[host]) y, en GitLab, el client_id de la app en la entrada si se declaró una propia.
//
// SOBRE `url.<...>.insteadOf` (decisión revertida 2026-09-12): la primera versión de este módulo
// escribía en cada login una reescritura `insteadOf` con el token embebido, pensada para el refresco
// EN SEGUNDO PLANO del marketplace (que Anthropic documenta que ignora los credential helpers). El
// problema real, verificado en esta máquina: esa reescritura solo se resincroniza cuando alguien
// vuelve a ejecutar el wizard — si el token guardado se renueva por otra vía mientras tanto (visto
// aquí: renovación silenciosa vía refresh_token), la reescritura se queda con el token VIEJO, y como
// `insteadOf` gana sobre el credential helper, un push o una lectura del marketplace fallan con un
// error de autorización que no tiene relación con la causa real — una avería programada, no un riesgo
// teórico. El credential helper (`cablearHelper`, abajo) SÍ lee el token fresco del almacén en cada
// operación y ya alcanza para clonar/empujar y para el refresco EXPLÍCITO del marketplace que el
// propio wizard dispara en cada `crear`/`adoptar`/`check`. Por eso ahora solo se RETIRA la reescritura
// (limpieza idempotente, nunca escribe una nueva) — si algún día el refresco silencioso en segundo
// plano demuestra necesitarla de verdad, que sea una decisión explícita, no un efecto secundario del login.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { C, ok, warn, say, caja, saveConfig, elige, pregunta, secreto, DRY, YES, argFlag, argVal } from '../lib/core.mjs';
import { resolverPerfil, marketplaceDe, perfilesConocidos, perfilDeForja } from '../lib/perfil.mjs';
import { detectarForja } from '../lib/forja.mjs';
import { forjaDeRemoto, declararForja } from '../lib/forja-propia.mjs';
import { ayudaToken } from '../lib/ayuda-token.mjs';
import { hostPublico } from '../lib/credenciales.mjs';
import { forjaDe } from '../lib/forjas/index.mjs';
import { cablearHelper, retirarReescritura, overrideMarketplace } from '../lib/gitcred.mjs';
import { tokenPara, entrada, guardarToken } from '../lib/credenciales.mjs';
import { buscarSesiones, elegirSesion, textoSesion, mensajeSinSesion, nombreForja, perfilDeHost } from '../lib/sesion.mjs';
import { abrirNavegador, copiarPortapapeles } from '../lib/forjas/github.mjs';

const gitGlobal = (a) => { try { return execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); } catch { return ''; } };
// Remoto 'origin' de la carpeta (o cwd): lo que permite AUTODETECTAR forja y org sin preguntar.
const remotoActual = (dir) => gitGlobal(['-C', path.resolve(dir || process.cwd()), 'remote', 'get-url', 'origin']);
const puedeLeer = (url) => { try { execFileSync('git', ['-c', 'credential.interactive=false', 'ls-remote', '--heads', url, 'HEAD'], { stdio: 'ignore', timeout: 20000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }); return true; } catch { return false; } };

// Sin terminal o con --yes NO se pregunta: gana el último perfil usado (o el primero, GitHub).
const interactivo = () => !YES && !!process.stdin.isTTY;

// Forja del remoto de `dir`. Un servidor propio sin declarar se pregunta (y queda declarado) si hay terminal.
const forjaDeCarpeta = (dir, cfg) => forjaDeRemoto(remotoActual(dir), {
  dir: path.resolve(dir || process.cwd()), perfiles: perfilesConocidos(cfg),
  elegir: interactivo() ? (host, ops) => elige(`¿Qué forja es ${host}?`, ops) : null,
});

const forjaDeUrl = (url, cfg) => forjaDeRemoto(url, {
  perfiles: perfilesConocidos(cfg),
  elegir: interactivo() ? (host, ops) => elige(`¿Qué forja es ${host}?`, ops) : null,
});

// Resumen en llano de la sesión (puro: testeable).
function resumenLogin(auth, perfil, ch) {
  const out = [`${C.b}Conectado a ${nombreForja(perfil.forja)}${C.x} (${perfil.host}) como ${C.b}@${auth.login}${C.x}${auth.email ? ` · ${auth.email}` : ''}`];
  out.push(ch.scopesOk ? 'Permisos: correctos.' : `Permisos: faltan ${C.c}${(ch.faltan || []).join(', ')}${C.x} → faro --login --reautorizar`);
  out.push(ch.marketplace ? `Plugin faro: ${C.g}listo${C.x}, Claude Code lo puede descargar.`
    : `${C.y}Plugin faro: git no puede leer el marketplace${C.x} (${(perfil.plugin && perfil.plugin.url) || ''}). Revisa el acceso al repo del plugin.`);
  if (ch.expira && !ch.renovable) out.push(`${C.d}Los tokens de ${nombreForja(perfil.forja)} caducan a las 2 h: vuelve a ejecutar faro --login cuando expire (o usa --token con un token personal).${C.x}`);
  return out;
}

// UI del device flow de GitLab (el adaptador es puro; abrir navegador y copiar código es cosa del flujo).
const uiDeviceFlow = {
  mostrar(d) {
    const url = d.verification_uri_complete || d.verification_uri;
    const abierto = abrirNavegador(url);
    const copiado = copiarPortapapeles(d.user_code);
    caja([
      `${C.b}Inicia sesión en GitLab${C.x} ${C.d}(una sola vez en esta máquina; el token caduca a las 2 h)${C.x}`,
      '',
      `${abierto ? 'Te he abierto el navegador en:' : 'Abre en el navegador:'}  ${C.c}${url}${C.x}`,
      `Teclea este código:  ${C.b}${C.g}${d.user_code}${C.x}`,
    ], { titulo: 'Login', color: C.c });
    say(`  Código: ${d.user_code}${copiado ? `   ${C.g}✓ copiado al portapapeles${C.x}` : ''}`);
    say(`  ${C.d}Esperando a que autorices en el navegador…${C.x}`);
  },
};

// Perfil que ya viene dado: --perfil o el remoto de la carpeta. null: lo decide la sesión o quien ejecuta.
async function perfilFijado(cfg, flag, forjaDetectada) {
  if (flag) return resolverPerfil({ flag, cfg });
  const f = perfilDeForja(forjaDetectada, perfilesConocidos(cfg));
  return f ? f.perfil : null;
}

// Token personal con la ayuda de su forja: qué scopes y dónde se crea.
async function pedirToken(forja, host) {
  caja(ayudaToken(forja, host), { titulo: 'Token personal', color: C.c });
  return secreto('Pega el token');
}

const limpiarHost = (h) => String(h || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();

// Sin sesión ni perfil dado: se elige forja (navegador) o un token personal, también para un servidor
// propio (GitHub Enterprise, GitLab autoalojado): su forja queda declarada en faro.<host>.forja.
async function conexionNueva(cfg, soloForja) {
  let conToken = false;
  const elegir = interactivo() ? async (ops) => {
    const id = await elige('¿Con qué forja quieres conectar?', { ...ops, __token: { etiqueta: 'Con un token personal', explica: 'GitHub, GitLab o un servidor propio (GitHub Enterprise, GitLab autoalojado).' } });
    conToken = id === '__token';
    return conToken ? null : id;
  } : null;
  const elegido = await resolverPerfil({ cfg, soloForja, elegir });
  if (!conToken) return { perfil: elegido, tokenPegado: null };
  const forja = soloForja || await elige('¿Qué forja es?', { github: { etiqueta: 'GitHub', explica: 'github.com o GitHub Enterprise.' }, gitlab: { etiqueta: 'GitLab', explica: 'gitlab.com o un GitLab propio.' } });
  const host = limpiarHost(await pregunta('Dirección del servidor', forja === 'gitlab' ? 'gitlab.com' : 'github.com')) || `${forja}.com`;
  if (!hostPublico(host)) { try { declararForja(host, forja); } catch {} }
  const perfil = hostPublico(host) ? await resolverPerfil({ flag: forja, cfg }) : perfilDeHost(host, forja, null, null);
  return { perfil, tokenPegado: await pedirToken(forja, host) };
}

async function flujoLogin(cfg, { perfilFlag = null, soloForja = null, forjaDetectada = null, reautorizar = false, tokenPegado = null, perfilResuelto = null } = {}) {
  const fijado = perfilResuelto || await perfilFijado(cfg, perfilFlag, forjaDetectada);
  const nueva = fijado ? { perfil: fijado, tokenPegado: null } : await conexionNueva(cfg, soloForja);
  const { perfil } = nueva;
  const forja = await forjaDe(perfil);
  const mk = marketplaceDe(perfil, overrideMarketplace());
  if (DRY) { ok(`(dry-run) Conectaría con ${nombreForja(perfil.forja)} · ${perfil.host} (perfil ${perfil.id}); marketplace ${mk.url}.`); return { auth: { login: '(dry-run)' }, perfil, forja }; }
  if (reautorizar) { try { retirarReescritura(mk.url); } catch {} }
  let pegado = tokenPegado || nueva.tokenPegado;
  if (!pegado && !perfil.client_id && process.stdin.isTTY) pegado = await pedirToken(perfil.forja, perfil.host);
  const auth = perfil.forja === 'github'
    ? await forja.login(perfil, cfg, { reautorizar, tokenInicial: pegado ? { token: pegado, via: 'token personal' } : null })
    : await forja.login(perfil, cfg, { tokenPegado: pegado, ui: uiDeviceFlow });
  cfg.perfil_ultimo = perfil.id;
  saveConfig(cfg);
  // Credenciales de git: helper acotado a host/destino (clonar/push sin modal, token fresco en cada
  // operación). Se retira cualquier reescritura insteadOf que quedara de una versión anterior del
  // wizard (ver cabecera): esa vía queda como limpieza, nunca se vuelve a escribir aquí.
  cablearHelper(perfil.host, perfil.org || auth.login);
  try { retirarReescritura(mk.url); } catch {}
  const ch = { reescritura: false };
  if (perfil.forja === 'github') {
    const v = await forja.validarTokenSesion(cfg, perfil, { silencioSiOk: true });
    ch.scopesOk = v.ok; ch.faltan = v.faltan;
  } else {
    const en = entrada(perfil.host, cfg) || {};
    const sc = en.scopes || [];
    ch.scopesOk = sc.includes('api'); ch.faltan = ch.scopesOk ? [] : ['api'];
    ch.expira = !!en.expira; ch.renovable = !!en.refresh_token;
  }
  ch.marketplace = puedeLeer(mk.url);
  caja(resumenLogin(auth, perfil, ch), { titulo: 'Sesión', color: C.c });
  return { auth, perfil, forja, checks: ch };
}

const authDe = (s) => ({ token: s.token, login: s.login, id: s.id, name: s.name, email: s.email, email_contacto: s.email, via: s.via });

// GitLab: una sesión de fuera se guarda con el login; la guardada se usa, renovándola sin navegador si
// ha caducado. Sin sesión, o si no se pudo renovar, se conecta.
async function sesionGitlab(cfg, perfil, forja, s, reautorizar) {
  if (s && s.via !== 'sesión guardada') return { ...await forja.login(perfil, cfg, { tokenPegado: s.token, ui: uiDeviceFlow }), via: s.via };
  if (s && !s.renovable) return authDe(s);
  if (s) {
    const en = entrada(perfil.host, cfg) || {};
    const nv = await forja.renovar(perfil.host, en.client_id, en.refresh_token);
    if (nv) {
      guardarToken(perfil.host, { token: nv.token, refresh_token: nv.refresh_token, expira: nv.expira, forja: 'gitlab' }, cfg); saveConfig(cfg);
      ok('Sesión de GitLab renovada (sin pasar por el navegador).');
      return { ...authDe(s), token: nv.token };
    }
    warn('La sesión de GitLab ha caducado (los tokens duran 2 h) y no se pudo renovar: vuelvo a conectar.');
  }
  return (await flujoLogin(cfg, { perfilResuelto: perfil, reautorizar, tokenPegado: argVal('token') })).auth;
}

function cerrarSesion(cfg, perfil, forja, auth, forjaDetectada, override) {
  const mk = { ...marketplaceDe(perfil, override), override };
  auth.token = auth.token || tokenPara(perfil.host, cfg);
  cablearHelper(perfil.host, perfil.org || auth.login);
  try { retirarReescritura(mk.url); } catch {}   // limpieza, no se vuelve a escribir (ver cabecera)
  cfg.perfil_ultimo = perfil.id; saveConfig(cfg);
  return { auth, perfil, forja, forjaDetectada, mk };
}

// SESIÓN para cualquier flujo: busca una sesión que ya valga («Este es tu git») y solo pide conectar
// si no hay ninguna. Sin perfil fijado, la forja la decide la sesión hallada. Deja SIEMPRE el helper de
// git al día (idempotente, barato).
//
// `usarRemoto`: SOLO tiene sentido leer el remoto 'origin' de `dir` cuando `dir` ES la carpeta del
// repo sobre el que se va a operar (adoptar, check). En crear/abrir `dir` es donde
// CLONAR o el cwd de quien lanza el wizard — nada que ver con qué forja usar — y adivinar la forja de
// ahí era el bug real: ejecutar `faro` dentro de un clon de GitHub para CREAR un repo elegía GitHub en
// silencio, sin dejar nunca elegir GitLab.
// `remoto`: URL de un repo (traer una URL, destino de una migración): su forja decide la sesión.
async function flujoSesion(cfg, { dir = null, perfilFlag = null, soloForja = null, usarRemoto = true, remoto = null } = {}) {
  const forjaDetectada = remoto ? await forjaDeUrl(remoto, cfg) : usarRemoto ? await forjaDeCarpeta(dir, cfg) : detectarForja(null);
  const fijado = await perfilFijado(cfg, perfilFlag, forjaDetectada);
  const override = overrideMarketplace();
  if (DRY) {
    const perfil = fijado || await resolverPerfil({ cfg, soloForja });
    return { auth: { token: null, login: '(dry-run)' }, perfil, forja: await forjaDe(perfil), forjaDetectada, mk: { ...marketplaceDe(perfil, override), override } };
  }
  const reauth = argFlag('reautorizar') || argFlag('reauth');
  const halladas = reauth ? [] : await buscarSesiones({ cfg, remoto: forjaDetectada.host ? forjaDetectada : null });
  const sesiones = halladas.filter((x) => (fijado ? x.host === fijado.host.toLowerCase() : !soloForja || x.forja === soloForja));
  const s = await elegirSesion({ sesiones, ultimo: cfg.perfil_ultimo, interactivo: interactivo(), preguntar: (ops) => elige('¿Con qué cuenta trabajas?', ops) });
  if (s) ok(textoSesion(s));
  else if (!process.stdin.isTTY && !argVal('token')) throw new Error(mensajeSinSesion());
  if (!s && !fijado) {
    const r = await flujoLogin(cfg, { soloForja, reautorizar: reauth, tokenPegado: argVal('token') });
    return cerrarSesion(cfg, r.perfil, r.forja, r.auth, forjaDetectada, override);
  }
  const perfil = fijado || s.perfil;
  const forja = await forjaDe(perfil);
  let auth;
  if (perfil.forja === 'github') {
    if (reauth) { try { retirarReescritura(marketplaceDe(perfil, override).url); } catch {} }
    auth = await forja.login(perfil, cfg, { reautorizar: reauth, tokenInicial: s && { token: s.token, via: s.via } });
    await forja.validarTokenSesion(cfg, perfil, { destino: dir ? path.resolve(dir) : process.cwd() });
  } else {
    auth = await sesionGitlab(cfg, perfil, forja, s, reauth);
  }
  return cerrarSesion(cfg, perfil, forja, auth, forjaDetectada, override);
}

export { flujoLogin, flujoSesion, forjaDeCarpeta, forjaDeUrl, resumenLogin, remotoActual, overrideMarketplace, puedeLeer, uiDeviceFlow, interactivo };
