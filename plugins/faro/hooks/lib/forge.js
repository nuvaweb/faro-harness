// lib/forge.js — FUENTE UNICA de "que forja hay detras de origin" (github | gitlab | desconocida).
//
// Por que existe: el harness inyectaba en CADA sesion una "REGLA DURA" que ordena usar
// `harness.js gh repos/<org>/<repo>/pulls` para cualquier operacion de plataforma, SIN mirar antes
// el remoto. En un repo de GitLab esa instruccion es imposible de cumplir (la ruta no existe, el
// token no sirve) y el agente entra en reintentos contra una API equivocada. El motor ya sabia
// distinguirlas en UN punto (lib/git.js consulta `glab` para el rol), pero ese saber no estaba
// centralizado ni llegaba al contexto que lee el agente.
//
// Contrato: detect(git) -> { forge, host, owner, project, path, remote, selfHosted }
//   forge   : 'github' | 'gitlab' | 'desconocida'
//   owner   : GitHub -> la org/usuario · GitLab -> el grupo RAIZ (primer segmento)
//   path    : ruta COMPLETA del proyecto sin el host ni el .git
//             GitHub  -> 'org/repo'                      (SIEMPRE 2 segmentos)
//             GitLab  -> 'grupo/subgrupo/back/api'       (subgrupos ANIDADOS, N segmentos)
//   project : ultimo segmento (el nombre del repo)
//
// La diferencia de arriba es la que rompe el parseo historico: la regex del motor captura dos
// segmentos ([:/]([^/]+)/([^/]+?)) y en GitLab con subgrupos se queda con los dos ULTIMOS, que no
// identifican el proyecto. Aqui se conserva la ruta entera; quien llame a la API de GitLab debera
// codificarla (encodeURIComponent) porque su API usa la ruta como id.
'use strict';

// Hosts autoalojados: no basta con 'github.com'/'gitlab.com'. Se reconoce por subdominio o por el
// nombre del producto dentro del host (gitlab.empresa.com, git.empresa.com/gitlab...). Si no hay
// senal, NO se adivina: 'desconocida' es una respuesta valida y honesta.
const RE_GITHUB = /(^|\.)github\.com$/i;
const RE_GITLAB = /(^|\.)gitlab\.com$/i;

function hostDe(remote) {
  const r = String(remote || '').trim();
  if (!r) return null;
  // url: proto://[user@]host[:puerto]/ruta — PRIMERO: 'ssh://git@host:2222/ruta' tambien encaja en
  // la forma scp y dejaria el puerto dentro de la ruta.
  const url = r.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
  if (url) return { host: url[1], rutaRaw: url[2] };
  // scp-like: git@host:ruta.git
  const scp = r.match(/^[^@\s/]+@([^:/]+):(.+)$/);
  if (scp) return { host: scp[1], rutaRaw: scp[2] };
  // ruta local o formato no reconocido
  return null;
}

function detect(git) {
  const remote = (typeof git === 'function' ? git('remote', 'get-url', 'origin') : git) || '';
  const vacio = { forge: 'desconocida', host: null, owner: null, project: null, path: null, remote: remote || null, selfHosted: false };
  const h = hostDe(remote);
  if (!h) return vacio;

  const host = h.host.toLowerCase();
  // Ruta limpia: sin barras sobrantes ni sufijo .git.
  const path = h.rutaRaw.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!path) return { ...vacio, host };

  const segs = path.split('/').filter(Boolean);
  if (segs.length < 2) return { ...vacio, host, path, project: segs[0] || null };

  let forge = 'desconocida';
  let selfHosted = false;
  const declarada = forjaDeclarada(git, host);
  if (declarada) { forge = declarada; selfHosted = !RE_GITHUB.test(host) && !RE_GITLAB.test(host); }
  else if (RE_GITHUB.test(host)) forge = 'github';
  else if (RE_GITLAB.test(host)) forge = 'gitlab';
  else if (/(^|[.-])gitlab([.-]|$)/i.test(host)) { forge = 'gitlab'; selfHosted = true; }
  else if (/(^|[.-])github([.-]|$)/i.test(host)) { forge = 'github'; selfHosted = true; }

  // GitHub es SIEMPRE owner/repo: si vinieran mas segmentos (no deberia), los dos ultimos mandan.
  const gh = forge === 'github' && segs.length > 2 ? segs.slice(-2) : segs;
  return {
    forge,
    host,
    selfHosted,
    owner: gh[0],                      // GitHub: la org · GitLab: el grupo RAIZ
    project: gh[gh.length - 1],
    path: gh.join('/'),                // GitLab: ruta completa con subgrupos (id de su API)
    remote,
    declarada: !!declarada,
  };
}

