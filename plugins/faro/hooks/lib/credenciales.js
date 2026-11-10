// lib/credenciales.js — ALMACEN DE CREDENCIALES POR HOST (~/.faro.json > tokens[host]).
//
// Por que: el fichero guardaba UN 'token' y todo el motor asumia que era de GitHub. Una persona
// puede trabajar a la vez con github.com, gitlab.com y el GitLab autoalojado de un cliente: tres
// hosts, tres tokens, tres aplicaciones OAuth. Un solo concepto, un solo modulo: quien necesita
// credencial pregunta por HOST, no por forja.
//
// Forma:  tokens: { "github.com": { token, user, scopes, forja, actualizado },
//                   "gitlab.cliente.com": { token, refresh_token, expira, client_id, user, scopes, forja, actualizado } }
//
// RENOVACION: si una entrada trae 'refresh_token' y 'expira' (ms), tokenPara() renueva SOLO el token
// cuando esta caducado o a menos de 5 min de caducar (OAuth de GitLab: acceso de 2h, refresh
// rotatorio). Lo escribe el wizard del CLI y tambien 'harness.js auth'. Nadie tiene que volver a
// conectarse mientras el refresh siga vivo. La renovacion es SINCRONA (proceso hijo de node) porque
// tokenPara() lo llaman gates sincronos que no pueden esperar una promesa.
//
// COMPATIBILIDAD: el 'token' plano antiguo se migra a tokens["github.com"] al primer uso, sin que
// nadie tenga que reconectarse. Y se MANTIENE ESPEJADO mientras haya wizards antiguos que lean el
// campo plano; cuando todos lean tokens[host], se retira el espejo.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { leerJson, escribirJsonAtomico, fusionarConDisco, fusionarSubobjeto } = require('./json-seguro.js');

