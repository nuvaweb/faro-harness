// Adaptador Terraform/OpenTofu: valida la Terraform que encuentra; sin credenciales en los gates.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const TF = require(path.join(RAIZ, 'plugins/faro/hooks/lib/despliegue-terraform.js'));
const D = require(path.join(RAIZ, 'plugins/faro/hooks/lib/despliegue.js'));

const ctx = (ficheros, extra = {}) => {
  const claves = Object.keys(ficheros);
  return {
    root: '/x', monorepo: false, apps: [], cfg: D.config({}),
    leer: (r) => (r in ficheros ? ficheros[r] : null),
    existe: (r) => r in ficheros || claves.some((k) => k.startsWith(`${r}/`)),
    listar: (d) => {
      const pref = d ? `${d}/` : '';
      return [...new Set(claves.filter((k) => k.startsWith(pref)).map((k) => k.slice(pref.length).split('/')[0]))];
    },
    enPath: () => false,
    ...extra,
  };
};
const hallazgos = (ficheros, extra) => { const c = ctx(ficheros, extra); const det = TF.detectar(c); return TF.diagnostico(c, det); };
const codigos = (ficheros, extra) => hallazgos(ficheros, extra).map((h) => h.codigo);

const MAIN = `terraform {
  required_version = ">= 1.6"
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 5.0" }
  }
  backend "s3" { bucket = "estado" }
}
`;
const BUENO = { 'infra/main.tf': MAIN, 'infra/.terraform.lock.hcl': '', '.gitignore': '.terraform/\n' };

test('sin ficheros .tf devuelve null', () => {
  assert.strictEqual(TF.detectar(ctx({ 'wrangler.jsonc': '{}', 'src/a.ts': '' })), null);
  assert.strictEqual(TF.detectar(ctx({ 'infra/.terraform/x.tf': '' })), null);
  assert.strictEqual(TF.detectar(ctx({ 'node_modules/p/main.tf': '' })), null);
});

test('detecta en infra/, en la raíz y en config.terraform.dir; binario por defecto y tofu', () => {
  assert.strictEqual(TF.detectar(ctx(BUENO)).dir, 'infra');
  assert.strictEqual(TF.detectar(ctx(BUENO)).binario, 'terraform');
  assert.strictEqual(TF.detectar(ctx({ 'main.tf': MAIN })).dir, '');
  const c = ctx({ 'plataforma/main.tf': MAIN, 'infra/otro.tf': '' }, { cfg: D.config({ despliegue: { terraform: { dir: 'plataforma', binario: 'tofu' } } }) });
  const det = TF.detectar(c);
  assert.strictEqual(det.dir, 'plataforma');
  assert.strictEqual(det.binario, 'tofu');
});

test('porEntorno: carpetas por envs/*, workspaces por terraform.workspace', () => {
  const car = TF.detectar(ctx({ 'infra/envs/staging/main.tf': MAIN, 'infra/envs/production/main.tf': MAIN }));
  assert.strictEqual(car.porEntorno, 'carpetas');
  assert.deepStrictEqual(car.entornos, ['production', 'staging']);
  const ws = TF.detectar(ctx({ 'infra/main.tf': 'locals { n = terraform.workspace }' }));
  assert.strictEqual(ws.porEntorno, 'workspaces');
  assert.strictEqual(TF.detectar(ctx(BUENO)).porEntorno, null);
});

test('configuración correcta: sin hallazgos', () => {
  assert.deepStrictEqual(hallazgos(BUENO), []);
});

test('tf-backend-local: sin backend o local (aviso)', () => {
  const sin = { ...BUENO, 'infra/main.tf': MAIN.replace(/backend "s3" \{[^}]*\}/, '') };
  assert.ok(codigos(sin).includes('tf-backend-local'));
  const loc = { ...BUENO, 'infra/main.tf': MAIN.replace('backend "s3"', 'backend "local"') };
  const h = hallazgos(loc).find((x) => x.codigo === 'tf-backend-local');
  assert.strictEqual(h.nivel, 'aviso');
  assert.ok(!codigos(BUENO).includes('tf-backend-local'));
});

