// Banco de medida del grafo FARO (#308): métricas del stream de `claude -p`, brazos e informe.
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
const B = require(path.join(RAIZ, 'bench', 'grafo', 'banco.js'));
const I = require(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'grafo', 'indice.js'));

const linea = (o) => JSON.stringify(o);
const STREAM = [
  linea({ type: 'system', subtype: 'init', session_id: 's1' }),
  linea({ type: 'assistant', message: { content: [
    { type: 'text', text: 'miro' },
    { type: 'tool_use', name: 'Grep', input: { pattern: 'x' } },
    { type: 'tool_use', name: 'Read', input: { file_path: 'a.js' } },
  ] } }),
  'esto no es json',
  linea({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
  linea({ type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'Bash', input: { command: 'node harness.js grafo contexto facturas' } },
    { type: 'tool_use', name: 'Bash', input: { command: 'grep -rn foo src' } },
    { type: 'tool_use', name: 'Edit', input: { file_path: 'a.js' } },
  ] } }),
  linea({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.1234, duration_ms: 45678, num_turns: 4,
    usage: { input_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 30000, output_tokens: 500 } }),
].join('\n');

test('metricas: lee coste, tiempo, turnos, tokens y llamadas del stream-json', () => {
  const m = B.metricas(STREAM);
  assert.strictEqual(m.coste, 0.1234);
  assert.strictEqual(m.ms, 45678);
  assert.strictEqual(m.turnos, 4);
  assert.deepStrictEqual(m.tokens, { entrada: 100, cacheEscrita: 2000, cacheLeida: 30000, salida: 500, sinCache: 2600 });
  assert.strictEqual(m.llamadas, 5);
  assert.deepStrictEqual(m.porHerramienta, { Grep: 1, Read: 1, Bash: 2, Edit: 1 });
  assert.strictEqual(m.exploracion, 3, 'Grep + Read + Bash con grep');
  assert.strictEqual(m.grafo, 1, 'una consulta al grafo');
  assert.strictEqual(m.error, false);
});

test('metricas: sin línea result se marca incompleto y no revienta', () => {
  const m = B.metricas(STREAM.split('\n').slice(0, 3).join('\n'));
  assert.strictEqual(m.completo, false);
  assert.strictEqual(m.coste, null);
  assert.strictEqual(m.llamadas, 2);
});

test('metricas: tokens sin caché = entrada + caché escrita + salida', () => {
  const m = B.metricas(linea({ type: 'result', usage: { input_tokens: 1, cache_creation_input_tokens: 2, output_tokens: 3 } }));
  assert.strictEqual(m.tokens.sinCache, 6);
  assert.strictEqual(m.tokens.cacheLeida, 0);
});

function repoFixture() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-banco-'));
  fs.mkdirSync(path.join(d, 'src'), { recursive: true });
  fs.mkdirSync(path.join(d, 'faro'), { recursive: true });
  fs.writeFileSync(path.join(d, 'faro', 'ESTADO.md'), '# estado\n');
  fs.writeFileSync(path.join(d, 'faro', 'config.json'), JSON.stringify({ otra: 1 }));
  fs.writeFileSync(path.join(d, 'src', 'a.js'), "const b = require('./b');\n");
  fs.writeFileSync(path.join(d, 'src', 'b.js'), 'module.exports = 1;\n');
  spawnSync('git', ['init', '-q'], { cwd: d, windowsHide: true });
  return d;
}
const cfg = (d) => JSON.parse(fs.readFileSync(path.join(d, 'faro', 'config.json'), 'utf8'));

test('prepararBrazo frio: sin índice y con el grafo apagado (fondo y empuje), sin pisar la config', () => {
  const d = repoFixture();
  assert.ok(I.guardar(d, I.construir(d, {})));
  B.prepararBrazo(d, 'frio');
  assert.strictEqual(I.cargar(d), null, 'el índice se borra');
  const c = cfg(d);
  assert.strictEqual(c.otra, 1);
  assert.strictEqual(c.grafo.fondo, false);
  assert.strictEqual(c.grafo.empuje, false);
});

