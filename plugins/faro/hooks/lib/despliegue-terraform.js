'use strict';
// Adaptador Terraform/OpenTofu del núcleo de despliegue: valida la Terraform que encuentra (no la recomienda).
// Solo se activa si hay *.tf. Los gates no usan credenciales: init -backend=false + validate, fmt, tflint y checkov.
// El HCL se revisa con expresiones regulares; no hay parser.
const CF = require('./despliegue-cloudflare.js');

const CON_ESTADO = /^(cloudflare_d1_database|cloudflare_r2_bucket|cloudflare_workers_kv_namespace|aws_db_instance|aws_rds_cluster|aws_s3_bucket|aws_dynamodb_table|azurerm_\w*database\w*|azurerm_storage_account)$/;
const ES_TF = /\.tf$/;
const ES_ESTADO = /\.tfstate(\.backup)?$/;
const LOCK = '.terraform.lock.hcl';
const EXCLUIDOS = new Set(['.terraform', 'node_modules']);

const unir = (dir, f) => (dir ? `${dir}/${f}` : f);
const limpiaDir = (d) => (typeof d === 'string' ? d.trim().replace(/\\/g, '/').replace(/^\.\/?$/, '').replace(/^\.\//, '').replace(/\/+$/, '') : '');
const esObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Ficheros .tf directos de un directorio (relativos al repo). */
function tfDe(ctx, dir) {
  return (ctx.listar(dir) || []).filter((n) => ES_TF.test(n)).sort().map((n) => unir(dir, n));
}

function quitaComentarios(src) {
  return String(src || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(#|\/\/).*$/gm, '');
}

/** Cuerpo del bloque cuya llave de apertura acaba justo antes de `i`. */
function cuerpo(src, i) {
  let n = 1;
  let j = i;
  for (; j < src.length && n > 0; j++) {
    if (src[j] === '{') n++;
    else if (src[j] === '}') n--;
  }
  return src.slice(i, n === 0 ? j - 1 : j);
}

function* bloques(src, re) {
  const r = new RegExp(re.source, 'g');
  let m;
  while ((m = r.exec(src))) yield { m, cuerpo: cuerpo(src, r.lastIndex) };
}

/** { dir, ficheros, porEntorno, binario, entornos, unidades } o null si no hay *.tf. */
function detectar(ctx) {
  const cfg = (ctx.cfg && ctx.cfg.terraform) || {};
  const candidatos = [...new Set([cfg.dir ? limpiaDir(cfg.dir) : null, 'infra', ''].filter((d) => d !== null))];
  for (const dir of candidatos) {
    const propios = tfDe(ctx, dir);
    const entornos = (ctx.listar(unir(dir, 'envs')) || []).filter((e) => !EXCLUIDOS.has(e) && tfDe(ctx, unir(dir, `envs/${e}`)).length).sort();
    if (!propios.length && !entornos.length) continue;
    const unidades = [];
    if (propios.length) unidades.push({ dir, entorno: null, ficheros: propios });
    for (const e of entornos) unidades.push({ dir: unir(dir, `envs/${e}`), entorno: e, ficheros: tfDe(ctx, unir(dir, `envs/${e}`)) });
    const ficheros = unidades.flatMap((u) => u.ficheros);
    let porEntorno = null;
    if (entornos.length) porEntorno = 'carpetas';
    else if (ficheros.some((f) => /\bterraform\.workspace\b/.test(quitaComentarios(ctx.leer(f))))) porEntorno = 'workspaces';
    const b = ctx.cfg && ctx.cfg.terraform && ctx.cfg.terraform.binario;
    return { dir, ficheros, porEntorno, binario: b || 'terraform', entornos, unidades };
  }
  return null;
}

const hcl = (ctx, ficheros) => ficheros.map((f) => quitaComentarios(ctx.leer(f))).join('\n');

function cubreTerraformDir(ctx, dir) {
  const reglas = [...new Set([unir(dir, '.gitignore'), '.gitignore'])]
    .flatMap((f) => String(ctx.leer(f) || '').split(/\r?\n/).map((l) => l.trim().replace(/^\//, '').replace(/^\*\*\//, '')));
  const pref = dir ? `${dir}/` : null;
  return reglas.some((l) => {
    const r = pref && l.startsWith(pref) ? l.slice(pref.length) : l;
    return /^\.terraform(\/\*?)?$|^\.terraform\*$/.test(r);
  });
}

/** Nombres de recursos Cloudflare declarados en los wrangler del repo (reutiliza el adaptador de Cloudflare). */
function nombresWrangler(ctx) {
  const out = { d1: new Set(), kv: new Set(), r2: new Set() };
  let det = null;
  try { det = CF.detectar(ctx); } catch { det = null; }
  if (!det) return out;
  for (const p of det.proyectos) {
    if (!esObj(p.cfg)) continue;
    const bls = [p.cfg, ...(esObj(p.cfg.env) ? Object.values(p.cfg.env) : [])].filter(esObj);
    const add = (set, v) => { if (typeof v === 'string' && v) set.add(v); };
    for (const b of bls) {
      for (const x of Array.isArray(b.d1_databases) ? b.d1_databases : []) if (esObj(x)) add(out.d1, x.database_name);
      for (const x of Array.isArray(b.kv_namespaces) ? b.kv_namespaces : []) if (esObj(x)) { add(out.kv, x.binding); add(out.kv, x.title); }
      for (const x of Array.isArray(b.r2_buckets) ? b.r2_buckets : []) if (esObj(x)) add(out.r2, x.bucket_name);
    }
  }
  return out;
}

const TIPO_CF = { cloudflare_d1_database: ['d1', 'name'], cloudflare_workers_kv_namespace: ['kv', 'title'], cloudflare_r2_bucket: ['r2', 'name'] };

function diagnostico(ctx, det) {
  const h = [];
  const aviso = (codigo, mensaje, fichero) => h.push({ nivel: 'aviso', codigo, mensaje, ...(fichero ? { fichero } : {}) });
  const error = (codigo, mensaje, fichero) => h.push({ nivel: 'error', codigo, mensaje, ...(fichero ? { fichero } : {}) });
  const donde = (u) => u.dir || '.';
  const todo = hcl(ctx, det.ficheros);
  const unidadesBackend = det.porEntorno === 'carpetas' ? det.unidades : det.unidades.slice(0, 1);

  // Estado sin backend remoto: acabaría en la máquina de quien ejecuta.
  for (const u of unidadesBackend) {
    const src = hcl(ctx, u.ficheros);
    const remoto = [...bloques(src, /\bbackend\s+"([\w-]+)"\s*\{/)].some(({ m }) => m[1] !== 'local') || /\bcloud\s*\{/.test(src);
    if (!remoto) aviso('tf-backend-local', `${donde(u)}: sin bloque backend remoto (o es "local"); el estado acabaría en la máquina de quien ejecuta Terraform.`, donde(u));
  }

  for (const u of det.unidades) {
    if (!ctx.existe(unir(u.dir, LOCK))) error('tf-sin-lock', `${donde(u)}: falta ${LOCK}; sin él los providers no quedan fijados.`, unir(u.dir, LOCK));
  }

  if (!/\brequired_version\s*=/.test(todo)) aviso('tf-version-libre', 'falta required_version en el bloque terraform.');
  for (const { cuerpo: rp } of bloques(todo, /\brequired_providers\s*\{/)) {
    for (const { m, cuerpo: c } of bloques(rp, /([\w-]+)\s*=\s*\{/)) {
      if (!/\bversion\s*=/.test(c)) aviso('tf-version-libre', `el provider "${m[1]}" no tiene version.`);
    }
  }

  const dirs = [...new Set(['', det.dir, ...det.unidades.map((u) => u.dir)])];
  const estados = [...new Set(dirs.flatMap((d) => (ctx.listar(d) || []).filter((n) => ES_ESTADO.test(n)).map((n) => unir(d, n))))];
  for (const f of estados) error('tf-estado-versionado', `${f}: el estado de Terraform no debe estar en el repositorio (puede contener secretos).`, f);

  if (!cubreTerraformDir(ctx, det.dir)) aviso('tf-gitignore', '.gitignore no cubre .terraform/.', '.gitignore');

  for (const { m, cuerpo: c } of bloques(todo, /\bresource\s+"([\w-]+)"\s+"([\w-]+)"\s*\{/)) {
    if (CON_ESTADO.test(m[1]) && !/\bprevent_destroy\s*=\s*true\b/.test(c)) {
      aviso('tf-sin-prevent-destroy', `${m[1]}.${m[2]} guarda estado y no tiene lifecycle { prevent_destroy = true }.`);
    }
  }

  const enRaiz = tfDe(ctx, '').length > 0;
  if (enRaiz && !ctx.existe('infra') && !(ctx.listar('infra') || []).length) {
    aviso('tf-fuera-de-infra', 'hay archivos .tf en la raíz del repo; considera moverlos a infra/ para separarlos del código.');
  }

  const wr = nombresWrangler(ctx);
  for (const { m, cuerpo: c } of bloques(todo, /\bresource\s+"(cloudflare_d1_database|cloudflare_workers_kv_namespace|cloudflare_r2_bucket)"\s+"([\w-]+)"\s*\{/)) {
    const [clave, atributo] = TIPO_CF[m[1]];
    const n = new RegExp(`\\b${atributo}\\s*=\\s*"([^"$]+)"`).exec(c);
    if (n && wr[clave].has(n[1])) {
      aviso('tf-duplicado-wrangler', `${m[1]}.${m[2]} ("${n[1]}") también está declarado en un wrangler del repo. Wrangler ya aprovisiona ese recurso; tenerlo en los dos sitios provoca conflictos. Déjalo en uno solo.`);
    }
  }
  return h;
}

/** Gates sin credenciales: fmt, init -backend=false + validate (raíz y envs/<e>), y tflint/checkov si están en el PATH. */
function gates(ctx, det) {
  const bin = det.binario;
  const out = [];
  const chdir = (d) => (d ? [`-chdir=${d}`] : []);
  const gate = (nombre, pasos) => out.push({ gate: nombre, pasos, run: pasos.map(([c, a]) => `${c} ${a.join(' ')}`).join(' && ') });
  const enPath = (c) => (typeof ctx.enPath === 'function' ? !!ctx.enPath(c) : false);

  gate('tf-fmt', [[bin, [...chdir(det.dir), 'fmt', '-check', '-recursive']]]);
  for (const u of det.unidades) {
    gate(`tf-validate${u.entorno ? `:${u.entorno}` : ''}`, [
      [bin, [...chdir(u.dir), 'init', '-backend=false', '-input=false']],
      [bin, [...chdir(u.dir), 'validate']],
    ]);
  }
  if (enPath('tflint')) gate('tf-tflint', [['tflint', det.dir ? [`--chdir=${det.dir}`] : []]]);
  if (enPath('checkov')) gate('tf-checkov', [['checkov', ['-d', det.dir || '.', '--quiet']]]);
  return out;
}

function comandoLocal() { return null; }

module.exports = { id: 'terraform', detectar, diagnostico, gates, comandoLocal };