// FORJA DECLARADA: un servidor propio con nombre neutro (git.cliente.com) no se reconoce por el host.
// Se declara con git config y manda sobre la deteccion:
//   git config faro.forja gitlab                              (este repo)
//   git config --global faro.git.cliente.com.forja gitlab     (todo ese servidor)
// Solo con un git real (funcion): con una URL suelta no hay configuracion que leer.
const FORJAS = ['github', 'gitlab'];
function forjaDeclarada(git, host) {
  if (typeof git !== 'function') return null;
  for (const clave of [`faro.${host}.forja`, 'faro.forja']) {
    const v = String(git('config', '--get', clave) || '').trim().toLowerCase();
    if (FORJAS.includes(v)) return v;
  }
  return null;
}

// Que sabe hacer el harness HOY en cada forja. Lo comun lo cumple el contrato de lib/forge-contrato.js;
// aqui se declara ademas lo que UNA forja ofrece y la otra no, para decirlo en vez de fingirlo.
const SIEMPRE = { api: true, pr: true, rol: true, tareas: true, clave: true, equipo: true };
const CAPACIDADES = {
  github: { ...SIEMPRE, codeowners: true, tareasSync: true, camposTarea: true, repararTarea: true, tiempo: false, enlazar: false },
  gitlab: { ...SIEMPRE, codeowners: false, tareasSync: false, camposTarea: false, repararTarea: false, tiempo: true, enlazar: true },
  desconocida: { api: false, pr: false, rol: false, tareas: false, clave: false, equipo: false, codeowners: false, tareasSync: false, camposTarea: false, repararTarea: false, tiempo: false, enlazar: false },
};
const capacidades = (forge) => CAPACIDADES[forge] || CAPACIDADES.desconocida;
const nombreForja = (forge) => ({ github: 'GitHub', gitlab: 'GitLab' })[forge] || 'la forja';

// Por que esta forja no ofrece algo y que hacer en su lugar. Sin entrada, el llamador usa su aviso generico.
const SIN_CAPACIDAD = {
  github: {
    tiempo: ['tiempo: GitHub NO tiene estimacion ni horas consumidas por incidencia — no existe en la plataforma, ni en plan de pago.', '   Es nativo solo en GitLab. En GitHub, lo mas cercano es un campo numerico en un tablero de Projects, que hay que montar a mano y NO es seguimiento de tiempo.'],
    enlazar: ['enlazar: GitHub NO tiene enlaces de BLOQUEO entre tareas (solo referencias y cierre automatico con "Closes #N").', '   Es nativo solo en GitLab. Aqui, deja la dependencia escrita en el cuerpo de la tarea.'],
  },
  gitlab: {
    repararTarea: ['reparar-tarea: aun no esta disponible en GitLab. Completa la descripcion con harness.js issue <N> --cuerpo-fichero <ruta>.'],
    camposTarea: ['campos-tarea: usa los campos propios de issue de GitHub. En GitLab, fecha, peso y estimacion van con harness.js asignar-tarea y harness.js tiempo.'],
    tareasSync: ['tarea migrar y tarea sync: aun no estan disponibles en GitLab. El gobierno local sigue funcionando.'],
  },
};
const sinCapacidad = (forge, que) => (SIN_CAPACIDAD[forge] && SIN_CAPACIDAD[forge][que]) || null;