test('prepararBrazo empuje: índice construido y empuje encendido', () => {
  const d = repoFixture();
  B.prepararBrazo(d, 'empuje');
  assert.ok(I.cargar(d), 'hay índice');
  assert.notStrictEqual(cfg(d).grafo.empuje, false);
});

test('prepararBrazo demanda: índice construido pero sin empuje', () => {
  const d = repoFixture();
  B.prepararBrazo(d, 'demanda');
  assert.ok(I.cargar(d));
  assert.strictEqual(cfg(d).grafo.empuje, false);
});

test('prepararBrazo: un brazo desconocido se rechaza', () => {
  assert.throws(() => B.prepararBrazo(repoFixture(), 'otro'), /brazo/i);
});

test('validarTareas: exige repos y tareas con id, repo conocido, prompt y comprobar', () => {
  const ok = { repos: { r: { ruta: '.' } }, tareas: [{ id: 't1', repo: 'r', prompt: 'p', comprobar: 'node -e 0' }] };
  assert.deepStrictEqual(B.validarTareas(ok), []);
  const errores = B.validarTareas({ repos: { r: { ruta: '.' } }, tareas: [{ id: 't1', repo: 'x', prompt: '' }, { id: 't1', repo: 'r', prompt: 'p', comprobar: 'c' }] });
  assert.ok(errores.some((e) => /repo/.test(e)));
  assert.ok(errores.some((e) => /prompt/.test(e)));
  assert.ok(errores.some((e) => /comprobar/.test(e)));
  assert.ok(errores.some((e) => /repetid/.test(e)));
});

test('argsClaude: modo no interactivo, stream-json y el plugin del repo en lugar del instalado', () => {
  const a = B.argsClaude('haz x', { pluginDir: '/p/faro' });
  assert.deepStrictEqual(a.slice(0, 2), ['-p', 'haz x']);
  assert.ok(a.includes('stream-json') && a.includes('--verbose'));
  assert.strictEqual(a[a.indexOf('--plugin-dir') + 1], '/p/faro');
  const s = JSON.parse(a[a.indexOf('--settings') + 1]);
  assert.strictEqual(s.enabledPlugins['faro@faro-marketplace'], false);
});

test('informe: tabla por brazo con medias, acierto y comparación con frío', () => {
  const r = (brazo, tarea, coste, sinCache, llamadas, ms, ok) => ({ brazo, tarea, acierto: ok,
    metricas: { coste, ms, turnos: 3, llamadas, exploracion: llamadas - 1, grafo: 0, tokens: { sinCache }, completo: true } });
  const md = B.informe([
    r('frio', 't1', 0.2, 1000, 10, 60000, true), r('frio', 't2', 0.4, 3000, 20, 120000, false),
    r('empuje', 't1', 0.1, 800, 6, 30000, true), r('empuje', 't2', 0.2, 1200, 8, 60000, true),
  ]);
  assert.match(md, /\| brazo \|/);
  const fila = (b) => md.split('\n').find((l) => l.startsWith(`| ${b} `));
  assert.match(fila('frio'), /\| 2 \|/, 'ejecuciones');
  assert.match(fila('frio'), /0\.300/, 'coste medio');
  assert.match(fila('frio'), /1\/2/, 'acierto');
  assert.match(fila('empuje'), /2\/2/);
  assert.match(fila('empuje'), /-50%/, 'coste frente a frío');
  assert.doesNotMatch(fila('frio'), /%/, 'frío es la referencia');
});

test('comprobar.js: sale 0 solo si RESPUESTA.md casa con todas las expresiones', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-banco-'));
  const script = path.join(RAIZ, 'bench', 'grafo', 'comprobar.js');
  const correr = (...a) => spawnSync(process.execPath, [script, ...a], { cwd: d, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(correr('x').status, 1, 'sin RESPUESTA.md falla');
  fs.writeFileSync(path.join(d, 'RESPUESTA.md'), 'TOPE_INDICE vale 20 MB en indice.js\n');
  assert.strictEqual(correr('indice\\.js', 'tope_indice', '20').status, 0);
  const r = correr('indice\\.js', 'cli\\.js');
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /cli/);
});

test('informe: sin ejecuciones lo dice', () => {
  assert.match(B.informe([]), /sin ejecuciones/i);
});
