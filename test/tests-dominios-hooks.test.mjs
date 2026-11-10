// #178 — el hook TDD (lib/tdd.js) consume el servicio de dominios (lib/dominios.js):
//   - tdd-pre : codigo que no pertenece a ningun dominio -> aviso (hueco de cobertura funcional).
//   - tdd-stop: pide SOLO los tests de los dominios tocados (con sus hermanos si cambia el contrato),
//               no `npm test`; y contrasta el diff de tests con lo que el agente afirma (integridad).
//   - tdd-post: presupuesto visible — registra nº de tests y tiempo; avisa si se encadenan baterias completas.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'harness.js');

const escribir = (dir, rel, txt) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const hook = (dir, cmd, payload) => {
  const r = spawnSync(process.execPath, [HARNESS, cmd], {
    cwd: dir, encoding: 'utf8', timeout: 120000, windowsHide: true,
    input: JSON.stringify({ session_id: 'ses-1', cwd: dir, ...payload }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_DATA: path.join(os.tmpdir(), 'faro-domh-data', path.basename(dir)) },
  });
  return { out: r.stdout || '', err: r.stderr || '', status: r.status };
};
const preEdit = (dir, rel) => hook(dir, 'tdd-pre', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, rel), old_string: 'a', new_string: 'b' } });
const runVerde = (dir, command, salida = '') => hook(dir, 'tdd-post', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: salida, stderr: '', interrupted: false } });
const stop = (dir, extra = {}) => hook(dir, 'tdd-stop', { hook_event_name: 'Stop', stop_hook_active: false, ...extra });

const FARO = {
  tests: {
    comando: 'node --test',
    dominios: {
      clientes: { descripcion: 'Clientes', codigo: ['src/clientes/**'], tests: ['test/clientes.test.mjs'], contrato: ['src/clientes/index.js'] },
      pagos: { descripcion: 'Cobros', codigo: ['src/pagos/**'], tests: ['test/pagos.test.mjs'] },
    },
  },
};
function repoDominios(faro = FARO) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-domh-'));
  escribir(dir, 'ESTADO.md', '---\niniciativa: T\nfases_total: 1\nfase_actual: 1\n---\n### Fase 1 · Una — in_progress\n');
  escribir(dir, '.faro.json', JSON.stringify(faro));
  escribir(dir, 'package.json', JSON.stringify({ name: 'd', private: true, scripts: { test: 'node --test' } }));
  escribir(dir, 'src/clientes/index.js', "const { norm } = require('./interno.js'); module.exports = { alta: (x) => norm(x) };\n");
  escribir(dir, 'src/clientes/interno.js', 'module.exports = { norm: (x) => String(x).trim() };\n');
  escribir(dir, 'src/pagos/index.js', "const { alta } = require('../clientes/index.js'); module.exports = { cobrar: (c) => alta(c) };\n");
  escribir(dir, 'src/suelto/huerfano.js', 'module.exports = {};\n');
  escribir(dir, 'test/clientes.test.mjs', "import { alta } from '../src/clientes/index.js';\nimport assert from 'node:assert';\nassert.ok(alta);\nassert.ok(alta);\n");
  escribir(dir, 'test/pagos.test.mjs', "import { cobrar } from '../src/pagos/index.js';\nimport assert from 'node:assert';\nassert.ok(cobrar);\n");
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 'T'); git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

test('tdd-pre: codigo que no pertenece a ningun dominio avisa (una vez) como hueco de cobertura funcional', () => {
  const dir = repoDominios();
  const r = preEdit(dir, 'src/suelto/huerfano.js');
  assert.match(r.out, /ningún dominio/);
  assert.ok(r.out.split('\n').filter(Boolean).length === 1, 'una sola salida');
  assert.doesNotMatch(preEdit(dir, 'src/clientes/interno.js').out, /ningún dominio/);
});

test('tdd-stop: pide SOLO el dominio tocado (interior) y no la suite completa', () => {
  const dir = repoDominios();
  preEdit(dir, 'src/clientes/interno.js');
  const s = stop(dir);
  assert.strictEqual(s.status, 2, s.err);
  assert.match(s.err, /node --test test\/clientes\.test\.mjs/);
  assert.doesNotMatch(s.err, /pagos/);
  assert.doesNotMatch(s.err, /npm test/);
  // lo ejecuta en verde -> silencio
  runVerde(dir, 'node --test test/clientes.test.mjs');
  const s2 = stop(dir);
  assert.strictEqual(s2.status, 0, s2.err);
  assert.strictEqual(s2.out.trim(), '');
});

