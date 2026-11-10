// #182 — CACHE DE GATES: un gate que ya salio verde no se repite si el arbol git de la app (y el de sus
// dependencias de workspace) no cambio. La clave es un hash del CONTENIDO (indice de git + lo modificado y
// lo sin seguimiento), el nombre del gate, la forma exacta del comando y la version del gate. Se guarda en el
// directorio privado del usuario; sus entradas son datos NO confiables (esquema estricto).
import { test, after } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const C = createRequire(import.meta.url)(path.join(HOOKS, 'lib', 'cache-gates.js'));

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-cache-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const git = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout; };
const escribir = (dir, rel, txt) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };

function repo() {
  const d = tmp(); git(d, 'init', '-q');
  escribir(d, 'apps/api/src/a.ts', 'export const a = 1;\n');
  escribir(d, 'apps/web/src/w.ts', 'export const w = 1;\n');
  escribir(d, 'packages/shared/src/s.ts', 'export const s = 1;\n');
  escribir(d, 'pnpm-lock.yaml', 'lock: 1\n');
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'base');
  return d;
}
const clave = (d, rutas, extra = {}) => C.clave({ root: d, rutas, gate: 'typecheck', forma: ['pnpm', 'run', 'typecheck'], pm: 'pnpm', ...extra });
const entorno = () => ({ ...process.env, FARO_PROC_DIR: tmp(), FARO_CACHE_DIR: '' });

test('la clave es estable y solo cambia si cambia el arbol de la app o de sus dependencias', () => {
  const d = repo();
  const k0 = clave(d, ['apps/api']);
  assert.match(k0, /^[0-9a-f]{64}$/);
  assert.strictEqual(clave(d, ['apps/api']), k0, 'determinista');
  escribir(d, 'apps/web/src/w.ts', 'export const w = 2;\n');
  assert.strictEqual(clave(d, ['apps/api']), k0, 'otra app sin relacion no invalida');
  assert.notStrictEqual(clave(d, ['apps/web']), clave(repo(), ['apps/web']) + 'x');
  escribir(d, 'apps/api/src/a.ts', 'export const a = 2;\n');
  const k1 = clave(d, ['apps/api']);
  assert.notStrictEqual(k1, k0, 'cambio sin commitear en la app');
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'x');
  assert.strictEqual(clave(d, ['apps/api']), k1, 'commitear lo mismo no cambia la clave (es contenido, no historia)');
  const kDep = clave(d, ['apps/api', 'packages/shared']);
  escribir(d, 'packages/shared/src/s.ts', 'export const s = 2;\n');
  assert.notStrictEqual(clave(d, ['apps/api', 'packages/shared']), kDep, 'cambio en una dependencia de workspace');
  const kU = clave(d, ['apps/api']);
  escribir(d, 'apps/api/src/nuevo.ts', 'export {};\n');
  assert.notStrictEqual(clave(d, ['apps/api']), kU, 'fichero nuevo sin seguimiento');
  fs.rmSync(path.join(d, 'apps/api/src/nuevo.ts'));
  assert.strictEqual(clave(d, ['apps/api']), kU);
  fs.rmSync(path.join(d, 'apps/api/src/a.ts'));
  assert.notStrictEqual(clave(d, ['apps/api']), kU, 'fichero borrado');
});

test('la clave incluye el gate, la forma del comando, el gestor y la version del gate', () => {
  const d = repo();
  const base = clave(d, ['apps/api']);
  assert.notStrictEqual(C.clave({ root: d, rutas: ['apps/api'], gate: 'lint', forma: ['pnpm', 'run', 'typecheck'], pm: 'pnpm' }), base);
  assert.notStrictEqual(clave(d, ['apps/api'], { forma: ['pnpm', 'run', 'typecheck', '--strict'] }), base);
  assert.notStrictEqual(clave(d, ['apps/api'], { pm: 'npm' }), base);
  assert.notStrictEqual(clave(d, ['apps/api'], { extra: 'otra-version-de-gate' }), base);
  assert.ok(Number.isInteger(C.VERSION_GATE));
});

test('rutas no validas (.., absolutas, opciones, caracteres raros) → sin cache, nunca llegan a git', () => {
  const d = repo();
  for (const mala of ['../fuera', '/etc', '-rf', 'a b', 'a;b', 'apps/../..', '']) assert.strictEqual(clave(d, [mala]), null, mala);
  assert.strictEqual(clave(tmp(), ['x']), null, 'fuera de un repo git no hay clave');
});

