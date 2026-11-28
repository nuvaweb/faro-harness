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
import { C, ok, warn, say, caja, saveConfig, elige, pregunta, DRY, YES, argFlag, argVal } from '../lib/core.mjs';
import { resolverPerfil, marketplaceDe, perfilesConocidos, perfilDeForja } from '../lib/perfil.mjs';
import { detectarForja } from '../lib/forja.mjs';
import { forjaDeRemoto, declararForja, leerForjaDeclarada, opcionesForja, FORJAS } from '../lib/forja-propia.mjs';
import { hostPublico } from '../lib/credenciales.mjs';
import { forjaDe } from '../lib/forjas/index.mjs';
import { cablearHelper, retirarReescritura, overrideMarketplace } from '../lib/gitcred.mjs';
import { tokenPara, entrada, entradaPara, guardarToken, guardarOrgs } from '../lib/credenciales.mjs';
import { cuentaSsh } from '../lib/repo.mjs';
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
  if (Array.isArray(ch.orgs)) {
    const que = perfil.forja === 'gitlab' ? 'Grupos' : 'Organizaciones';
    const vistas = ch.orgs.slice(0, 8).join(', ') + (ch.orgs.length > 8 ? ` y ${ch.orgs.length - 8} más` : '');
    out.push(ch.orgs.length ? `${que}: ${vistas}` : `${que}: ninguna (trabajarás en tu cuenta personal)`);
  }
  // SSH: solo informa (nunca bloquea). Git va por SSH solo si la clave es de la cuenta de la sesión.
  if ('sshLogin' in ch) {
    const ssh = ch.sshLogin ? String(ch.sshLogin).toLowerCase() : null;
    if (ssh && ssh === String(auth.login || '').toLowerCase()) out.push(`SSH: tu clave es de @${ssh}; git puede ir por SSH.`);
    else if (ssh) out.push(`${C.d}SSH: tu clave es de @${ssh}, no de @${auth.login}: con esta cuenta git irá por HTTPS con tu sesión (sin pedirte nada).${C.x}`);
    else out.push(`${C.d}SSH: no hay clave válida para ${perfil.host}; git irá por HTTPS con tu sesión (sin pedirte nada).${C.x}`);
  }
  if (ch.expira && !ch.renovable) out.push(`${C.d}Los tokens de ${nombreForja(perfil.forja)} caducan a las 2 h: vuelve a ejecutar faro --login cuando expire.${C.x}`);
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