test('tdd-stop: un cambio en el CONTRATO pide tambien a los hermanos dependientes', () => {
  const dir = repoDominios();
  preEdit(dir, 'src/clientes/index.js');
  const s = stop(dir);
  assert.strictEqual(s.status, 2);
  assert.match(s.err, /test\/clientes\.test\.mjs/);
  assert.match(s.err, /test\/pagos\.test\.mjs/);
});

test('tdd-stop: el codigo sin dominio no pide la suite completa (#237)', () => {
  const dir = repoDominios();
  preEdit(dir, 'src/suelto/huerfano.js');
  const s = stop(dir);
  assert.strictEqual(s.status, 0, s.out + s.err);
  assert.doesNotMatch(s.out + s.err, /npm test/);
});

test('tdd-post: presupuesto visible — avisa al encadenar baterias completas, no cuando se ejecuta un dominio', () => {
  const dir = repoDominios();
  const salida = 'ℹ tests 600\nℹ pass 600\nℹ duration_ms 45000\n';
  assert.strictEqual(runVerde(dir, 'npm test', salida).out.trim(), '', 'una bateria completa: sin aviso');
  assert.strictEqual(runVerde(dir, 'node --test test/pagos.test.mjs', 'ℹ tests 3\nℹ duration_ms 120\n').out.trim(), '', 'un dominio no cuenta');
  const r = runVerde(dir, 'npm test', salida);
  assert.match(r.out, /Presupuesto de tests/);
  assert.match(r.out, /2 baterías completas/);
  assert.match(r.out, /tests-dominios --afectados/);
  assert.strictEqual(runVerde(dir, 'npm test', salida).out.trim(), '', 'no se repite');
});

test('tdd-post: baterias pequenas encadenadas no molestan', () => {
  const dir = repoDominios();
  for (let i = 0; i < 3; i++) assert.strictEqual(runVerde(dir, 'npm test', 'ℹ tests 5\nℹ duration_ms 300\n').out.trim(), '');
});

// ---------- integridad en el Stop ----------

function conTestEditado(modo) {
  const dir = repoDominios(modo ? { ...FARO, tdd: { modo } } : FARO);
  preEdit(dir, 'test/clientes.test.mjs');                                     // la sesion toca un test
  escribir(dir, 'test/clientes.test.mjs', "import { alta } from '../src/clientes/index.js';\nimport assert from 'node:assert';\nassert.ok(alta);\n");   // quita una asercion
  return dir;
}

test('tdd-stop integridad: una asercion eliminada se contrasta con lo que el agente afirma y BLOQUEA si lo contradice', () => {
  const dir = conTestEditado();
  const s = stop(dir, { last_assistant_message: 'Solo añadí un doble de prueba, no rebajé aserciones.' });
  assert.strictEqual(s.status, 2, s.out + s.err);
  assert.match(s.err, /aserciones eliminadas/);
  assert.match(s.err, /no rebaj/i);
  assert.ok(s.err.trim().split('\n').length <= 4, 'mensaje corto');
  assert.strictEqual(stop(dir, { last_assistant_message: 'Solo añadí un doble de prueba, no rebajé aserciones.' }).status, 0, 'no se repite');
});

test('tdd-stop integridad: sin afirmacion contradictoria, modo aviso solo informa al humano; modo bloqueo devuelve el control', () => {
  const aviso = stop(conTestEditado());
  assert.strictEqual(aviso.status, 0);
  assert.match(aviso.out, /systemMessage/);
  assert.match(aviso.out, /aserciones eliminadas/);
  const bloqueo = stop(conTestEditado('bloqueo'));
  assert.strictEqual(bloqueo.status, 2);
  assert.match(bloqueo.err, /aserciones eliminadas/);
});

test('tdd-stop integridad: tests tocados sin debilitar -> silencio', () => {
  const dir = repoDominios();
  preEdit(dir, 'test/clientes.test.mjs');
  escribir(dir, 'test/clientes.test.mjs', "import { alta } from '../src/clientes/index.js';\nimport assert from 'node:assert';\nassert.ok(alta);\nassert.ok(alta);\nassert.ok(alta);\n");
  const s = stop(dir, { last_assistant_message: 'Añadí una aserción.' });
  assert.strictEqual(s.status, 0);
  assert.strictEqual(s.out.trim(), '');
});

test('tdd-stop integridad: sin last_assistant_message, la afirmacion se lee del final de la transcripcion', () => {
  const dir = conTestEditado();
  const tr = path.join(dir, '..', `transcripcion-${path.basename(dir)}.jsonl`);
  fs.writeFileSync(tr, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'arregla' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Listo, no rebajé aserciones.' }] } }),
  ].join('\n'));
  const s = stop(dir, { transcript_path: path.resolve(tr) });
  assert.strictEqual(s.status, 2, s.out + s.err);
  assert.match(s.err, /no rebaj/i);
});