test('hit / miss / invalidacion', () => {
  const d = repo(); const env = entorno();
  const k = clave(d, ['apps/api']);
  assert.strictEqual(C.leer(env, d, 'api', 'typecheck', k), null, 'miss inicial');
  assert.ok(C.escribir(env, d, 'api', 'typecheck', k, { ms: 1234 }));
  const h = C.leer(env, d, 'api', 'typecheck', k);
  assert.ok(h && typeof h.cuando === 'number' && h.ms === 1234, 'hit');
  assert.strictEqual(C.leer(env, d, 'api', 'lint', k), null, 'otro gate = miss');
  assert.strictEqual(C.leer(env, d, 'web', 'typecheck', k), null, 'otra app = miss');
  assert.strictEqual(C.leer(env, d, 'api', 'typecheck', k.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))), null, 'otra clave = miss');
  escribir(d, 'apps/api/src/a.ts', 'export const a = 9;\n');
  assert.strictEqual(C.leer(env, d, 'api', 'typecheck', clave(d, ['apps/api'])), null, 'cambio del arbol invalida');
  assert.ok(C.escribir(env, d, 'api', 'typecheck', k, { ms: 1 }));
  assert.strictEqual(C.leer(env, d, 'api', 'typecheck', k, { ignorar: true }), null, '--sin-cache ignora la lectura');
  const r = C.resumen(env); assert.strictEqual(r.n, 1); assert.ok(r.bytes > 0);
});

test('las entradas de la cache se tratan como NO confiables', () => {
  const d = repo(); const env = entorno();
  const k = clave(d, ['apps/api']);
  C.escribir(env, d, 'api', 'typecheck', k, { ms: 5 });
  const dir = path.join(env.FARO_PROC_DIR, 'cache'); const [f] = fs.readdirSync(dir); const ruta = path.join(dir, f);
  const buena = JSON.parse(fs.readFileSync(ruta, 'utf8'));
  const probar = (obj) => { fs.writeFileSync(ruta, typeof obj === 'string' ? obj : JSON.stringify(obj)); return C.leer(env, d, 'api', 'typecheck', k); };
  assert.ok(probar(buena));
  assert.strictEqual(probar({ ...buena, extra: 1 }), null, 'clave desconocida');
  assert.strictEqual(probar({ ...buena, resultado: 'fail' }), null, 'solo el verde se reutiliza');
  assert.strictEqual(probar({ ...buena, cuando: 'ayer' }), null, 'tipo erroneo');
  assert.strictEqual(probar({ ...buena, clave: 'x'.repeat(64) }), null, 'clave distinta');
  assert.strictEqual(probar('{ basura'), null);
  assert.strictEqual(probar(JSON.stringify({ ...buena, app: 'a'.repeat(5000) })), null, 'desmesurada');
  assert.strictEqual(probar({ ...buena, cuando: Date.now() + 10 * 86400e3 }), null, 'fecha futura');
});

test('limpiar: retira lo caducado/invalido; --todo vacia; sin confirmar no borra', () => {
  const d = repo(); const env = entorno();
  const k = clave(d, ['apps/api']);
  C.escribir(env, d, 'api', 'typecheck', k, { ms: 5 });
  C.escribir(env, d, 'web', 'lint', k, { ms: 5 });
  const dir = path.join(env.FARO_PROC_DIR, 'cache');
  fs.writeFileSync(path.join(dir, 'zz.json'), '{ basura');
  assert.strictEqual(C.limpiar(env, { confirmo: false }).n, 1);
  assert.strictEqual(fs.readdirSync(dir).filter((f) => f !== 'hmac.key').length, 3);
  assert.strictEqual(C.limpiar(env, { confirmo: true }).n, 1);
  assert.strictEqual(fs.readdirSync(dir).filter((f) => f !== 'hmac.key').length, 2);
  assert.strictEqual(C.limpiar(env, { confirmo: true, todo: true }).n, 2);
  assert.strictEqual(fs.readdirSync(dir).filter((f) => f !== 'hmac.key').length, 0);
});

// ───────── revision de seguridad: la cache no es falsificable y la clave no queda obsoleta ─────────
const K = 'a'.repeat(64);
const ficheroCache = (env) => { const dir = path.join(env.FARO_PROC_DIR, 'cache'); return path.join(dir, fs.readdirSync(dir).find((f) => /^[0-9a-f]{24}\.json$/.test(f))); };

