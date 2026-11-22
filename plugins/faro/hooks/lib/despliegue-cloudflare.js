'use strict';
// Adaptador Cloudflare del núcleo de despliegue: valida wrangler.jsonc/json (los entornos son las claves de `env`).
// FARO solo valida; el despliegue, los secretos y los entornos los configura devops en la forja.
const { parse } = require('./jsonc.js');

const FICHEROS = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];
const SECRETO = /(TOKEN|SECRET|PASSWORD|PRIVATE|API_KEY)/i;

const esObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const lista = (v) => (Array.isArray(v) ? v : []);
const unir = (dir, f) => (dir ? `${dir}/${f}` : f);

/**
 * Bindings de un bloque (nivel superior o env.<e>) como Map "tipo:nombre" -> { tipo, nombre, id }.
 * `id` es el identificador fijo de la cuenta (database_id, id de kv, bucket_name) o null.
 */
function bindings(bloque) {
  const out = new Map();
  if (!esObj(bloque)) return out;
  const poner = (tipo, nombre, id) => { if (typeof nombre === 'string' && nombre) out.set(`${tipo}:${nombre}`, { tipo, nombre, id: id || null }); };
  for (const x of lista(bloque.d1_databases)) if (esObj(x)) poner('d1', x.binding, x.database_id);
  for (const x of lista(bloque.kv_namespaces)) if (esObj(x)) poner('kv', x.binding, x.id);
  for (const x of lista(bloque.r2_buckets)) if (esObj(x)) poner('r2', x.binding, x.bucket_name);
  for (const x of lista(bloque.hyperdrive)) if (esObj(x)) poner('hyperdrive', x.binding, null);
  for (const x of lista(bloque.services)) if (esObj(x)) poner('services', x.binding, null);
  for (const x of lista(bloque.vectorize)) if (esObj(x)) poner('vectorize', x.binding, null);
  for (const x of lista(bloque.analytics_engine_datasets)) if (esObj(x)) poner('analytics', x.binding, null);
  if (esObj(bloque.queues)) for (const x of lista(bloque.queues.producers)) if (esObj(x)) poner('queues', x.binding, null);
  if (esObj(bloque.durable_objects)) for (const x of lista(bloque.durable_objects.bindings)) if (esObj(x)) poner('durable_objects', x.name, null);
  if (esObj(bloque.ai) && bloque.ai.binding) poner('ai', bloque.ai.binding, null);
  return out;
}

const entornosDe = (cfg) => (cfg && esObj(cfg.env) ? Object.keys(cfg.env).filter((e) => esObj(cfg.env[e])) : []);

/** Wrangler en la raíz o, en monorepo, en cada app. Devuelve { proyectos: [{ app, dir, fichero, cfg|null, toml }] } o null. */
function detectar(ctx) {
  const dirs = [{ app: null, dir: '' }];
  if (ctx.monorepo) for (const a of ctx.apps || []) dirs.push({ app: a.id, dir: a.dir });
  const proyectos = [];
  for (const d of dirs) {
    const f = FICHEROS.find((n) => ctx.existe(unir(d.dir, n)));
    if (!f) continue;
    const toml = f.endsWith('.toml');
    proyectos.push({ app: d.app, dir: d.dir, fichero: unir(d.dir, f), cfg: toml ? null : parse(ctx.leer(unir(d.dir, f))), toml });
  }
  return proyectos.length ? { proyectos } : null;
}

