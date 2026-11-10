// #133 — TDD VERIFICABLE: el harness comprueba el orden rojo -> verde, no solo que "hay tests".
//
// Cuatro piezas, todas en lib/tdd.js y cableadas como subcomandos propios en hooks.json (sin tocar
// los manejadores existentes):
//   - tdd-post (PostToolUse / PostToolUseFailure sobre Bash|PowerShell): detecta una ejecucion de
//     tests y registra que ficheros de test quedaron en ROJO (con hash de su contenido) por repo y
//     sesion, en CLAUDE_PLUGIN_DATA.
//   - tdd-pre (PreToolUse Write|Edit): editar CODIGO sin un test rojo de ese modulo en la sesion avisa
//     (una vez por modulo) o bloquea (exit 2), segun .faro.json > tdd.modo. Editar un test que esta en
//     rojo y aun no paso a verde avisa/bloquea: "no debilites el test para que pase".
//   - tdd-stop (Stop): si en la sesion se toco codigo, corre el script 'test' de las apps afectadas;
//     si falla devuelve el control al agente (exit 2), y tras N veces el mismo fallo, avisa al humano.
//   - tdd-revisar [base]: reglas DETERMINISTAS de tests debilitados en el diff (lo usa revisor-code).
//
// Fixtures: repos git temporales y stdin JSON con la forma real de los hooks de Claude Code.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { umbral, plazo, conReintento } from './lib-tiempo.mjs';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(RAIZ, 'plugins', 'faro', 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');
const require = createRequire(import.meta.url);
const tdd = require(path.join(HOOKS, 'lib', 'tdd.js'));

const escribir = (dir, rel, txt) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, txt);
};
const git = (cwd, ...a) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// Un hook = el harness con su stdin JSON. Cada repo lleva su propio CLAUDE_PLUGIN_DATA.
const hook = (dir, cmd, payload, extra = []) => {
  const r = spawnSync(process.execPath, [HARNESS, cmd, ...extra], {
    cwd: dir, encoding: 'utf8', timeout: 180000, windowsHide: true,
    input: payload ? JSON.stringify({ session_id: 'ses-1', cwd: dir, ...payload }) : '',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_DATA: path.join(os.tmpdir(), 'faro-tdd-data', path.basename(dir)) },
  });
  return { out: r.stdout || '', err: r.stderr || '', status: r.status };
};
const preEdit = (dir, rel) => hook(dir, 'tdd-pre', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, rel), old_string: 'a', new_string: 'b' } });
// Ejecucion de tests FALLIDA: en Claude Code un Bash con exit != 0 llega como PostToolUseFailure.
const runRojo = (dir, command, salida) => hook(dir, 'tdd-post', { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command }, error: `Exit code 1\n${salida}` });
const runVerde = (dir, command, salida) => hook(dir, 'tdd-post', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: salida, stderr: '', interrupted: false } });
const stop = (dir) => hook(dir, 'tdd-stop', { hook_event_name: 'Stop', stop_hook_active: false });

const ESTADO = '---\niniciativa: T\nfases_total: 1\nfase_actual: 1\n---\n### Fase 1 · Una — in_progress\n';

