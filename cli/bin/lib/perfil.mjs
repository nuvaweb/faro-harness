// perfil.mjs — PERFIL FARO: una forja y su app OAuth. No lleva organización: el destino (cuenta
// personal, organización o grupo) se decide en cada ejecución.
//
// Embebidos: GitHub y GitLab. Fuentes adicionales, en orden de precedencia creciente: catalog.json
// (perfiles[]) y ~/.faro.json (perfiles[]): un perfil con el mismo id se FUNDE sobre el embebido y
// puede fijar una organización o un host propio.
// El client_id de una app OAuth es PUBLICO (no es un secreto): puede ir en el código.

// Único origen del plugin en todo el wizard: el repo público. 'git config faro.marketplaceUrl' lo
// sustituye (espejo propio); ver marketplaceDe.
const REPO_PLUGIN = 'nuvaweb/faro-harness';
const ORIGEN_PLUGIN = `https://github.com/${REPO_PLUGIN}.git`;
const pluginPublico = { marketplace: 'faro-marketplace', source: { source: 'github', repo: REPO_PLUGIN }, url: ORIGEN_PLUGIN };

const PERFILES = {
  github: {
    id: 'github', forja: 'github', host: 'github.com', org: null,
    client_id: null,   // OAuth App de FARO (device flow); sin ella: FARO_CLIENT_ID o token pegado
    scopes: ['repo', 'read:org', 'workflow', 'user:email'],
    plugin: pluginPublico,
    etiqueta: 'GitHub',
  },
  gitlab: {
    id: 'gitlab', forja: 'gitlab', host: 'gitlab.com', org: null,
    client_id: null,   // sin app OAuth embebida: token personal pegado (scope api); una app propia se declara en ~/.faro.json > perfiles
    scopes: ['api'],
    plugin: pluginPublico,
    etiqueta: 'GitLab',
  },
};
// superpowers se declara desde el marketplace OFICIAL de Anthropic (decision 2026-08-03).
const OFICIAL = { source: { source: 'github', repo: 'anthropics/claude-plugins-official' } };

function perfilesConocidos(cfg, catalogo) {
  const m = new Map(Object.entries(PERFILES).map(([k, v]) => [k, { ...v }]));
  for (const lista of [(catalogo && catalogo.perfiles) || [], (cfg && cfg.perfiles) || []]) {
    for (const p of Array.isArray(lista) ? lista : []) { if (p && p.id) { const { id } = p; m.set(id, { ...(m.get(id) || {}), ...p, id }); } }
  }
  return [...m.values()];
}

const low = (s) => String(s || '').toLowerCase();

// Perfil que corresponde a una forja detectada (detectarForja del remoto). EXACTO: mismo host y el
// perfil declara una org de la que cuelga el remoto. DERIVADO: casa el host, o es un servidor propio
// DECLARADO (git config faro.forja / faro.<host>.forja, o confirmado al preguntar) -> se usa la base de
// esa forja con el host y la org del remoto. Un servidor propio no puede usar la app OAuth del host
// público: queda sin client_id y conecta con token. Sin declaración no se deriva nada: null.
function perfilDeForja(f, perfiles) {
  if (!f || !f.host) return null;
  const orgDe = (p) => (p.forja === 'gitlab'
    ? (low(f.path).startsWith(low(p.org) + '/') || low(f.path) === low(p.org))
    : low(f.owner) === low(p.org));
  const exacto = perfiles.find((p) => p.org && low(p.host) === low(f.host) && orgDe(p));
  if (exacto) return { perfil: exacto, derivado: false };
  const derivar = (base, extra = {}) => ({ perfil: { ...base, id: `${base.id}@${f.owner}`, org: f.owner, etiqueta: `${base.etiqueta || base.forja} · ${f.owner}`, derivado: true, ...extra }, derivado: true });
  const mismoHost = perfiles.find((p) => low(p.host) === low(f.host));
  if (mismoHost) return derivar(mismoHost);
  const base = f.selfHosted && f.declarada && perfiles.find((p) => p.forja === f.forja);
  return base ? derivar(base, { host: f.host, client_id: null }) : null;
}

// Resolucion: --perfil (error si no existe) > forja del remoto > unico candidato > elegir(). Al
// CREAR no hay remoto: se pregunta solo si hay mas de un candidato, con el ULTIMO usado primero
// (cfg.perfil_ultimo). `soloForja` acota los candidatos (flag --forja=github|gitlab).
async function resolverPerfil({ flag = null, forja = null, cfg = {}, catalogo = null, elegir = null, soloForja = null } = {}) {
  let perfiles = perfilesConocidos(cfg, catalogo);
  if (flag) {
    const p = perfiles.find((x) => x.id === flag);
    if (!p) throw new Error(`Perfil '${flag}' desconocido. Conocidos: ${perfiles.map((x) => x.id).join(', ')}`);
    return p;
  }
  const porForja = perfilDeForja(forja, perfiles);
  if (porForja) return porForja.perfil;
  if (soloForja) perfiles = perfiles.filter((p) => p.forja === soloForja);
  if (!perfiles.length) throw new Error(`No hay ningún perfil para la forja '${soloForja}'.`);
  if (perfiles.length === 1) return perfiles[0];
  const ultimo = cfg && cfg.perfil_ultimo;
  if (ultimo && perfiles.some((p) => p.id === ultimo)) perfiles = [perfiles.find((p) => p.id === ultimo), ...perfiles.filter((p) => p.id !== ultimo)];
  if (!elegir) return perfiles[0];
  const ops = Object.fromEntries(perfiles.map((p) => [p.id, { etiqueta: p.etiqueta || p.id, explica: [p.host, p.org].filter(Boolean).join(' · ') }]));
  const id = await elegir(ops);
  return perfiles.find((p) => p.id === id) || perfiles[0];
}

// Marketplace del plugin: 'git config faro.marketplaceUrl' (override, misma clave que el plugin) manda.
function marketplaceDe(perfil, override) {
  const o = String(override || '').trim();
  if (o) return { source: { source: 'git', url: o }, url: o };
  return { source: perfil.plugin.source, url: perfil.plugin.url };
}

// Bloque de DISTRIBUCION del plugin para .claude/settings.json del repo (viaja con el clon).
function bloqueSettings(perfil, override) {
  const mk = marketplaceDe(perfil, override);
  const nombre = (perfil.plugin && perfil.plugin.marketplace) || 'faro-marketplace';
  return {
    extraKnownMarketplaces: { [nombre]: { source: mk.source, autoUpdate: true }, 'claude-plugins-official': OFICIAL },
    enabledPlugins: { [`faro@${nombre}`]: true, 'superpowers@claude-plugins-official': true },
  };
}

export { PERFILES, ORIGEN_PLUGIN, perfilesConocidos, perfilDeForja, resolverPerfil, marketplaceDe, bloqueSettings };