test('tf-sin-lock: falta .terraform.lock.hcl (raíz y cada entorno)', () => {
  const { 'infra/.terraform.lock.hcl': _, ...sinLock } = BUENO;
  const h = hallazgos(sinLock).filter((x) => x.codigo === 'tf-sin-lock');
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].nivel, 'error');
  const envs = { '.gitignore': '.terraform/', 'infra/envs/a/main.tf': MAIN, 'infra/envs/b/main.tf': MAIN, 'infra/envs/a/.terraform.lock.hcl': '' };
  const hs = hallazgos(envs).filter((x) => x.codigo === 'tf-sin-lock');
  assert.strictEqual(hs.length, 1);
  assert.match(hs[0].mensaje, /envs\/b/);
});

test('tf-version-libre: sin required_version o provider sin version (aviso)', () => {
  const sinReq = { ...BUENO, 'infra/main.tf': MAIN.replace('required_version = ">= 1.6"', '') };
  assert.ok(codigos(sinReq).includes('tf-version-libre'));
  const sinVer = { ...BUENO, 'infra/main.tf': MAIN.replace(', version = "~> 5.0"', '') };
  const h = hallazgos(sinVer).filter((x) => x.codigo === 'tf-version-libre');
  assert.strictEqual(h.length, 1);
  assert.match(h[0].mensaje, /cloudflare/);
  assert.strictEqual(h[0].nivel, 'aviso');
});

test('tf-estado-versionado: hay *.tfstate (error)', () => {
  const h = hallazgos({ ...BUENO, 'infra/terraform.tfstate': '{}' }).filter((x) => x.codigo === 'tf-estado-versionado');
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].nivel, 'error');
});

test('tf-gitignore: .gitignore no cubre .terraform/ (aviso)', () => {
  const { '.gitignore': _, ...sin } = BUENO;
  const h = hallazgos(sin).find((x) => x.codigo === 'tf-gitignore');
  assert.strictEqual(h.nivel, 'aviso');
  assert.ok(codigos({ ...BUENO, '.gitignore': 'node_modules\n' }).includes('tf-gitignore'));
  assert.ok(!codigos({ ...BUENO, '.gitignore': '**/.terraform/*\n' }).includes('tf-gitignore'));
});

test('tf-sin-prevent-destroy: recurso con estado sin lifecycle (aviso)', () => {
  const r = (extra) => ({ ...BUENO, 'infra/db.tf': `resource "aws_db_instance" "main" {\n  name = "x"\n${extra}}\n` });
  const h = hallazgos(r('')).find((x) => x.codigo === 'tf-sin-prevent-destroy');
  assert.strictEqual(h.nivel, 'aviso');
  assert.match(h.mensaje, /aws_db_instance\.main/);
  assert.ok(!codigos(r('  lifecycle {\n    prevent_destroy = true\n  }\n')).includes('tf-sin-prevent-destroy'));
  assert.ok(!codigos({ ...BUENO, 'infra/n.tf': 'resource "aws_instance" "x" {}' }).includes('tf-sin-prevent-destroy'));
});