function gitignoraDevVars(ctx, dir) {
  const reglas = [...new Set([unir(dir, '.gitignore'), '.gitignore'])]
    .flatMap((f) => String(ctx.leer(f) || '').split(/\r?\n/).map((l) => l.trim().replace(/^\//, '')));
  return reglas.some((l) => ['.dev.vars', '.dev.vars*', '.dev.vars.*', '.dev*'].includes(l));
}

function diagnosticoProyecto(ctx, p) {
  const h = [];
  const aviso = (codigo, mensaje) => h.push({ nivel: 'aviso', codigo, mensaje: `${p.fichero}: ${mensaje}`, fichero: p.fichero });
  const error = (codigo, mensaje) => h.push({ nivel: 'error', codigo, mensaje: `${p.fichero}: ${mensaje}`, fichero: p.fichero });

  if (p.toml) { aviso('cf-toml', 'wrangler.toml no se valida; migra a wrangler.jsonc para que FARO revise bindings y entornos.'); return h; }
  const cfg = p.cfg;
  if (!esObj(cfg)) { error('cf-invalido', 'no se puede leer como JSONC válido; FARO no puede validar bindings ni entornos.'); return h; }

  const envs = entornosDe(cfg);
  const top = bindings(cfg);

  // Los bindings no se heredan: cada env debe redeclarar los de nivel superior.
  for (const e of envs) {
    const enEnv = bindings(cfg.env[e]);
    for (const [clave, b] of top) {
      if (!enEnv.has(clave)) error('cf-binding-falta-env', `el binding ${b.tipo} "${b.nombre}" no está redeclarado en env.${e} (los bindings no se heredan).`);
    }
  }

  // El mismo ID fijo en dos entornos apunta al mismo recurso.
  const vistos = new Map();
  for (const e of envs) {
    for (const b of bindings(cfg.env[e]).values()) {
      if (!b.id) continue;
      const k = `${b.tipo}:${b.id}`;
      if (vistos.has(k) && vistos.get(k) !== e) error('cf-id-repetido', `${b.tipo} "${b.id}" se usa en env.${vistos.get(k)} y env.${e}; cada entorno necesita su propio recurso.`);
      else vistos.set(k, e);
    }
  }

  if (!envs.length && [...top.values()].some((b) => b.id)) {
    aviso('cf-id-fijo-sin-env', 'hay bindings de nivel superior con ID fijo (database_id, id de kv o bucket_name) y no hay ningún bloque env. Los IDs cambian entre cuentas; conviene separarlos por entorno.');
  }

  // Hyperdrive sin cadena de conexión local.
  const vars = String(ctx.leer(unir(p.dir, '.dev.vars.example')) || '');
  const hd = new Set();
  for (const bl of [cfg, ...envs.map((e) => cfg.env[e])]) for (const x of lista(bl.hyperdrive)) if (esObj(x) && x.binding && !x.localConnectionString) hd.add(x.binding);
  for (const b of hd) {
    if (!vars.includes(`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${b}`)) aviso('cf-hyperdrive-local', `hyperdrive "${b}" sin localConnectionString (ni CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${b} en .dev.vars.example): el desarrollo local no podrá conectar.`);
  }

  // Secretos en vars (se versionan con el repo).
  const ambitos = [['global', cfg.vars], ...envs.map((e) => [`env.${e}`, cfg.env[e].vars])];
  for (const [donde, v] of ambitos) {
    if (!esObj(v)) continue;
    for (const k of Object.keys(v)) if (SECRETO.test(k)) error('cf-secreto-en-vars', `la clave "${k}" de vars (${donde}) parece un secreto; usa un secreto de la forja, no vars.`);
  }

  if (!cfg.compatibility_date) aviso('cf-sin-compat', 'falta compatibility_date.');

  if (ctx.existe(unir(p.dir, '.dev.vars')) && !gitignoraDevVars(ctx, p.dir)) error('cf-devvars-versionado', '.dev.vars existe y no está en .gitignore.');
  return h;
}

function diagnostico(ctx, det) {
  return det.proyectos.flatMap((p) => diagnosticoProyecto(ctx, p));
}

/** wrangler deploy --dry-run por entorno presente en `env` (o uno solo sin --env). */
function gates(ctx, det) {
  const out = [];
  for (const p of det.proyectos) {
    if (p.toml) continue;
    const sufApp = p.app ? `:${p.app}` : '';
    const cfgArgs = p.dir ? ['--config', p.fichero] : [];
    const envs = entornosDe(p.cfg); // cfg inválido (null) -> sin entornos: un dry-run que fallará con el error real
    for (const e of envs.length ? envs : [null]) {
      const args = ['wrangler', 'deploy', '--dry-run', ...cfgArgs, ...(e ? ['--env', e] : [])];
      out.push({ gate: `deploy-dry-run${sufApp}${e ? `:${e}` : ''}`, pasos: [['npx', args]], run: `npx ${args.join(' ')}` });
    }
  }
  return out;
}

function comandoLocal(ctx) {
  const nota = 'bindings locales con Miniflare; Hyperdrive usa localConnectionString';
  const pkg = parse(ctx.leer('package.json'));
  if (pkg && esObj(pkg.scripts) && pkg.scripts.dev) return { cmd: 'npm', args: ['run', 'dev'], nota };
  return { cmd: 'npx', args: ['wrangler', 'dev'], nota };
}

module.exports = { id: 'cloudflare', detectar, diagnostico, gates, comandoLocal };