// Linea de REGLA DE PLATAFORMA para el contexto de sesion, ADAPTADA a la forja real.
// En GitHub conserva la regla vigente; en GitLab dice la verdad (que no esta implementado) en vez
// de mandar al agente a una API que no existe; en desconocida, no afirma nada.
function reglaPlataforma(f) {
  if (f.forge === 'github') {
    return 'GITHUB / API (REGLA DURA — vale te pidan "/faro:pr" o solo "hazme/abre un PR" en lenguaje llano): para CUALQUIER operacion con la API de GitHub ' +
      '(abrir/ver/validar PRs, rol, comentarios) usa SIEMPRE los comandos por intencion (`harness.js pr`, `harness.js issue <N>`, `harness.js comentar <N> "…"`) o `node .claude/hooks/harness.js gh <ruta> [METODO] [json]`, que YA llevan el TOKEN DEL HARNESS (~/.faro.json). ' +
      'Abrir un PR = una llamada API: `node .claude/hooks/harness.js gh repos/<org>/<repo>/pulls POST \'{"title":"..","head":"<rama>","base":"develop","body":".."}\'`. ' +
      'NUNCA uses el CLI `gh` ni lo pidas instalar, NUNCA busques el token en env/git-config, y NUNCA te rindas con "gh no instalado" ni caigas a push+enlace: `gh` NO hace falta. ' +
      'Si `harness.js gh` responde SIN_TOKEN, la UNICA accion correcta es `node .claude/hooks/harness.js auth` (device-flow, codigo de 6 digitos) y reintentar.';
  }
  if (f.forge === 'gitlab') {
    return `PLATAFORMA = GITLAB (${f.host}${f.selfHosted ? ', autoalojado' : ''}) · proyecto '${f.path}' (REGLA DURA): para CUALQUIER operacion de plataforma usa los comandos por INTENCION del harness, ` +
      'que ya llevan la credencial de ESTE host (~/.faro.json > tokens): `harness.js role` (tu nivel de acceso) · `harness.js pr [rama-destino]` (peticiones abiertas) · ' +
      '`harness.js pr crear --base <destino> --titulo "…"` (abrir peticion) · `harness.js issue <N>` (leer o editar una tarea) · `harness.js comentar <N> "…"` · `harness.js mis-tareas` · `harness.js asignar-tarea "<titulo>" <usuario> [<slug>] --tipo <tipo>` · `harness.js equipo` · `harness.js approvers` (quien aprueba DE VERDAD: solo miembros directos) · `harness.js clave` · ' +
      '`harness.js proteger [rama]` · `harness.js ci` (genera el pipeline desde tus gates) · `harness.js exigir-pipeline` (sin el, el pipeline solo informa) · `harness.js renombrar "<Nombre>"` · `harness.js hito [sync]` (fase = hito) · `harness.js tiempo <tarea> <2h>` (horas nativas) · `harness.js enlazar <t> bloquea <t2>`. ' +
      'NUNCA uses el CLI `glab` ni `curl` a la API, ni pidas pegar un token en el chat. Si un comando responde SIN_TOKEN, la UNICA accion correcta es `node .claude/hooks/harness.js auth` ' +
      '(login por codigo de 6 digitos si la instancia tiene aplicacion registrada; si no, el propio comando explica como usar un token personal) y reintentar. ' +
      'Una "Tarea" es una "incidencia" y una "peticion de integracion" es un "merge request". En GitLab el proyecto se identifica por su RUTA COMPLETA con subgrupos.';
  }
  return 'PLATAFORMA NO RECONOCIDA' + (f.host ? ` (host '${f.host}')` : ' (sin remoto origin)') + ': el harness no puede operar la API de ninguna forja aqui. ' +
    'Todo el gobierno LOCAL (validate, specs, rama, ramas, atomico) funciona igual porque es git puro. ' +
    'NO invoques `harness.js gh`, `pr`, `role` ni `mis-tareas`: son de la API de GitHub y fallarian. Guia al usuario por su interfaz web para abrir peticiones de integracion.';
}

