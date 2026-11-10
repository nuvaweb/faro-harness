// CABLEADO del cierre determinista (#71): la regla unica (lib/tarea.js) solo sirve si la llaman los
// comandos que deciden (consolidar, publicar), el que vigila (vigilar) y los que avisan sin red
// (validate y la sesion, desde la cache). Si un comando la pierde, vuelve a haber dos verdades.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');
const SRC = fs.readFileSync(HARNESS, 'utf8');
const cuerpoDe = (nombre) => { const i = SRC.indexOf(`async function ${nombre}(`); return SRC.slice(i, SRC.indexOf('\n}', i)); };

test('consolidar y publicar CIERRAN y MARCAN con el reconciliador', () => {
  for (const f of ['cmdConsolidar', 'cmdPublicar']) {
    assert.match(cuerpoDe(f), /reconciliarTareas\(gh, \{ cerrar: true, marcar: true \}\)/, f);
  }
});

test('publicar reconcilia ANTES de la ligadura cambio<->tarea (asi no cancela por lo que ya esta hecho)', () => {
  const c = cuerpoDe('cmdPublicar');
  assert.ok(c.indexOf('reconciliarTareas') < c.indexOf('coherenciaCambioIssue'));
});

test('vigilar solo DETECTA (nunca cierra): deja la cache para sesion y validate', () => {
  const c = cuerpoDe('cmdVigilar');
  assert.match(c, /reconciliarTareas\(forjaMod\(\), \{ silencioso: !aPeticion \}\)/);
  assert.doesNotMatch(c, /cerrar: true/);
});

test('validate avisa [tareas] desde la CACHE, sin red', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-cache-tareas-'));
  const datos = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-datos-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), '---\nnombre: x\nclave: PRU\nobjetivo: x\nestado: in_progress\nfases_total: 1\nfase_actual: 1\nowner: t\n---\n### Fase 1 · Base — in_progress\nDesc.\nObjetivo: 2026-10-30\n\n- [ ] #12 · Login — @ana\n');
  const clave = dir.replace(/[^\w.-]+/g, '-');
  fs.writeFileSync(path.join(datos, `tareas-${clave}.json`), JSON.stringify({ ts: Date.now(), hechasSinCerrar: [12], sinEvidencia: [7] }));
  const r = spawnSync(process.execPath, [HARNESS, 'validate'], { cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_DATA: datos } });
  const out = `${r.stdout}${r.stderr}`;
  assert.match(out, /\[tareas\] 1 tarea\(s\) HECHAS sin cerrar.*#12/, out);
  assert.match(out, /\[tareas\] 1 tarea\(s\) cerradas SIN evidencia.*#7/, out);
});

test('validate avisa desde la cache: bandeja de entrada; las claves viejas del gestor solo avisan una vez (#218)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-cache-pm-'));
  const datos = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-datos-pm-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), '---\nnombre: x\nclave: PRU\nobjetivo: x\nestado: in_progress\nfases_total: 1\nfase_actual: 1\nowner: t\nclickup_epica: ABC-62\n---\n### Fase 1 · Base — in_progress\nDesc.\nObjetivo: 2026-10-30\n\n- [ ] #12 · Login — @ana\n');
  fs.writeFileSync(path.join(datos, `tareas-${dir.replace(/[^\w.-]+/g, '-')}.json`), JSON.stringify({ ts: Date.now(), hechasSinCerrar: [], sinEvidencia: [], bandeja: [9], pm: { hitosSinPm: ['Fase 1 — Base'], issuesSinPm: [12] } }));
  const r = spawnSync(process.execPath, [HARNESS, 'validate'], { cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_DATA: datos } });
  const out = `${r.stdout}${r.stderr}`;
  assert.match(out, /\[tareas\] 1 en la BANDEJA DE ENTRADA sin triar.*#9.*triaje --bandeja/, out);
  assert.doesNotMatch(out, /SIN hito/, 'sin hito no es un fallo: es la bandeja');
  assert.doesNotMatch(out, /Sin vinculo con el gestor/, 'el plugin ya no exige vinculo con ClickUp');
  assert.strictEqual((out.match(/conserva datos del gestor/g) || []).length, 1, out);
  assert.doesNotMatch(out.split('Avisos')[0], /gestor|clickup/i, 'las claves viejas no son un error');
});

test('consolidar ya no empuja a ningun gestor (#218): la planificacion es externa y FARO solo lee la forja', () => {
  const c = cuerpoDe('cmdConsolidar');
  assert.ok(c.includes('reconciliarTareas'));
  assert.doesNotMatch(SRC, /pushGestorSiProcede|'clickup', 'push'|coherenciaPm/);
});