test('una entrada fabricada (esquema valido, sin firma o con firma ajena) es un miss', () => {
  const d = tmp(); const env = entorno();
  assert.ok(C.escribir(env, d, 'api', 'lint', K, { ms: 1 }));
  const ruta = ficheroCache(env); const buena = JSON.parse(fs.readFileSync(ruta, 'utf8'));
  assert.ok(C.leer(env, d, 'api', 'lint', K), 'la propia entrada verifica');
  assert.ok(typeof buena.firma === 'string' && /^[0-9a-f]{64}$/.test(buena.firma));
  const { firma, ...sinFirma } = buena;
  fs.writeFileSync(ruta, JSON.stringify(sinFirma)); assert.strictEqual(C.leer(env, d, 'api', 'lint', K), null, 'sin firma');
  fs.writeFileSync(ruta, JSON.stringify({ ...buena, firma: '0'.repeat(64) })); assert.strictEqual(C.leer(env, d, 'api', 'lint', K), null, 'firma falsa');
  fs.writeFileSync(ruta, JSON.stringify({ ...buena, ms: 999 })); assert.strictEqual(C.leer(env, d, 'api', 'lint', K), null, 'campo alterado');
  // misma entrada firmada con el secreto de OTRO usuario/directorio
  const env2 = entorno(); C.escribir(env2, d, 'api', 'lint', K, { ms: 1 });
  fs.writeFileSync(ruta, fs.readFileSync(ficheroCache(env2), 'utf8')); assert.strictEqual(C.leer(env, d, 'api', 'lint', K), null, 'firmada con otro secreto');
});

test('el secreto vive en el directorio privado, no se deriva del repo y un enlace no se sigue', () => {
  const d = tmp(); const env = entorno();
  C.escribir(env, d, 'api', 'lint', K, { ms: 1 });
  const sec = path.join(env.FARO_PROC_DIR, 'cache', 'hmac.key');
  assert.ok(fs.statSync(sec).size >= 32);
  const env2 = entorno(); C.escribir(env2, d, 'api', 'lint', K, { ms: 1 });
  assert.notStrictEqual(fs.readFileSync(sec, 'hex'), fs.readFileSync(path.join(env2.FARO_PROC_DIR, 'cache', 'hmac.key'), 'hex'));
  assert.strictEqual(C.limpiar(env, { confirmo: true, todo: true }).n, 1);
  assert.ok(fs.existsSync(sec), 'limpiar la cache no borra el secreto');
  // secreto sustituido por un enlace: no se usa y no se escribe
  const objetivo = path.join(tmp(), 'otro.key'); fs.writeFileSync(objetivo, 'x'.repeat(32));
  fs.rmSync(sec);
  try { fs.symlinkSync(objetivo, sec); } catch { return; }
  assert.strictEqual(C.escribir(env, d, 'api', 'lint', K, { ms: 1 }), false);
  assert.strictEqual(fs.readFileSync(objetivo, 'utf8'), 'x'.repeat(32));
});

test('la clave cambia con la version de node, las variables de entorno que alteran el gate y los ficheros de configuracion de la raiz', () => {
  const d = repo(); const base = { entorno: {} };   // independiente del entorno real (en CI ya hay CI=true)
  const k = clave(d, ['apps/api'], base);
  assert.notStrictEqual(clave(d, ['apps/api'], { ...base, node: 'v0.0.1' }), k, 'version de node');
  assert.notStrictEqual(clave(d, ['apps/api'], { entorno: { NODE_ENV: 'production' } }), k, 'NODE_ENV');
  assert.notStrictEqual(clave(d, ['apps/api'], { entorno: { CI: 'true' } }), k, 'CI');
  assert.strictEqual(clave(d, ['apps/api'], { entorno: { OTRA_COSA: '1' } }), k, 'lo irrelevante no invalida');
  escribir(d, '.npmrc', 'hoist=false\n');
  assert.notStrictEqual(clave(d, ['apps/api'], base), k, '.npmrc de la raiz');
  const k2 = clave(d, ['apps/api'], base);
  escribir(d, 'tsconfig.base.json', '{}\n');
  assert.notStrictEqual(clave(d, ['apps/api'], base), k2, 'tsconfig de la raiz');
  const k3 = clave(d, ['apps/api'], base);
  escribir(d, 'wrangler.jsonc', '{}\n');
  assert.notStrictEqual(clave(d, ['apps/api'], base), k3, 'wrangler.* de la raiz');
});

test('cualquier fichero de configuracion de la RAIZ invalida (eslint, biome, vitest, tsconfig.*.json, .*rc)', () => {
  const d = repo();
  for (const f of ['eslint.config.js', 'biome.json', 'vitest.workspace.ts', 'tsconfig.app.json', '.eslintrc.cjs', '.prettierrc', 'vite.config.mts']) {
    const antes = clave(d, ['apps/api']);
    escribir(d, f, '{}\n');
    assert.notStrictEqual(clave(d, ['apps/api']), antes, f);
  }
  const antes = clave(d, ['apps/api']);
  escribir(d, 'README.md', 'x\n'); escribir(d, 'docs/a.md', 'x\n');
  assert.strictEqual(clave(d, ['apps/api']), antes, 'un README de la raiz no es configuracion');
});