// CLI: harness.js forge — diagnostico y punto de consulta para las skills (que no supongan la forja).
function cmdForge(git) {
  const f = detect(git);
  const c = capacidades(f.forge);
  const out = [
    `Forja: ${f.forge}${f.selfHosted ? ' (autoalojada)' : ''}`,
    `Host: ${f.host || '(sin remoto origin)'}`,
    `Proyecto: ${f.path || '(desconocido)'}${f.forge === 'gitlab' && f.path && f.path.split('/').length > 2 ? '  ← ruta con subgrupos: la API de GitLab la usa CODIFICADA como id' : ''}`,
    `Propietario: ${f.owner || '(desconocido)'}`,
    '',
    'Soportado por el harness en esta forja:',
    `  API de plataforma : ${c.api ? 'si' : 'NO'}`,
    `  Peticiones (PR/MR): ${c.pr ? 'si' : 'NO'}`,
    `  Rol del usuario   : ${c.rol === 'parcial' ? 'parcial (via CLI glab, si esta instalada)' : c.rol ? 'si' : 'NO'}`,
    `  Tareas (issues)   : ${c.tareas ? 'si' : 'NO'}`,
    `  Clave de proyecto : ${c.clave ? 'si' : 'NO'}`,
    `  Horas por tarea   : ${c.tiempo ? 'si' : 'NO'}`,
    `  Enlaces de bloqueo: ${c.enlazar ? 'si' : 'NO'}`,
    `  Reparar tareas    : ${c.repararTarea ? 'si' : 'NO'}`,
    `  Sincronizar tareas: ${c.tareasSync ? 'si' : 'NO'}`,
  ];
  if (f.forge === 'desconocida' && f.host) {
    out.push('', `Si '${f.host}' es un GitLab o un GitHub propio, declaralo:`,
      '  git config faro.forja gitlab                         (solo este repo; o github)',
      `  git config --global faro.${f.host}.forja gitlab     (todos los repos de ese servidor)`,
      `y conectate con  harness.js auth  (en CI: FARO_TOKEN con FARO_TOKEN_HOST=${f.host}).`);
  }
  if (f.forge !== 'github') out.push('', 'El gobierno LOCAL (validate, specs, rama, ramas, atomico) funciona igual: es git puro.');
  process.stdout.write(out.join('\n') + '\n');
}

// MARKETPLACE del plugin: de donde instala Claude Code el plugin en un repo de trabajo. UN SOLO origen
// publico para todas las forjas (el mismo que usa el wizard, cli/bin/lib/perfil.mjs): un repo de GitLab
// o de un servidor propio instala igual desde el repo publico. Un espejo propio se declara con
// 'git config faro.marketplaceUrl' y manda sobre este defecto: el motor no se toca.
const ORIGEN_PUBLICO = { source: 'github', repo: 'nuvaweb/faro-harness' };
const MARKETPLACES = { github: ORIGEN_PUBLICO, gitlab: ORIGEN_PUBLICO };
function marketplacePara(forja, git) {
  const cfg = (typeof git === 'function' && (git('config', 'faro.marketplaceUrl') || '').trim()) || '';
  if (cfg) return { source: 'git', url: cfg };
  return MARKETPLACES[forja] || MARKETPLACES.github;   // forja desconocida: la principal
}
// Bloque EXACTO de settings.json para ese marketplace (lo que el arranque recomienda pegar).
function bloqueSettings(mk) {
  const src = mk.source === 'github' ? { source: 'github', repo: mk.repo } : { source: 'git', url: mk.url };
  return JSON.stringify({ extraKnownMarketplaces: { 'faro-marketplace': { source: src, autoUpdate: true } }, enabledPlugins: { 'faro@faro-marketplace': true } });
}
// Claude Code clona con 'git' y 'github'; 'url' es solo un enlace directo a un marketplace.json.
const fuenteMarketplaceValida = (src) => !!src && (src.source === 'git' || src.source === 'github' || (src.source === 'url' && !/\.git\/?$/.test(String(src.url || ''))));
// Diagnostico de descarga para cuando a alguien le falle instalar: la URL git que debe poder listar.
function diagnosticoDescarga(mk) {
  return mk.source === 'github' ? `git ls-remote https://github.com/${mk.repo}.git` : `git ls-remote ${mk.url}`;
}

module.exports = { detect, capacidades, nombreForja, sinCapacidad, fuenteMarketplaceValida, reglaPlataforma, cmdForge, hostDe, MARKETPLACES, marketplacePara, bloqueSettings, diagnosticoDescarga };
