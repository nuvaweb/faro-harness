// MARCADOR DE GESTOR generico (#72): '[pm:ID]' (y '[pm:<sistema>:ID]') ademas del historico
// '[cu:ID]'. El parser solo entendia '[cu:...]' al final de la cabecera de fase: con '[pm:...]' la
// fase DESAPARECIA en silencio, y en las tareas el marcador se colaba en el nombre de la tarjeta (que
// es por donde se empareja) y duplicaba tarjetas. Un solo reconocedor, usado en todos los sitios.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { cerrarFaseEnTexto, RE_MARCA_PM, sinMarcaPm } = require(path.join(HOOKS, 'lib', 'estado.js'));

const estadoJson = (fases) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-marca-pm-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), `---\nnombre: x\nclave: PRU\nobjetivo: x\nestado: in_progress\nfases_total: 2\nfase_actual: 1\nowner: t\n---\n${fases}`);
  const r = spawnSync(process.execPath, [path.join(HOOKS, 'harness.js'), 'estado-json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  return JSON.parse(r.stdout);
};

const FASES = `### Fase 1 · Base — in_progress [pm:86abc123]
Desc.
Objetivo: 2026-10-30

- [ ] #12 · Login — @ana [pm:clickup:86def456]
- [ ] #13 · Otra — @luis [cu:86ghi789]

### Fase 2 · Resto — pending [cu:86jkl000]
Desc.
Objetivo: 2026-12-01

- [ ] #14 · Mas — @ana
`;

test('una fase con [pm:...] NO desaparece, y se lee su id (tambien [cu:...])', () => {
  const j = estadoJson(FASES);
  assert.strictEqual(j.fases.length, 2, JSON.stringify(j.fases));
  assert.strictEqual(j.fases[0].clickup, '86abc123');
  assert.strictEqual(j.fases[1].clickup, '86jkl000');
});

test('las tareas leen [pm:...], [pm:sistema:...] y [cu:...], y el marcador NO se cuela en el texto', () => {
  const t = estadoJson(FASES).fases[0].tareas;
  assert.strictEqual(t[0].clickup, '86def456');
  assert.strictEqual(t[1].clickup, '86ghi789');
  for (const x of t) assert.doesNotMatch(x.texto, /\[(cu|pm):/, x.texto);
});

test('cerrarFaseEnTexto encuentra la fase aunque lleve [pm:...]', () => {
  const doc = `---\nfases_total: 1\nfase_actual: 1\n---\n### Fase 1 · Base — in_progress [pm:86abc123]\n- [x] #1 · a — @b\n`;
  const out = cerrarFaseEnTexto(doc, 1, 1);
  assert.match(out, /### Fase 1 · Base — done \[pm:86abc123\]/, out);
});

test('reconocedor unico: cu, pm y pm:sistema; sinMarcaPm limpia el nombre', () => {
  for (const s of ['[cu:86a]', '[pm:86a]', '[pm:clickup:86a]', '[pm:jira:PROJ-12]']) assert.match(s, RE_MARCA_PM, s);
  assert.doesNotMatch('[resp: a@b.c]', RE_MARCA_PM);
  assert.strictEqual(sinMarcaPm('#12 · Login — @ana [pm:clickup:86def456]'), '#12 · Login — @ana');
});

test('cabecera generica: pm_epica (sistema clickup o sin sistema) se entiende como la epica del gestor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-pm-epica-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), '---\nnombre: x\nclave: PRU\nobjetivo: x\nestado: in_progress\nfases_total: 1\nfase_actual: 1\nowner: t\npm_sistema: clickup\npm_epica: ABC-62\n---\n### Fase 1 · Base — in_progress\nDesc.\n\n- [ ] #1 · a — @b\n');
  const r = spawnSync(process.execPath, [path.join(HOOKS, 'harness.js'), 'session'], { cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /ClickUp SIN configurar/, 'con pm_epica no debe decir que falta configurar el gestor');
});
