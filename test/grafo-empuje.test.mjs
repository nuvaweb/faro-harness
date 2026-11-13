// Tarea T10 del grafo FARO (#301): empuje minimo por hooks (prompt, edicion, lectura).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const HARNESS = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'harness.js');
const I = require(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'grafo', 'indice.js'));
const E = require(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'grafo', 'empuje.js'));

const escribir = (dir, rel, txt) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };
function repo(extra = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-emp-'));
  escribir(d, 'faro/ESTADO.md', '# estado\n');
  escribir(d, 'src/facturas/emitir.ts', 'export function emitirFactura() {}\n');
  escribir(d, 'src/x.ts', "import { emitirFactura } from './facturas/emitir';\nexport const x = 1;\n");
  escribir(d, 'src/y.ts', "import { emitirFactura } from './facturas/emitir';\nexport const y = 1;\n");
  escribir(d, 'test/emitir.test.ts', "import { emitirFactura } from '../src/facturas/emitir';\n");
  for (const [rel, txt] of Object.entries(extra)) escribir(d, rel, txt);
  spawnSync('git', ['init', '-q'], { cwd: d, windowsHide: true });
  return d;
}
const indexar = (d) => { const idx = I.construir(d, {}); assert.ok(I.guardar(d, idx)); return idx; };
const ejecutar = (d, args, payload) => {
  const r = spawnSync(process.execPath, [HARNESS, ...args], {
    cwd: d, encoding: 'utf8', timeout: 60000, windowsHide: true,
    input: typeof payload === 'string' ? payload : JSON.stringify({ session_id: 's1', cwd: d, ...payload }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: d },
  });
  return { out: r.stdout || '', status: r.status };
};
const hook = (d, sub, payload) => ejecutar(d, ['grafo-hook', sub], payload);

test('lineasPrompt: una palabra vacia calla; una peticion real da <= 8 lineas con cabecera', () => {
  const d = repo(); const idx = indexar(d);
  assert.deepStrictEqual(E.lineasPrompt(idx, 'vale'), []);
  assert.deepStrictEqual(E.lineasPrompt(idx, 'sí'), []);
  assert.deepStrictEqual(E.lineasPrompt(idx, ''), []);
  const l = E.lineasPrompt(idx, 'arregla emitirFactura');
  assert.ok(l.length >= 2 && l.length <= 8, String(l.length));
  assert.ok(l[0].startsWith('grafo: relacionado con tu petición (harness.js grafo contexto «'), l[0]);
  assert.ok(l.slice(1).some((x) => x.includes('src/facturas/emitir.ts')));
  assert.deepStrictEqual(E.lineasPrompt(idx, 'zzzqqq xxxwww'), []);
});

test('cargarParaHook: null con indice > 5 MB, con empuje:false o sin indice', () => {
  const d = repo(); indexar(d);
  assert.ok(E.cargarParaHook(d));
  escribir(d, 'faro/config.json', JSON.stringify({ grafo: { empuje: false } }));
  assert.strictEqual(E.cargarParaHook(d), null);
  fs.unlinkSync(path.join(d, 'faro/config.json'));
  assert.ok(E.cargarParaHook(d));
  fs.writeFileSync(I.rutaIndice(d), JSON.stringify({ version: I.VERSION, ficheros: {}, relleno: 'x'.repeat(5 * 1024 * 1024 + 10) }));
  assert.strictEqual(E.cargarParaHook(d), null);
  assert.strictEqual(E.cargarParaHook(fs.mkdtempSync(path.join(os.tmpdir(), 'faro-emp-vacio-'))), null);
});

test('lineaEdicion: importadores y tests; null sin importadores', () => {
  const d = repo(); const idx = indexar(d);
  const l = E.lineaEdicion(idx, 'src/facturas/emitir.ts');
  assert.ok(/^grafo: src\/facturas\/emitir\.ts lo importan 3 \(.+\) · tests: 1$/.test(l), l);
  assert.strictEqual(E.lineaEdicion(idx, 'src/x.ts'), null);
  assert.strictEqual(E.lineaEdicion(idx, 'no/existe.ts'), null);
});

test('avisoLectura: fichero largo avisa; con rango, fuera de root, corto o binario no', () => {
  const largo = Array.from({ length: 400 }, (_, i) => `l${i}`).join('\n') + '\n';
  const d = repo({ 'src/largo.ts': largo, 'src/corto.ts': 'a\nb\n' });
  const abs = path.join(d, 'src/largo.ts');
  assert.strictEqual(E.avisoLectura(d, abs, {}), 'grafo: src/largo.ts tiene 400 líneas — harness.js grafo esqueleto src/largo.ts antes de leerlo entero');
  assert.strictEqual(E.avisoLectura(d, abs, { limit: 50 }), null);
  assert.strictEqual(E.avisoLectura(d, abs, { offset: 10 }), null);
  assert.strictEqual(E.avisoLectura(d, path.join(d, 'src/corto.ts'), {}), null);
  assert.strictEqual(E.avisoLectura(d, path.join(os.tmpdir(), 'otro.ts'), {}), null);
  assert.strictEqual(E.avisoLectura(d, path.join(d, 'src/no-existe.ts'), {}), null);
  fs.writeFileSync(path.join(d, 'bin.dat'), Buffer.alloc(3 * 1024 * 1024, 0));
  assert.strictEqual(E.avisoLectura(d, path.join(d, 'bin.dat'), {}), null);
  fs.writeFileSync(path.join(d, 'plano.txt'), 'a\n'.repeat(1.5 * 1024 * 1024));
  const r = E.avisoLectura(d, path.join(d, 'plano.txt'), {});
  assert.ok(r && /tiene \d+ líneas/.test(r));
  assert.ok(Number(/tiene (\d+)/.exec(r)[1]) <= 1024 * 1024 + 1, 'no cuenta mas alla de 2 MB');
});

