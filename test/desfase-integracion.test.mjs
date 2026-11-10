// DESFASE entre lo local y el remoto en las ramas de INTEGRACION (main/develop).
//
// El problema: si tu copia de develop lleva doce commits de retraso, estas construyendo sobre una
// base que ya no existe — y no te enteras hasta el merge, cuando ya duele. Nadie ejecuta
// '/faro:sincronizar' preventivamente: se ejecuta despues de chocar.
//
// Por que SOLO main/develop: son ramas COMPARTIDAS. Que tu rama de trabajo vaya por delante del
// remoto es lo normal —es trabajo tuyo sin subir— y avisar de eso seria ruido en cada sesion.
//
// Por que en el VIGILANTE y no en 'session': exige 'fetch', que es RED, y el arranque es sincrono.
// Meterlo alli alargaria cada sesion; en background no cuesta espera a nadie.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(RAIZ, 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { desfaseIntegracion } = require(path.join(HOOKS, 'lib', 'git.js'));

// ---------- la decision (pura) ----------

test('ir por DETRAS avisa, y dice que hacer', () => {
  const a = desfaseIntegracion([{ rama: 'develop', detras: 12 }]);
  assert.strictEqual(a.length, 1, JSON.stringify(a));
  assert.match(a[0], /12 commit/);
  assert.match(a[0], /base vieja/i, 'debe decir la consecuencia, no solo el numero');
  assert.match(a[0], /sincronizar/, 'y el comando que lo arregla');
});

test('estar al dia NO dice nada (el silencio es lo normal)', () => {
  assert.deepStrictEqual(desfaseIntegracion([{ rama: 'develop', detras: 0 }, { rama: 'main', detras: 0 }]), []);
});

// "No lo se" NO es "estas al dia". Callarlo seria dar por bueno algo que nadie comprobo — el mismo
// principio que el vigilante aplica con la forja y el triaje con el criterio.
test('si no se pudo comparar, lo DICE (no lo da por bueno)', () => {
  const a = desfaseIntegracion([{ rama: 'develop', detras: null, motivo: 'sin rama remota' }]);
  assert.strictEqual(a.length, 1);
  assert.match(a[0], /no se si estas al dia/i, a[0]);
});

test('sin motivo, un null se ignora en silencio (no hay nada que contar)', () => {
  assert.deepStrictEqual(desfaseIntegracion([{ rama: 'develop', detras: null }]), []);
});

test('varias ramas se avisan por separado', () => {
  assert.strictEqual(desfaseIntegracion([{ rama: 'main', detras: 3 }, { rama: 'develop', detras: 7 }]).length, 2);
});

test('entrada vacia o basura no revienta', () => {
  assert.deepStrictEqual(desfaseIntegracion([]), []);
  assert.deepStrictEqual(desfaseIntegracion(null), []);
  assert.deepStrictEqual(desfaseIntegracion([null, {}]), []);
});

// ---------- end to end, con un remoto de verdad ----------

// Dos clones del mismo repo: uno se queda atras mientras el otro empuja. Es el caso real —
// un companero integra en develop mientras tu trabajas.
function repoDesfasado(commitsDeVentaja) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-desf-'));
  const sh = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
  const remoto = path.join(base, 'remoto.git');
  sh(base, 'init', '-q', '--bare', remoto);

  const local = path.join(base, 'local');
  sh(base, 'clone', '-q', remoto, local);
  sh(local, 'config', 'user.email', 't@t'); sh(local, 'config', 'user.name', 'T');
  sh(local, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(local, 'a.txt'), 'x');
  sh(local, 'add', '-A'); sh(local, 'commit', '-q', '-m', 'base');
  sh(local, 'branch', '-m', 'develop'); sh(local, 'push', '-q', '-u', 'origin', 'develop');

  if (commitsDeVentaja > 0) {
    const otro = path.join(base, 'otro');
    sh(base, 'clone', '-q', remoto, otro);
    sh(otro, 'config', 'user.email', 'o@o'); sh(otro, 'config', 'user.name', 'O');
    sh(otro, 'config', 'commit.gpgsign', 'false');
    sh(otro, 'checkout', '-q', '-B', 'develop', 'origin/develop');
    for (let i = 1; i <= commitsDeVentaja; i++) {
      fs.writeFileSync(path.join(otro, `c${i}.txt`), `c${i}`);
      sh(otro, 'add', '-A'); sh(otro, 'commit', '-q', '-m', `commit ${i}`);
    }
    sh(otro, 'push', '-q', 'origin', 'develop');
  }

  // Faseo minimo valido: sin el, el vigilante no tiene nada mas que mirar.
  fs.mkdirSync(path.join(local, 'documentos', 'funcional'), { recursive: true });
  fs.writeFileSync(path.join(local, 'documentos', 'funcional', 'f.md'), '# F\n');
  fs.writeFileSync(path.join(local, 'ESTADO.md'), `---
iniciativa: T
fases_total: 1
fase_actual: 1
owner: t
funcional: documentos/funcional/f.md
---

### Fase 1 · X — in_progress
Lo que trae.
Objetivo: 2026-12-01
- [ ] #1 · Algo — @t
`);
  return local;
}
const vigilar = (dir) => spawnSync(process.execPath, [path.join(HOOKS, 'harness.js'), 'vigilar'], {
  cwd: dir, encoding: 'utf8', timeout: 90000,
  env: { ...process.env, CLAUDE_PROJECT_DIR: dir, FARO_GITHUB_TOKEN: '', GITHUB_TOKEN: '' },
});

test('con el remoto por delante, el vigilante avisa y DESPIERTA al agente (exit 2)', () => {
  const r = vigilar(repoDesfasado(3));
  assert.match(r.stderr, /3 commit\(s\) POR DETRAS/, r.stderr);
  // Sin exit 2 el hook no despierta al agente: el aviso existiria y no lo leeria nadie.
  assert.strictEqual(r.status, 2, `el aviso no llega sin exit 2:\n${r.stderr}`);
});

test('al dia con el remoto: silencio y exit 0', () => {
  const r = vigilar(repoDesfasado(0));
  assert.strictEqual(r.status, 0, `no deberia hablar:\n${r.stderr}`);
  assert.ok(!/POR DETRAS/.test(r.stderr), r.stderr);
});

// Lo que NO debe pasar: quejarse de la rama de trabajo propia. Ir por delante del remoto en tu rama
// es el estado normal de cualquiera que este trabajando.
test('la rama de TRABAJO por delante del remoto NO se menciona', () => {
  const dir = repoDesfasado(0);
  const sh = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  sh('switch', '-q', '-c', 'feat/mi-trabajo');
  fs.writeFileSync(path.join(dir, 'nuevo.txt'), 'trabajo sin subir');
  sh('add', '-A'); sh('commit', '-q', '-m', 'mi trabajo');
  const r = vigilar(dir);
  assert.ok(!/feat\/mi-trabajo/.test(r.stderr), `no puede quejarse de tu propio trabajo:\n${r.stderr}`);
});