const limpiarHost = (h) => String(h || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();

// Sin perfil dado: se pregunta SOLO DÓNDE está el código (GitHub, GitLab o una forja propia). No se
// pregunta la organización (se leen de la API tras autorizar) ni se pide pegar ningún token: la
// autorización es siempre en el navegador (device flow). Una forja propia queda declarada en
// git config faro.<host>.forja (forja-propia.mjs). Sin nadie a quien preguntar, el perfil de siempre.
async function conexionNueva(cfg, soloForja, {
  elegir = interactivo() ? (q, ops) => elige(q, ops) : null,
  preguntar = (q, def) => pregunta(q, def),
  leerDeclarada = (host) => leerForjaDeclarada(host),
  declarar = (host, forja) => declararForja(host, forja),
} = {}) {
  if (!elegir) return resolverPerfil({ cfg, soloForja });
  const ops = {
    github: { etiqueta: 'GitHub', explica: 'github.com' },
    gitlab: { etiqueta: 'GitLab', explica: 'gitlab.com' },
    propia: { etiqueta: 'Una forja propia', explica: 'GitHub Enterprise o GitLab en tu propio servidor.' },
  };
  if (soloForja) delete ops[soloForja === 'github' ? 'gitlab' : 'github'];
  const donde = await elegir('¿Dónde está tu código?', ops);
  if (donde !== 'propia') return resolverPerfil({ flag: donde, cfg });
  const host = limpiarHost(await preguntar('Dirección del servidor (sin https://)', ''));
  if (!host) throw new Error('Sin dirección del servidor no hay a dónde conectar.');
  const conocido = perfilesConocidos(cfg).find((p) => String(p.host).toLowerCase() === host);
  if (conocido) return conocido;
  if (hostPublico(host)) return resolverPerfil({ flag: host.startsWith('gitlab') ? 'gitlab' : 'github', cfg });
  let forja = soloForja || leerDeclarada(host);
  if (!forja) forja = await elegir(`¿Qué forja es ${host}?`, opcionesForja(host));
  if (!FORJAS.includes(forja)) throw new Error(`Sin saber qué forja es ${host} no se conecta (no se manda un token a ciegas).`);
  try { declarar(host, forja); } catch {}
  return perfilDeHost(host, forja, null, entrada(host, cfg));
}

// Organizaciones (GitHub) o grupos raíz (GitLab) de la cuenta, leídos por API y guardados en
// tokens[host].cuentas[login] = { ..., orgs, orgs_ts } (misma forma que el plugin). Ninguna org fija:
// es lo que permite elegir después la cuenta por la org del repo. null si no se pudieron leer.
async function registrarOrgs(cfg, perfil, forja, auth, { fetchImpl = fetch, guardar = saveConfig } = {}) {
  if (!auth || !auth.token || !auth.login) return null;
  const orgs = perfil.forja === 'gitlab'
    ? await forja.gruposDe(perfil.host, auth.token, { fetchImpl })
    : await forja.orgsDe(auth.token, perfil.host, { fetchImpl });
  if (!Array.isArray(orgs)) return null;
  if (guardarOrgs(perfil.host, cfg, auth.login, orgs)) { try { guardar(cfg); } catch {} }
  return orgs;
}

// CONECTAR. `nueva`: `faro --login` explícito autoriza siempre en el navegador (así se añade otra
// cuenta de la misma forja); desde un flujo, se reutiliza la sesión que valga. `owner`: org del repo.
async function flujoLogin(cfg, { perfilFlag = null, soloForja = null, forjaDetectada = null, reautorizar = false, tokenPegado = null, perfilResuelto = null, nueva = false, owner = null, ssh = cuentaSsh } = {}) {
  const fijado = perfilResuelto || await perfilFijado(cfg, perfilFlag, forjaDetectada);
  const perfil = fijado || await conexionNueva(cfg, soloForja);
  const forja = await forjaDe(perfil);
  const mk = marketplaceDe(perfil, overrideMarketplace());
  if (DRY) { ok(`(dry-run) Conectaría con ${nombreForja(perfil.forja)} · ${perfil.host} (perfil ${perfil.id}); marketplace ${mk.url}.`); return { auth: { login: '(dry-run)' }, perfil, forja }; }
  if (reautorizar) { try { retirarReescritura(mk.url); } catch {} }
  // --token: solo para CI/automatización (explícito). Nunca se pide pegar uno.
  const pegado = tokenPegado;
  const auth = perfil.forja === 'github'
    ? await forja.login(perfil, cfg, { reautorizar, owner, nueva: nueva && !pegado, tokenInicial: pegado ? { token: pegado, via: 'token de --token' } : null })
    : await forja.login(perfil, cfg, { tokenPegado: pegado, ui: uiDeviceFlow });
  cfg.perfil_ultimo = perfil.id;
  saveConfig(cfg);
  const orgs = await registrarOrgs(cfg, perfil, forja, auth);
  // Credenciales de git: helper acotado a host/destino (clonar/push sin modal, token fresco en cada
  // operación) para la cuenta y cada org detectada; con varias cuentas el helper elige la de la org.
  // Se retira cualquier reescritura insteadOf que quedara de una versión anterior del wizard (ver
  // cabecera): esa vía queda como limpieza, nunca se vuelve a escribir aquí.
  for (const o of new Set([perfil.org || auth.login, ...(orgs || [])].filter(Boolean))) cablearHelper(perfil.host, o);
  try { retirarReescritura(mk.url); } catch {}
  const ch = { reescritura: false, orgs };
  if (perfil.forja === 'github') {
    const v = await forja.validarTokenSesion(cfg, perfil, { silencioSiOk: true });
    ch.scopesOk = v.ok; ch.faltan = v.faltan;
  } else {
    const en = entradaPara(perfil.host, cfg, auth.login) || {};
    const sc = en.scopes || [];
    ch.scopesOk = sc.includes('api'); ch.faltan = ch.scopesOk ? [] : ['api'];
    ch.expira = !!en.expira; ch.renovable = !!en.refresh_token;
  }
  ch.marketplace = puedeLeer(mk.url);
  try { ch.sshLogin = ssh(perfil.host); } catch { ch.sshLogin = null; }   // informativo: nunca bloquea
  caja(resumenLogin(auth, perfil, ch), { titulo: 'Sesión', color: C.c });
  return { auth, perfil, forja, checks: ch };
}

const authDe = (s) => ({ token: s.token, login: s.login, id: s.id, name: s.name, email: s.email, email_contacto: s.email, via: s.via });

// GitLab: una sesión de fuera se guarda con el login; la guardada se usa, renovándola sin navegador si
// ha caducado. Sin sesión, o si no se pudo renovar, se conecta.
async function sesionGitlab(cfg, perfil, forja, s, reautorizar, owner = null) {
  if (s && s.via !== 'sesión guardada') return { ...await forja.login(perfil, cfg, { tokenPegado: s.token, ui: uiDeviceFlow }), via: s.via };
  if (s && !s.renovable) return authDe(s);
  if (s) {
    // La cuenta de la org (varias cuentas en el host); la renovación lleva su user para no mezclarlas.
    const en = entradaPara(perfil.host, cfg, owner) || {};
    const nv = await forja.renovar(perfil.host, en.client_id, en.refresh_token);
    if (nv) {
      guardarToken(perfil.host, { token: nv.token, refresh_token: nv.refresh_token, expira: nv.expira, forja: 'gitlab', ...(en.user ? { user: en.user } : {}) }, cfg); saveConfig(cfg);
      ok('Sesión de GitLab renovada (sin pasar por el navegador).');
      return { ...authDe(s), token: nv.token };
    }
    warn('La sesión de GitLab ha caducado (los tokens duran 2 h) y no se pudo renovar: vuelvo a conectar.');
  }
  return (await flujoLogin(cfg, { perfilResuelto: perfil, reautorizar, tokenPegado: argVal('token'), owner })).auth;
}

function cerrarSesion(cfg, perfil, forja, auth, forjaDetectada, override, owner = null) {
  const mk = { ...marketplaceDe(perfil, override), override };
  auth.token = auth.token || tokenPara(perfil.host, cfg, { owner: perfil.org || owner });
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
  // La org del repo decide la cuenta cuando hay varias en la misma forja: perfil > --org > remoto.
  const owner = (fijado && fijado.org) || argVal('org') || forjaDetectada.owner || null;
  const halladas = reauth ? [] : await buscarSesiones({ cfg, remoto: forjaDetectada.host ? forjaDetectada : null, owner });
  const sesiones = halladas.filter((x) => (fijado ? x.host === fijado.host.toLowerCase() : !soloForja || x.forja === soloForja));
  const s = await elegirSesion({ sesiones, ultimo: cfg.perfil_ultimo, interactivo: interactivo(), preguntar: (ops) => elige('¿Con qué cuenta trabajas?', ops) });
  if (s) ok(textoSesion(s));
  else if (!process.stdin.isTTY && !argVal('token')) throw new Error(mensajeSinSesion());
  if (!s && !fijado) {
    const r = await flujoLogin(cfg, { soloForja, reautorizar: reauth, tokenPegado: argVal('token'), owner });
    return cerrarSesion(cfg, r.perfil, r.forja, r.auth, forjaDetectada, override, owner);
  }
  const perfil = fijado || s.perfil;
  const forja = await forjaDe(perfil);
  let auth;
  if (perfil.forja === 'github') {
    if (reauth) { try { retirarReescritura(marketplaceDe(perfil, override).url); } catch {} }
    auth = await forja.login(perfil, cfg, { reautorizar: reauth, owner, tokenInicial: s && { token: s.token, via: s.via } });
    await forja.validarTokenSesion(cfg, perfil, { destino: dir ? path.resolve(dir) : process.cwd() });
  } else {
    auth = await sesionGitlab(cfg, perfil, forja, s, reauth, perfil.org || owner);
  }
  return cerrarSesion(cfg, perfil, forja, auth, forjaDetectada, override, owner);
}

export { flujoLogin, flujoSesion, conexionNueva, registrarOrgs, forjaDeCarpeta, forjaDeUrl, resumenLogin, remotoActual, overrideMarketplace, puedeLeer, uiDeviceFlow, interactivo };