test('grafo-hook leer: nunca decide permisos; sin indice no imprime nada', () => {
  const largo = Array.from({ length: 400 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
  const d = repo({ 'src/largo.ts': largo });
  const p = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(d, 'src/largo.ts') } };
  const sin = hook(d, 'leer', p);
  assert.strictEqual(sin.status, 0); assert.strictEqual(sin.out.trim(), '');
  indexar(d);
  const con = hook(d, 'leer', p);
  assert.strictEqual(con.status, 0);
  assert.ok(!con.out.includes('permissionDecision'));
  const j = JSON.parse(con.out.trim());
  assert.strictEqual(j.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.ok(j.hookSpecificOutput.additionalContext.includes('grafo esqueleto src/largo.ts'));
  assert.strictEqual(hook(d, 'leer', { ...p, tool_input: { ...p.tool_input, limit: 20 } }).out.trim(), '');
  assert.strictEqual(hook(d, 'leer', 'basura').status, 0);
});

test('grafo-hook post: una linea con los importadores; basura o apagado calla con 0', () => {
  const d = repo(); indexar(d);
  const r = hook(d, 'post', { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(d, 'src/facturas/emitir.ts') } });
  assert.strictEqual(r.status, 0);
  const j = JSON.parse(r.out.trim());
  assert.strictEqual(j.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(j.hookSpecificOutput.additionalContext.startsWith('grafo: src/facturas/emitir.ts lo importan 3'));
  assert.strictEqual(hook(d, 'post', { tool_input: {} }).out.trim(), '');
  assert.strictEqual(hook(d, 'post', { tool_input: { file_path: path.join(d, 'src/x.ts') } }).out.trim(), '');
  assert.strictEqual(hook(d, 'post', 'basura').status, 0);
  fs.writeFileSync(path.join(d, 'faro/config.json'), JSON.stringify({ grafo: { empuje: false } }));
  assert.strictEqual(hook(d, 'post', { tool_input: { file_path: path.join(d, 'src/facturas/emitir.ts') } }).out.trim(), '');
});

test('hooks.json cablea grafo-hook post y leer', () => {
  const h = JSON.parse(fs.readFileSync(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const cmds = (ev, m) => h[ev].filter((e) => e.matcher === m).flatMap((e) => e.hooks.map((x) => x.command));
  assert.ok(cmds('PostToolUse', 'Write|Edit|MultiEdit').some((c) => c.endsWith('harness.js" grafo-hook post')));
  assert.ok(cmds('PreToolUse', 'Read').some((c) => c.endsWith('harness.js" grafo-hook leer')));
});

test('prompt-context: empuja lineas del grafo con indice y calla con una palabra vacia', () => {
  const d = repo(); indexar(d);
  const pc = (prompt) => ejecutar(d, ['prompt-context'], { hook_event_name: 'UserPromptSubmit', prompt }).out;
  assert.ok(pc('arregla emitirFactura').includes('grafo: relacionado con tu petición'));
  assert.ok(!pc('vale').includes('grafo: relacionado'));
});

test('session: con indice, una linea de regla del grafo', () => {
  const d = repo(); indexar(d);
  const out = ejecutar(d, ['session'], { hook_event_name: 'SessionStart', source: 'startup' }).out;
  assert.ok(out.includes('Para orientarte, antes de leer'), 'regla de sesion');
});

test('prompt-context: la salida es un solo JSON aunque el turno ya emitiera contexto', () => {
  const d = repo(); indexar(d);
  const out = ejecutar(d, ['prompt-context'], { hook_event_name: 'UserPromptSubmit', prompt: 'arregla emitirFactura' }).out.trim();
  const j = JSON.parse(out);   // dos objetos concatenados harian fallar el parse
  assert.strictEqual(j.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.strictEqual(j.hookSpecificOutput.additionalContext.split('grafo: relacionado con tu petición').length, 2);
});

test('enIndice ignora claves del prototipo; promptUtil y hayIndice son baratos y coherentes', () => {
  const d = repo();
  assert.strictEqual(E.hayIndice(d), false);
  const idx = indexar(d);
  assert.strictEqual(E.hayIndice(d), true);
  assert.strictEqual(E.enIndice(idx, 'constructor'), false);
  assert.strictEqual(E.enIndice(idx, 'toString'), false);
  assert.strictEqual(E.enIndice(idx, 'src/x.ts'), true);
  assert.strictEqual(E.promptUtil('vale'), false);
  assert.strictEqual(E.promptUtil('arregla emitirFactura'), true);
  assert.strictEqual(hook(d, 'post', { tool_input: { file_path: path.join(d, 'constructor') } }).out.trim(), '');
});