// Monorepo con apps/x: codigo en apps/x/src/a.ts y su test colocado apps/x/src/a.test.ts.
function monorepo(modo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-tdd-mono-'));
  escribir(dir, 'ESTADO.md', ESTADO);
  escribir(dir, '.faro.json', JSON.stringify({ monorepo: { apps: { x: { rol: 'La app x' } } }, ...(modo ? { tdd: { modo } } : {}) }));
  escribir(dir, 'package.json', JSON.stringify({ name: 'mono', private: true }));
  escribir(dir, 'pnpm-workspace.yaml', 'packages:\n  - "apps/*"\n');
  escribir(dir, 'apps/x/package.json', JSON.stringify({ name: 'mono-x', version: '1.0.0' }));
  escribir(dir, 'apps/x/src/a.ts', 'export const suma = (a: number, b: number) => a - b;\n');
  escribir(dir, 'apps/x/src/a.test.ts', "import { suma } from './a';\ntest('suma', () => { expect(suma(1, 2)).toBe(3); });\n");
  escribir(dir, 'apps/x/src/b.ts', 'export const b = 1;\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 'T'); git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'switch', '-q', '-c', 'develop');
  git(dir, 'switch', '-q', '-c', 'feat/1-x');
  return dir;
}

// Repo simple con 'npm test' de verdad (node --test) para el Stop. 'falla' decide si el test pasa.
function simple(modo, { falla = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-tdd-simple-'));
  escribir(dir, 'ESTADO.md', ESTADO);
  escribir(dir, '.faro.json', JSON.stringify(modo ? { tdd: { modo } } : {}));
  // El script deja una marca: asi se sabe si el Stop ejecuto los tests o no.
  escribir(dir, 'package.json', JSON.stringify({ name: 's', private: true, scripts: { test: "node -e \"require('fs').writeFileSync('.marca-test','1')\" && node --test" } }));
  escribir(dir, 'src/a.js', 'module.exports = (a, b) => a - b;\n');
  escribir(dir, 'test/a.test.js', `const assert = require('node:assert');\nconst { test } = require('node:test');\nconst suma = require('../src/a.js');\ntest('suma', () => { assert.strictEqual(suma(1, 2), ${falla ? 3 : -1}); });\n`);
  escribir(dir, '.gitignore', '.marca-*\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 'T'); git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

// ---------- configuracion ----------

test('config: por defecto modo aviso con globs razonables; tests mandan sobre código', () => {
  const dir = simple(null);
  const c = tdd.config(dir);
  assert.strictEqual(c.modo, 'aviso');
  assert.strictEqual(tdd.clasificar(dir, 'src/a.js', c), 'codigo');
  assert.strictEqual(tdd.clasificar(dir, 'apps/x/src/a.ts', c), 'codigo');
  assert.strictEqual(tdd.clasificar(dir, 'test/a.test.js', c), 'test');
  assert.strictEqual(tdd.clasificar(dir, 'apps/x/src/a.test.ts', c), 'test', 'un test colocado en src/ es test, no código');
  assert.strictEqual(tdd.clasificar(dir, 'README.md', c), null);
  assert.strictEqual(tdd.clasificar(dir, 'src/estilos.css', c), null, 'solo cuentan las extensiones de código');
});

test('config: validarConfig avisa de un modo desconocido o globs que no son lista', () => {
  const dir = simple(null);
  escribir(dir, '.faro.json', JSON.stringify({ tdd: { modo: 'estricto', codigo: 'src/**' } }));
  const avisos = tdd.validarConfig(dir, { schema: JSON.parse(fs.readFileSync(path.join(HOOKS, 'faro-schema.json'), 'utf8')) });
  assert.ok(avisos.some((a) => /tdd\.modo/.test(a) && /aviso/.test(a) && /bloqueo/.test(a)), avisos.join('\n'));
  assert.ok(avisos.some((a) => /tdd\.codigo/.test(a)), avisos.join('\n'));
  escribir(dir, '.faro.json', JSON.stringify({ tdd: { timeout: 60 } }));
  assert.ok(tdd.validarConfig(dir).some((a) => /tdd\.timeout: clave desconocida/.test(a)), 'timeout ya no aplica: el Stop no ejecuta nada');
});

test('faro-schema.json declara el contrato tdd (modos y globs por defecto)', () => {
  const s = JSON.parse(fs.readFileSync(path.join(HOOKS, 'faro-schema.json'), 'utf8'));
  assert.deepStrictEqual(s.enums.tdd.modos, ['aviso', 'bloqueo', 'off']);
  assert.strictEqual(s.enums.tdd.modo_defecto, 'aviso');
  assert.ok(s.enums.tdd.codigo_defecto.includes('src/**'));
  assert.ok(s.enums.tdd.tests_defecto.includes('**/*.test.*'));
});

test('hooks.json cablea tdd-pre, tdd-post (éxito y fallo) y tdd-stop como entradas propias', () => {
  const h = JSON.parse(fs.readFileSync(path.join(HOOKS, 'hooks.json'), 'utf8')).hooks;
  const cmds = (ev, re) => (h[ev] || []).filter((g) => !re || re.test(g.matcher || '')).flatMap((g) => g.hooks.map((x) => x.command));
  assert.ok(cmds('PreToolUse', /Write/).some((c) => /harness\.js" tdd-pre$/.test(c)));
  assert.ok(cmds('PostToolUse', /Bash/).some((c) => /harness\.js" tdd-post$/.test(c)));
  assert.ok(cmds('PostToolUseFailure', /Bash/).some((c) => /harness\.js" tdd-post$/.test(c)));
  assert.ok(cmds('Stop').some((c) => /harness\.js" tdd-stop$/.test(c)));
  // Los manejadores existentes siguen intactos.
  assert.ok(cmds('PreToolUse', /Write/).some((c) => /pre-doc$/.test(c)));
  assert.ok(cmds('Stop').some((c) => /stop-check$/.test(c)));
});

// ---------- gate pre-edicion ----------

test('bloqueo: editar apps/x/src/a.ts sin un test rojo previo de «a» se bloquea con mensaje accionable', () => {
  const dir = monorepo('bloqueo');
  const r = preEdit(dir, 'apps/x/src/a.ts');
  assert.strictEqual(r.status, 2, r.out + r.err);
  assert.match(r.err, /apps\/x\/src\/a\.ts/);
  assert.match(r.err, /apps\/x\/src\/a\.test\.ts/, 'dice qué test escribir/ejecutar');
  assert.match(r.err, /rojo/);
});

test('aviso: editar código sin rojo avisa UNA vez por módulo y sesión; nunca bloquea', () => {
  const dir = monorepo('aviso');
  const r1 = preEdit(dir, 'apps/x/src/a.ts');
  assert.strictEqual(r1.status, 0, r1.err);
  const j = JSON.parse(r1.out);
  assert.match(j.hookSpecificOutput.additionalContext, /a\.test\.ts/);
  assert.strictEqual(j.hookSpecificOutput.permissionDecision, undefined, 'el aviso no decide permisos');
  const r2 = preEdit(dir, 'apps/x/src/a.ts');
  assert.strictEqual(r2.status, 0);
  assert.strictEqual(r2.out.trim(), '', 'segunda vez: silencio');
  const r3 = preEdit(dir, 'apps/x/src/b.ts');
  assert.match(r3.out, /b\.ts/, 'otro módulo sí avisa');
});

test('con un rojo previo del módulo (PostToolUseFailure) la edición pasa sin ruido', () => {
  const dir = monorepo('bloqueo');
  const p = runRojo(dir, 'pnpm --filter mono-x exec vitest run src/a.test.ts', ' FAIL  apps/x/src/a.test.ts > suma\nAssertionError: expected -1 to be 3\n Test Files  1 failed (1)');
  assert.strictEqual(p.status, 0, p.err);
  assert.strictEqual(p.out.trim(), '', 'registrar el rojo no habla');
  const r = preEdit(dir, 'apps/x/src/a.ts');
  assert.strictEqual(r.status, 0, r.err);
  assert.strictEqual(r.out.trim(), '');
});

test('sin test propio del módulo, vale un rojo de la misma app', () => {
  const dir = monorepo('bloqueo');
  runRojo(dir, 'npx vitest run', ' FAIL  apps/x/src/a.test.ts > suma');
  // b.ts no tiene b.test.*: el rojo de a.test.ts (misma app) basta.
  const r = preEdit(dir, 'apps/x/src/b.ts');
  assert.strictEqual(r.status, 0, r.err);
});

test('los tests se editan libremente ANTES de su rojo; código fuera de los globs no se mira', () => {
  const dir = monorepo('bloqueo');
  assert.strictEqual(preEdit(dir, 'apps/x/src/a.test.ts').status, 0);
  assert.strictEqual(preEdit(dir, 'README.md').status, 0);
  assert.strictEqual(preEdit(dir, 'apps/x/package.json').status, 0);
});

// ---------- fase verde ----------

test('editar un test que está en rojo antes de que pase a verde: «no debilites el test»', () => {
  const dir = monorepo('aviso');
  runRojo(dir, 'npx vitest run apps/x/src/a.test.ts', ' FAIL  apps/x/src/a.test.ts > suma');
  const r = preEdit(dir, 'apps/x/src/a.test.ts');
  assert.strictEqual(r.status, 0);
  assert.match(r.out, /no debilites el test/);
  const dirB = monorepo('bloqueo');
  runRojo(dirB, 'npx vitest run apps/x/src/a.test.ts', ' FAIL  apps/x/src/a.test.ts > suma');
  const rb = preEdit(dirB, 'apps/x/src/a.test.ts');
  assert.strictEqual(rb.status, 2);
  assert.match(rb.err, /no debilites el test/);
});

test('pasar a verde con el test CAMBIADO desde su rojo (hash distinto) se avisa', () => {
  const dir = monorepo('aviso');
  runRojo(dir, 'npx vitest run apps/x/src/a.test.ts', ' FAIL  apps/x/src/a.test.ts > suma');
  // El agente "arregla" el test en vez del código.
  escribir(dir, 'apps/x/src/a.test.ts', "import { suma } from './a';\ntest('suma', () => { expect(suma(1, 2)).toBe(-1); });\n");
  const v = runVerde(dir, 'npx vitest run apps/x/src/a.test.ts', ' ✓ apps/x/src/a.test.ts (1 test)\n Test Files  1 passed (1)');
  assert.strictEqual(v.status, 0);
  assert.match(v.out, /a\.test\.ts/);
  assert.match(v.out, /cambi/);
  // Tras el verde el test deja de estar "en rojo": ya se puede editar sin aviso.
  const r = preEdit(dir, 'apps/x/src/a.test.ts');
  assert.doesNotMatch(r.out, /no debilites/);
});

test('verde con el test intacto: silencio', () => {
  const dir = monorepo('aviso');
  runRojo(dir, 'npx vitest run apps/x/src/a.test.ts', ' FAIL  apps/x/src/a.test.ts > suma');
  const v = runVerde(dir, 'npx vitest run apps/x/src/a.test.ts', ' ✓ apps/x/src/a.test.ts (1 test)');
  assert.strictEqual(v.out.trim(), '');
});

test('un comando que no es de tests no registra nada', () => {
  const dir = monorepo('bloqueo');
  runRojo(dir, 'git status', 'fatal: apps/x/src/a.test.ts');
  assert.strictEqual(preEdit(dir, 'apps/x/src/a.ts').status, 2);
});

// ---------- Stop ----------
// tdd-stop NO ejecuta nada: un hook corre FUERA del sistema de permisos de Claude Code, y el script
// 'test' es contenido del repo que el propio agente pudo escribir. Decide solo con la evidencia de
// tdd-post y, si falta, dice la orden exacta para que el agente la lance por Bash con sus permisos.

test('Stop con código editado y sin ejecución de tests: NO ordena la suite completa ni ejecuta nada (#237)', () => {
  const dir = simple('aviso');
  preEdit(dir, 'src/a.js');                      // la sesion toca codigo
  const r = stop(dir);
  assert.strictEqual(r.status, 0, r.out + r.err);
  assert.doesNotMatch(r.out + r.err, /npm test/);
  assert.ok(!fs.existsSync(path.join(dir, '.marca-test')), 'el hook NO ejecuta el script test');
});

test('Stop con la última ejecución en rojo: exit 2', () => {
  const dir = simple('aviso');
  preEdit(dir, 'src/a.js');
  runRojo(dir, 'npm test', 'not ok 1 - suma\n# fail 1');
  const r = stop(dir);
  assert.strictEqual(r.status, 2, r.out + r.err);
  assert.match(r.err, /rojo/);
  assert.match(r.err, /tests-dominios --afectados/);
  assert.doesNotMatch(r.err, /npm test/, 'se relanza lo afectado, no la suite completa');
});

test('Stop tras una ejecución en verde posterior a la edición: silencio; editar otra vez lo reabre', () => {
  const dir = simple('aviso');
  preEdit(dir, 'src/a.js');
  runVerde(dir, 'npm test', '# pass 1\n# fail 0');
  const r = stop(dir);
  assert.strictEqual(r.status, 0, r.err);
  assert.strictEqual(r.out.trim() + r.err.trim(), '');
  preEdit(dir, 'src/a.js');                      // codigo tocado DESPUES del verde: sin rojo visto, no se pide la suite
  assert.strictEqual(stop(dir).status, 0);
});

test('Stop: el mismo pendiente devuelto 3 veces pasa a aviso para el humano (systemMessage), sin bloquear', () => {
  const dir = simple('aviso');
  preEdit(dir, 'src/a.js');
  runRojo(dir, 'npm test', 'not ok 1 - suma\n# fail 1');
  for (let i = 0; i < 3; i++) assert.strictEqual(stop(dir).status, 2, `intento ${i + 1}`);
  const r = stop(dir);
  assert.strictEqual(r.status, 0, r.err);
  assert.match(JSON.parse(r.out).systemMessage, /TDD/);
  const r5 = stop(dir);
  assert.strictEqual(r5.out.trim() + r5.err.trim(), '', 'el aviso al humano no se repite');
});

test('Stop sin cambios de código en la sesión: nada', () => {
  const dir = simple('aviso');
  const r = stop(dir);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.out.trim() + r.err.trim(), '');
});

test('Stop en repo sin script de tests: nada', () => {
  const dir = simple('aviso');
  escribir(dir, 'package.json', JSON.stringify({ name: 's', private: true }));
  preEdit(dir, 'src/a.js');
  const r = stop(dir);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.out.trim() + r.err.trim(), '');
});

test('Stop en monorepo: solo exige un rojo de la app tocada (sin suite completa) y lo da por bueno tras su verde', () => {
  const dir = monorepo('aviso');
  escribir(dir, 'apps/x/package.json', JSON.stringify({ name: 'mono-x', version: '1.0.0', scripts: { test: 'vitest run' } }));
  preEdit(dir, 'apps/x/src/a.ts');
  assert.strictEqual(stop(dir).status, 0, 'sin ejecutar: no se ordena la suite');
  runRojo(dir, 'pnpm --filter mono-x test', ' FAIL  src/a.test.ts');
  const r = stop(dir);
  assert.strictEqual(r.status, 2, r.out + r.err);
  assert.match(r.err, /tests-dominios --afectados/);
  assert.doesNotMatch(r.err, /pnpm --filter mono-x test/);
  runVerde(dir, 'pnpm --filter mono-x test', ' Test Files  1 passed (1)');
  const r2 = stop(dir);
  assert.strictEqual(r2.status, 0, r2.err);
  assert.strictEqual(r2.out.trim() + r2.err.trim(), '');
});

test('Stop en monorepo: el verde propio de una app manda sobre un rojo posterior de la raiz sin atribuir (#241)', () => {
  const dir = monorepo('aviso');
  escribir(dir, '.faro.json', JSON.stringify({ monorepo: { apps: { x: { rol: 'La app x' }, y: { rol: 'La app y' } } }, tdd: { modo: 'aviso' } }));
  escribir(dir, 'apps/x/package.json', JSON.stringify({ name: 'mono-x', version: '1.0.0', scripts: { test: 'vitest run' } }));
  escribir(dir, 'apps/y/package.json', JSON.stringify({ name: 'mono-y', version: '1.0.0', scripts: { test: 'vitest run' } }));
  escribir(dir, 'apps/y/src/b.ts', 'export const b = 1;\n');
  preEdit(dir, 'apps/x/src/a.ts');
  preEdit(dir, 'apps/y/src/b.ts');
  runVerde(dir, 'pnpm --filter mono-x test', ' Test Files  1 passed (1)');
  runRojo(dir, 'pnpm -r test', ' Command timed out');   // rojo de la raiz sin ningun test identificable
  const r = stop(dir);
  assert.strictEqual(r.status, 2, r.out + r.err);
  assert.match(r.err, /la app y/, 'y no tiene verde propio: hereda el rojo de la raiz');
  assert.doesNotMatch(r.err, /la app x/, 'x tiene verde propio posterior a su edicion: el rojo sin atribuir no la toca');
  runVerde(dir, 'pnpm --filter mono-y test', ' Test Files  1 passed (1)');
  assert.strictEqual(stop(dir).status, 0);
});

test('lib/tdd.js no lanza procesos con shell ni el script test', () => {
  const src = fs.readFileSync(path.join(HOOKS, 'lib', 'tdd.js'), 'utf8');
  assert.doesNotMatch(src, /shell:\s*true/);
  assert.doesNotMatch(src, /run test`/);
});

// ---------- coste ----------
// Los hooks tdd-* corren en CADA Write/Edit y en CADA Bash: el despacho va al PRINCIPIO de harness.js,
// antes de cargar el motor. Se comprueba con require.cache (determinista) y con un tope de tiempo holgado.
test('coste: tdd-pre/tdd-post sin nada que hacer no cargan el motor (ni code.js, ni git.js, ni base.js)', () => {
  const dir = monorepo('aviso');
  const espia = path.join(dir, '..', `${path.basename(dir)}-espia.cjs`);
  const salida = path.join(dir, '..', `${path.basename(dir)}-cache.json`);
  fs.writeFileSync(espia, `process.on('exit', () => require('fs').writeFileSync(${JSON.stringify(salida)}, JSON.stringify(Object.keys(require.cache))));\n`);
  const casos = [
    ['tdd-pre', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'README.md') } }],
    ['tdd-post', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git status' }, tool_response: { stdout: '' } }],
  ];
  for (const [cmd, payload] of casos) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ['--require', espia, HARNESS, cmd], {
      cwd: dir, encoding: 'utf8', windowsHide: true, input: JSON.stringify({ session_id: 's', cwd: dir, ...payload }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_DATA: path.join(os.tmpdir(), 'faro-tdd-data', path.basename(dir)) },
    });
    const ms = Date.now() - t0;
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout.trim(), '');
    const cargados = JSON.parse(fs.readFileSync(salida, 'utf8')).map((f) => f.replace(/\\/g, '/'));
    for (const m of ['lib/code.js', 'lib/git.js', 'lib/base.js', 'lib/paths.js']) {
      assert.ok(!cargados.some((f) => f.endsWith(m)), `${cmd} cargó ${m}`);
    }
    assert.ok(ms < umbral(3000), `${cmd} tardó ${ms} ms (umbral ${umbral(3000)}; el objetivo local es < 80 ms)`);
  }
});

// ---------- modo off ----------

test('modo off: ni avisa, ni bloquea, ni registra, ni pide tests al terminar', () => {
  const dir = simple('off');
  assert.strictEqual(preEdit(dir, 'src/a.js').out.trim(), '');
  assert.strictEqual(runRojo(dir, 'npm test', 'not ok 1 - test/a.test.js').out.trim(), '');
  const r = stop(dir);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.out.trim() + r.err.trim(), '');
});

test('el motor (este repo): su código no cae en los globs por defecto — los hooks no interfieren', () => {
  const r = hook(RAIZ, 'tdd-pre', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: HARNESS } });
  assert.strictEqual(r.status, 0, r.err);
  assert.strictEqual(r.out.trim(), '');
});

// ---------- revisor de tests debilitados ----------

test('tdd-revisar detecta aserciones borradas, skip/only, mock del propio módulo y tests sin aserciones', () => {
  const dir = monorepo(null);
  git(dir, 'switch', '-q', 'develop');
  escribir(dir, 'apps/x/src/c.test.ts', "import { c } from './c';\ntest('c', () => {\n  expect(c(1)).toBe(2);\n  expect(c(2)).toBe(4);\n});\n");
  escribir(dir, 'apps/x/src/c.ts', 'export const c = (n: number) => n * 2;\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'c');
  git(dir, 'switch', '-q', 'feat/1-x'); git(dir, 'rebase', '-q', 'develop');
  escribir(dir, 'apps/x/src/c.test.ts', "import { c } from './c';\nvi.mock('./c');\ntest.skip('c', () => {\n  expect(c(1)).toBe(2);\n});\nit.only('vacío', () => {\n  c(3);\n});\n");
  const r = spawnSync(process.execPath, [HARNESS, 'tdd-revisar', 'develop'], { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /apps\/x\/src\/c\.test\.ts/);
  assert.match(r.stdout, /aserci[oó]n(es)? eliminada/i);
  assert.match(r.stdout, /\.skip/);
  assert.match(r.stdout, /\.only/);
  assert.match(r.stdout, /mock del propio m[oó]dulo/i);
  assert.match(r.stdout, /sin aserciones/i);
});

test('tdd-revisar sin tests debilitados: lo dice y sale con 0', () => {
  const dir = monorepo(null);
  escribir(dir, 'apps/x/src/a.test.ts', "import { suma } from './a';\ntest('suma', () => { expect(suma(1, 2)).toBe(3); expect(suma(0, 0)).toBe(0); });\n");
  const r = spawnSync(process.execPath, [HARNESS, 'tdd-revisar', 'develop'], { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Sin tests debilitados/);
});

test('revisor-code usa tdd-revisar y documenta las reglas de tests debilitados', () => {
  const t = fs.readFileSync(path.join(RAIZ, 'plugins', 'faro', 'agents', 'revisor-code.md'), 'utf8');
  assert.match(t, /harness\.js" tdd-revisar/);
  for (const re of [/\.skip/, /\.only/, /xit/, /mock/i, /sin aserciones/i]) assert.match(t, re);
});