test('tf-fuera-de-infra: .tf en la raíz y sin infra/ (aviso)', () => {
  const raiz = { 'main.tf': MAIN, '.terraform.lock.hcl': '', '.gitignore': '.terraform/' };
  const h = hallazgos(raiz).find((x) => x.codigo === 'tf-fuera-de-infra');
  assert.strictEqual(h.nivel, 'aviso');
  assert.match(h.mensaje, /infra\//);
  assert.ok(!codigos({ ...raiz, 'infra/otro.tf': '' }).includes('tf-fuera-de-infra'));
  assert.ok(!codigos(BUENO).includes('tf-fuera-de-infra'));
});

test('tf-duplicado-wrangler: recurso de Terraform ya declarado en wrangler (aviso)', () => {
  const wr = JSON.stringify({
    d1_databases: [{ binding: 'DB', database_name: 'mi-db', database_id: 'x' }],
    kv_namespaces: [{ binding: 'CACHE', id: 'k' }],
    r2_buckets: [{ binding: 'B', bucket_name: 'mi-bucket' }],
  });
  const tf = `resource "cloudflare_d1_database" "db" {\n  name = "mi-db"\n  lifecycle { prevent_destroy = true }\n}
resource "cloudflare_workers_kv_namespace" "kv" {\n  title = "CACHE"\n  lifecycle { prevent_destroy = true }\n}
resource "cloudflare_r2_bucket" "b" {\n  name = "mi-bucket"\n  lifecycle { prevent_destroy = true }\n}
resource "cloudflare_r2_bucket" "otro" {\n  name = "distinto"\n  lifecycle { prevent_destroy = true }\n}\n`;
  const hs = hallazgos({ ...BUENO, 'infra/cf.tf': tf, 'wrangler.jsonc': wr }).filter((x) => x.codigo === 'tf-duplicado-wrangler');
  assert.strictEqual(hs.length, 3);
  assert.ok(hs.every((x) => x.nivel === 'aviso' && /Wrangler ya aprovisiona/.test(x.mensaje)));
  assert.ok(!codigos({ ...BUENO, 'infra/cf.tf': tf }).includes('tf-duplicado-wrangler'));
});

test('gates: fmt y init -backend=false + validate por raíz y por envs/<e>', () => {
  const c = ctx({ 'infra/envs/staging/main.tf': MAIN, 'infra/envs/production/main.tf': MAIN });
  const gs = TF.gates(c, TF.detectar(c));
  const nombres = gs.map((g) => g.gate);
  assert.deepStrictEqual(nombres, ['tf-fmt', 'tf-validate:production', 'tf-validate:staging']);
  assert.strictEqual(gs[0].run, 'terraform -chdir=infra fmt -check -recursive');
  assert.strictEqual(gs[1].run, 'terraform -chdir=infra/envs/production init -backend=false -input=false && terraform -chdir=infra/envs/production validate');
});

test('gates: tflint y checkov solo si están en el PATH; binario tofu', () => {
  const f = { 'main.tf': MAIN };
  const sin = ctx(f);
  assert.deepStrictEqual(TF.gates(sin, TF.detectar(sin)).map((g) => g.gate), ['tf-fmt', 'tf-validate']);
  const con = ctx(f, { enPath: () => true, cfg: D.config({ despliegue: { terraform: { binario: 'tofu' } } }) });
  const gs = TF.gates(con, TF.detectar(con));
  assert.deepStrictEqual(gs.map((g) => g.gate), ['tf-fmt', 'tf-validate', 'tf-tflint', 'tf-checkov']);
  assert.strictEqual(gs[0].run, 'tofu fmt -check -recursive');
  assert.strictEqual(gs[3].run, 'checkov -d . --quiet');
});

test('los gates no hacen referencia a secretos ni a tokens', () => {
  const c = ctx({ 'infra/envs/a/main.tf': MAIN }, { enPath: () => true });
  assert.doesNotMatch(JSON.stringify(TF.gates(c, TF.detectar(c))), /secrets|token/i);
});

test('contrato: id terraform, comandoLocal null, sin pasosCi ni secretosEsperados', () => {
  assert.strictEqual(TF.id, 'terraform');
  assert.strictEqual(TF.comandoLocal(ctx(BUENO)), null);
  assert.strictEqual('pasosCi' in TF, false);
  assert.strictEqual('secretosEsperados' in TF, false);
});

test('adaptadores() devuelve el adaptador de terraform', () => {
  assert.ok(D.adaptadores().some((a) => a.id === 'terraform'));
});