module.exports = function () {
  // RUTA DEL ALMACEN — UNA sola regla para todo el motor, resuelta EN CADA LLAMADA (no al crear la
  // fabrica: un modulo creado antes de cambiar el entorno escribia en la ruta antigua):
  //   1) FARO_CONFIG_PATH, si esta definida (pruebas, CI, perfiles alternativos);
  //   2) en contexto de test (NODE_TEST_CONTEXT, lo pone 'node --test') SIN override -> fichero
  //      temporal por proceso. La ruta real es INALCANZABLE desde un test: un test escribio fixtures
  //      en el ~/.faro.json del desarrollador y borro sus tokens reales (11 sep 2026);
  //   3) ~/.faro.json.
  const rutaCfg = () => {
    if (process.env.FARO_CONFIG_PATH) return process.env.FARO_CONFIG_PATH;
    if (process.env.NODE_TEST_CONTEXT) return path.join(os.tmpdir(), `faro-test-${process.pid}.json`);
    return path.join(os.homedir(), '.faro.json');
  };
  const CFG = rutaCfg();   // solo informativo (se exporta); los accesos usan rutaCfg()
  // Lectura cruda, sin marcas: la usa la propia fusion de escribir() para ver el estado en disco.
  const leerCrudo = () => leerJson(rutaCfg(), {});
  // Lectura para MODIFICAR. Deja constancia (no enumerable, no se serializa) de que tokens habia en
  // el momento de leer: asi escribir() distingue "este token no estaba cuando lei, no lo pises" de
  // "lo lei y lo quite a proposito". Sin esta marca, la fusion haria imposible borrar un token.
  const leer = () => {
    const j = leerCrudo();
    if (j && typeof j === 'object') {
      const marca = (k, v) => Object.defineProperty(j, k, { value: v, enumerable: false, writable: true, configurable: true });
      marca('_tokensLeidos', { ...(j.tokens || {}) });
      marca('_clavesLeidas', Object.fromEntries(Object.keys(j).map((k) => [k, true])));
    }
    return j;
  };
  // ESCRITURA SEGURA. El almacen es el UNICO estado global mutable del motor y lo escriben VARIOS
  // sitios con el patron leer -> modificar -> escribir: tokens, cache de rol, resumen de la forja,
  // identidad, agregado de ramas. Entre la lectura y la escritura pueden pasar SEGUNDOS (el refresco
  // en background invoca 'ramas.js --json': 6,6s medidos). Eso rompia de dos formas distintas:
  //
  //   1) PERDIDA POR COPIA OBSOLETA (reproducida, y la grave): quien escribia volcaba el objeto que
  //      leyo hace segundos, pisando lo que otro proceso hubiera guardado mientras tanto. Si el
  //      usuario se autenticaba en esa ventana, su token DESAPARECIA — y el sintoma ("me desconecta
  //      cada dos por tres") no se relaciona jamas con el resumen de ramas del arranque.
  //   2) FICHERO A MEDIAS: un writeFileSync interrumpido deja el JSON truncado y se pierde TODO,
  //      incluidos los tokens de todas las forjas.
  //
  // Se arregla lo primero FUSIONANDO en el ultimo instante (se relee justo antes de escribir) y lo
  // segundo escribiendo a temporal + rename, que es atomico en el mismo volumen.
  //
  // Criterio de la fusion: los TOKENS son lo irreemplazable —un resumen se recalcula solo, una
  // credencial hay que volver a pedirsela al usuario—, asi que los que existan en disco y no vengan
  // en lo que se escribe se CONSERVAN. Un borrado explicito sigue funcionando: se detecta porque el
  // que escribe leyo esa entrada y la quito a proposito (ver 'tokens' en el objeto entrante).
  const escribir = (j) => {
    const p = rutaCfg();
    // Dos fusiones con distinto alcance, y las dos hacen falta:
    //   - fusionarConDisco: las claves de primer nivel que otro proceso guardo (rol_cache,
    //     gh_resumen, resumen_agregado...). Sin esto, dos refrescos concurrentes se pisan entre si.
    //   - fusionarSubobjeto('tokens'): las CREDENCIALES, que viven dentro de una clave y son lo
    //     irreemplazable — un resumen se recalcula solo, un token hay que volver a pedirlo.
    const conocidas = j._clavesLeidas || null;
    const conocidosTokens = j._tokensLeidos || null;
    let salida = fusionarConDisco(p, j, conocidas);
    salida = fusionarSubobjeto(p, salida, 'tokens', conocidosTokens);
    delete salida._tokensLeidos;
    delete salida._clavesLeidas;
    escribirJsonAtomico(p, salida, 0o600);
  };

  // Migra el 'token' plano a tokens["github.com"] UNA vez. Idempotente.
  function cfgMigrada() {
    const j = leer();
    j.tokens = j.tokens || {};
    if (j.token && !(j.tokens['github.com'] && j.tokens['github.com'].token)) {
      j.tokens['github.com'] = { token: String(j.token), forja: 'github', scopes: j.token_scopes || null, user: j.user || null, actualizado: new Date().toISOString(), migrado: true };
      escribir(j);
    }
    return j;
  }

  // Variables de entorno por forja (override explicito, p. ej. en CI).
  function tokenDeEntorno(host) {
    const h = String(host || '').toLowerCase();
    if (/(^|\.)github\.com$/.test(h)) return (process.env.FARO_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '').trim() || null;
    // Token generico para un servidor propio (CI): SOLO para el host que nombra FARO_TOKEN_HOST. Sin
    // esa atadura, un remoto ajeno recibiria la credencial.
    const generico = (process.env.FARO_TOKEN || '').trim();
    if (generico && h && h === String(process.env.FARO_TOKEN_HOST || '').trim().toLowerCase()) return generico;
    if (/gitlab/.test(h)) return (process.env.FARO_GITLAB_TOKEN || process.env.GITLAB_TOKEN || '').trim() || null;
    return null;
  }

  // tokenPara(host) -> token o null. Cascada: entorno -> almacen -> (solo GitHub) CLI gh.
  function tokenPara(host) {
    const h = String(host || '').toLowerCase();
    const env = tokenDeEntorno(h); if (env) return env;
    const j = cfgMigrada();
    const e = j.tokens && j.tokens[h];
    if (e && e.token) {
      const renovado = renovarSiCaduca(h, e);
      return renovado === undefined ? String(e.token) : renovado;   // undefined = no tocaba renovar
    }
    if (/(^|\.)github\.com$/.test(h)) {
      try { const g = execFileSync('gh', ['auth', 'token'], { windowsHide: true, encoding: 'utf8', timeout: 6000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); if (g) return g; } catch {}
    }
    return null;
  }

  // Renueva el token OAuth si caduca: devuelve el token nuevo, null si esta caducado y no se pudo
  // renovar (mejor SIN_TOKEN honesto que un 401 criptico), o undefined si no tocaba renovar.
  const MARGEN_MS = 5 * 60 * 1000;
  const REINTENTO_MS = 10 * 60 * 1000;   // tras un fallo, no se vuelve a intentar hasta pasados 10 min
  function renovarSiCaduca(h, e) {
    if (!e.refresh_token || !e.expira) return undefined;
    const caducado = Date.now() >= Number(e.expira);
    if (!caducado && Date.now() < Number(e.expira) - MARGEN_MS) return undefined;
    // Sin reintento en bucle: tokenPara() lo llaman hooks en CADA prompt; si la renovacion fallo hace
    // un momento, repetirla en cada llamada seria un proceso hijo (hasta 10s) por prompt.
    if (e.renovacion_fallida && Date.now() - Number(e.renovacion_fallida) < REINTENTO_MS) return caducado ? null : undefined;
    const url = process.env.FARO_OAUTH_TOKEN_URL || `https://${h}/oauth/token`;   // override: pruebas / proxies
    const body = { client_id: e.client_id || '', refresh_token: e.refresh_token, grant_type: 'refresh_token' };
    if (e.client_secret) body.client_secret = e.client_secret;
    if (e.redirect_uri) body.redirect_uri = e.redirect_uri;
    // Proceso hijo: una peticion HTTP sincrona sin dependencias. Solo corre cuando toca renovar.
    // process.exit tras escribir: el pool keep-alive de fetch mantiene vivo el proceso y sin el la
    // llamada se quedaba colgada hasta el timeout (reproducido). El write con callback evita cortar
    // la salida en Windows, donde las tuberias son asincronas.
    const script = "const fin=s=>process.stdout.write(s,()=>process.exit(0));const b=new URLSearchParams(JSON.parse(process.argv[2]));fetch(process.argv[1],{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:b}).then(r=>r.json()).then(j=>fin(JSON.stringify(j))).catch(()=>fin('{}'))";
    let t = {};
    try {
      const out = execFileSync(process.execPath, ['-e', script, url, JSON.stringify(body)], { windowsHide: true, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
      t = JSON.parse(out || '{}');
    } catch { t = {}; }
    if (!t.access_token) { guardarToken(h, { renovacion_fallida: Date.now() }); return caducado ? null : undefined; }
    const expira = t.created_at && t.expires_in ? (Number(t.created_at) + Number(t.expires_in)) * 1000 : Date.now() + Number(t.expires_in || 7200) * 1000;
    guardarToken(h, { token: t.access_token, refresh_token: t.refresh_token || e.refresh_token, expira, renovado: new Date().toISOString(), renovacion_fallida: null });
    return String(t.access_token);
  }

  // guardarToken(host, {token, user, scopes, client_id, forja, refresh_token, expira}) -> entrada guardada.
  function guardarToken(host, datos) {
    const h = String(host || '').toLowerCase();
    const j = cfgMigrada();
    j.tokens = j.tokens || {};
    j.tokens[h] = { ...(j.tokens[h] || {}), ...datos, actualizado: new Date().toISOString() };
    delete j.tokens[h].migrado;
    // ESPEJO del campo plano para GitHub mientras el CLI lo lea (ver cabecera).
    if (/(^|\.)github\.com$/.test(h) && datos.token) { j.token = datos.token; if (datos.scopes) j.token_scopes = datos.scopes; }
    escribir(j);
    return j.tokens[h];
  }

  const entrada = (host) => { const j = cfgMigrada(); return (j.tokens && j.tokens[String(host || '').toLowerCase()]) || null; };
  const hosts = () => Object.keys(cfgMigrada().tokens || {});

  return { CFG, rutaCfg, leerCfg: leer, escribirCfg: escribir, tokenPara, guardarToken, entrada, hosts, cfgMigrada };
};
