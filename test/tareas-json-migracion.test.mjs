// #149 (parte 2) — MIGRACION del historico a gestion/tareas/<N>.json y ESTADO.md como INDICE GENERADO.
//
//   harness.js tarea migrar [--dry-run] [--confirmo] [--incluir-cerradas]
//   harness.js estado-indice [--comprobar|--escribir]
//
// La forja se SIMULA (objetos con la forma de la API de GitHub); nunca se toca la red.
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
const HARNESS = path.join(HOOKS, 'harness.js');
const require = createRequire(import.meta.url);
const tj = require(path.join(HOOKS, 'lib', 'tareas-json.js'));
const vj = require(path.join(HOOKS, 'lib', 'validador-json.js'));
const mig = require(path.join(HOOKS, 'lib', 'tareas-migracion.js'));
const idx = require(path.join(HOOKS, 'lib', 'estado-indice.js'));
const ciclo = require(path.join(HOOKS, 'lib', 'ciclo.js'));
const SCHEMA = JSON.parse(fs.readFileSync(path.join(HOOKS, 'tarea.schema.json'), 'utf8'));

const AHORA = new Date('2026-10-11T10:00:00Z');

const ESTADO = `---
iniciativa: Demo
fases_total: 2
fase_actual: 2
owner: t
---

### Fase 1 · Primera — done
Cerrada.
Objetivo: 2026-09-30
- [x] #1 · Cimientos del repo — @ana
- [x] Trabajo antiguo sin issue — @ana

### Fase 2 · Segunda — in_progress
En marcha.
Objetivo: 2026-10-31
- [ ] #7 · Mejora del branding — @luis [cu:abc123]
- [ ] #8 · Informe de cobertura (REQ-05) — @ana
`;

const PROPOSAL = (issue, estado) => `---\ntitulo: x\nestado: ${estado}\nfase: transversal\n${issue ? `issue: ${issue}\n` : ''}---\n\n## Por que\nx\n`;

function repo({ estado = ESTADO, cambios = {}, archivo = {}, tareas = {}, crlf = false } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-mig-'));
  const sh = (...a) => spawnSync('git', a, { cwd: d, encoding: 'utf8' });
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 't@t.t'); sh('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'ESTADO.md'), crlf ? estado.replace(/\n/g, '\r\n') : estado);
  const ch = path.join(d, 'gestion', 'cambios', 'changes');
  for (const [slug, [issue, est, tasks]] of Object.entries(cambios)) {
    fs.mkdirSync(path.join(ch, slug), { recursive: true });
    fs.writeFileSync(path.join(ch, slug, 'proposal.md'), PROPOSAL(issue, est));
    if (tasks) fs.writeFileSync(path.join(ch, slug, 'tasks.md'), tasks);
  }
  for (const [slug, [issue, est]] of Object.entries(archivo)) {
    fs.mkdirSync(path.join(ch, 'archive', slug), { recursive: true });
    fs.writeFileSync(path.join(ch, 'archive', slug, 'proposal.md'), PROPOSAL(issue, est));
  }
  if (Object.keys(tareas).length) {
    fs.mkdirSync(path.join(d, 'gestion', 'tareas'), { recursive: true });
    for (const [id, r] of Object.entries(tareas)) fs.writeFileSync(path.join(d, 'gestion', 'tareas', `${id}.json`), JSON.stringify(r, null, 2) + '\n');
  }
  sh('add', '-A'); sh('commit', '-q', '-m', 'init');
  return d;
}
const harness = (d, ...a) => spawnSync(process.execPath, [HARNESS, ...a], { cwd: d, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: d, GH_TOKEN: '', GITHUB_TOKEN: '', FARO_TOKEN: '' } });
const leerJson = (d, id) => JSON.parse(fs.readFileSync(path.join(d, 'gestion', 'tareas', `${id}.json`), 'utf8'));
const textoTarea = (d, id) => fs.readFileSync(path.join(d, 'gestion', 'tareas', `${id}.json`), 'utf8');

// ---- forja simulada (forma de la API de GitHub) ----
const issue = (n, o = {}) => ({
  number: n, title: `Issue ${n}`, state: 'open', state_reason: null, body: '', labels: [], assignee: null, assignees: [],
  milestone: null, created_at: '2026-10-01T09:00:00Z', closed_at: null, ...o,
});
const pr = (n, o = {}) => ({ number: n, title: `PR ${n}`, body: '', state: 'closed', merged_at: '2026-10-05T12:00:00Z', base: { ref: 'develop' }, head: { ref: `feat/${n}-x` }, ...o });
const CUERPO_7 = `## Objetivo\nQue la pagina use la marca nueva\ny sea coherente.\n\n## Alcance\nTodo.\n\n## Subtareas\n- [x] Colores\n- [x] Favicon\n- [ ] Traducciones\n\n## Criterios de aceptacion\n- [ ] Se ve bien\n`;

// ---------- esquema: responsable ----------

test('el esquema acepta responsable (login o null) de forma aditiva: sin el, el registro sigue valido', () => {
  const base = { v: 1, issue: 7, titulo: 'T', fase: 2, estado: 'en_curso', objetivo: 'O', resultado: null, justificacion: null, requisitos: [], cambios: [], prs: [], fechas: { creada: null, inicio: null, objetivo: null, cerrada: null, actualizada: '2026-10-11T10:00:00Z' }, subtareas: { hechas: 0, total: 0, fuente: [] } };
  assert.deepStrictEqual(vj.validar(SCHEMA, base), []);
  assert.deepStrictEqual(vj.validar(SCHEMA, { ...base, responsable: 'ana-b' }), []);
  assert.deepStrictEqual(vj.validar(SCHEMA, { ...base, responsable: null }), []);
  assert.ok(vj.validar(SCHEMA, { ...base, responsable: 'a b; rm -rf' }).some((e) => e.startsWith('responsable')));
});

// ---------- lectura de fuentes ----------

test('lee las lineas de fase: solo las que llevan #N propio generan registro; el resto se informa', () => {
  const d = repo();
  const { lineas, sinId } = mig.leerLineas(d);
  assert.deepStrictEqual(lineas.map((l) => [l.id, l.fase, l.hecha, l.quien]), [['1', 1, true, 'ana'], ['7', 2, false, 'luis'], ['8', 2, false, 'ana']]);
  assert.strictEqual(lineas.find((l) => l.id === '8').titulo, 'Informe de cobertura (REQ-05)');
  assert.strictEqual(sinId.length, 1);
  assert.match(sinId[0].texto, /Trabajo antiguo/);
});

test('un resto de referencia ajena (observabilidad#55) no se toma por un issue propio', () => {
  const d = repo({ estado: ESTADO.replace('- [ ] #8 ·', '- [ ] observabilidad#55 ·') });
  const { lineas, sinId } = mig.leerLineas(d);
  assert.ok(!lineas.some((l) => l.id === '55'));
  assert.ok(sinId.some((l) => /observabilidad#55/.test(l.texto)));
});

test('cambios spec-driven: proposal issue N (activos y archivados) y su avance de tasks.md', () => {
  const d = repo({ cambios: { 'a-uno': [7, 'aprobada', '- [x] a\n- [ ] b\n'], huerfano: [null, 'borrador'], 'a;rm': [7, 'aprobada'] }, archivo: { 'viejo-uno': [1, 'implementada'] } });
  const c = mig.leerCambios(d);
  assert.deepStrictEqual(c.map((x) => [x.slug, x.issue, x.estado]).sort(), [['a-uno', 7, 'aprobado'], ['viejo-uno', 1, 'archivado']]);
  assert.deepStrictEqual(c.find((x) => x.slug === 'a-uno').tareas, { hechas: 1, total: 2 });
});

test('cuerpo del issue: seccion Objetivo y checklist de la seccion Subtareas', () => {
  assert.strictEqual(mig.seccionObjetivo(CUERPO_7), 'Que la pagina use la marca nueva y sea coherente.');
  assert.strictEqual(mig.seccionObjetivo('sin seccion'), null);
  assert.deepStrictEqual(mig.subtareasDeCuerpo(CUERPO_7), { hechas: 2, total: 3 });
  assert.deepStrictEqual(mig.subtareasDeCuerpo('- [x] a\n- [ ] b\n'), { hechas: 1, total: 2 }, 'sin seccion: todos los checkboxes');
  assert.deepStrictEqual(mig.subtareasDeCuerpo(''), { hechas: 0, total: 0 });
  // marcadores de ejemplo de la plantilla del issue: no son un objetivo ni una subtarea
  assert.strictEqual(mig.seccionObjetivo('## Objetivo\n<que se consigue con esto, en una frase>\n\n## Alcance\nx'), null);
  assert.deepStrictEqual(mig.subtareasDeCuerpo('## Subtareas\n- [ ] <paso>\n- [x] Real\n'), { hechas: 1, total: 1 });
});

// ---------- plan ----------

test('OFFLINE: solo ESTADO.md + cambios; nada inventado y todo lo dudoso en revisar', () => {
  const d = repo({ cambios: { 'a-uno': [7, 'aprobada', '- [x] a\n- [ ] b\n'] }, archivo: { 'viejo-uno': [1, 'implementada'] } });
  const plan = mig.construirPlan(d, { forja: null, ahora: AHORA });
  assert.strictEqual(plan.offline, true);
  assert.deepStrictEqual(plan.registros.map((r) => r.id), ['1', '7', '8', 'L-1']);
  const r7 = plan.registros.find((r) => r.id === '7').registro;
  assert.strictEqual(r7.titulo, 'Mejora del branding');
  assert.strictEqual(r7.fase, 2);
  assert.strictEqual(r7.responsable, 'luis');
  assert.strictEqual(r7.estado, 'pendiente');
  assert.strictEqual(r7.resultado, null);
  assert.strictEqual(r7.fechas.creada, null);
  assert.deepStrictEqual(r7.cambios, [{ slug: 'a-uno', estado: 'aprobado' }]);
  assert.deepStrictEqual(r7.subtareas, { hechas: 1, total: 2, fuente: ['tasks:a-uno'] });
  assert.strictEqual(r7.origen.tipo, 'migrada');
  for (const c of ['objetivo', 'estado', 'fechas.creada']) assert.ok(r7.origen.revisar.includes(c), `revisar debe incluir ${c}: ${r7.origen.revisar}`);
  const r1 = plan.registros.find((r) => r.id === '1').registro;
  assert.strictEqual(r1.estado, 'hecha');
  assert.deepStrictEqual(r1.cambios, [{ slug: 'viejo-uno', estado: 'archivado' }]);
  assert.ok(r1.origen.revisar.includes('resultado') && r1.origen.revisar.includes('fechas.cerrada'));
  assert.deepStrictEqual(vj.validar(SCHEMA, r1), [], 'el registro migrado cumple el esquema');
  assert.strictEqual(plan.resumen.dudosos, 4);
  assert.strictEqual(plan.sinId.length, 1);
});

test('el REQ-NN citado en la linea o en el issue pasa a requisitos', () => {
  const d = repo();
  const plan = mig.construirPlan(d, { forja: null, ahora: AHORA });
  assert.deepStrictEqual(plan.registros.find((r) => r.id === '8').registro.requisitos, ['REQ-05']);
  const forja = { issues: [issue(7, { body: 'Cubre REQ-01 y REQ-12.' })], prs: [] };
  assert.deepStrictEqual(mig.construirPlan(d, { forja, ahora: AHORA }).registros.find((r) => r.id === '7').registro.requisitos, ['REQ-01', 'REQ-12']);
});

test('CON FORJA: titulo, estado, fase por hito, apps, fechas, responsable, objetivo, subtareas y PR', () => {
  const d = repo({ cambios: { 'a-uno': [7, 'aprobada'] } });
  const forja = {
    issues: [
      issue(7, { title: 'Mejora del branding de la pagina', body: CUERPO_7, labels: [{ name: 'enhancement' }, { name: 'app:web' }], assignee: { login: 'luis-g' }, milestone: { title: 'Fase 2 — Segunda' } }),
      issue(1, { title: 'Cimientos del repo', state: 'closed', state_reason: 'completed', closed_at: '2026-09-20T08:00:00Z', created_at: '2026-09-01T08:00:00Z', milestone: { title: 'Fase 1 — Primera' } }),
    ],
    prs: [pr(11, { title: 'feat: cimientos del repo', body: 'Closes #1', head: { ref: 'feat/1-cimientos' } }), pr(12, { title: 'wip branding', state: 'open', merged_at: null, head: { ref: 'feat/7-branding' } })],
  };
  const plan = mig.construirPlan(d, { forja, ahora: AHORA });
  assert.strictEqual(plan.offline, false);
  const r7 = plan.registros.find((r) => r.id === '7').registro;
  assert.strictEqual(r7.titulo, 'Mejora del branding de la pagina');
  assert.strictEqual(r7.objetivo, 'Que la pagina use la marca nueva y sea coherente.');
  assert.deepStrictEqual(r7.apps, ['web']);
  assert.strictEqual(r7.responsable, 'luis-g');
  assert.strictEqual(r7.estado, 'en_curso', 'tiene un PR abierto');
  assert.deepStrictEqual(r7.prs, [12]);
  assert.strictEqual(r7.fechas.creada, '2026-10-01');
  assert.deepStrictEqual(r7.subtareas, { hechas: 2, total: 3, fuente: ['issue'] });
  assert.ok(!r7.origen.revisar.includes('objetivo') && !r7.origen.revisar.includes('estado'), String(r7.origen.revisar));
  const r1 = plan.registros.find((r) => r.id === '1').registro;
  assert.strictEqual(r1.estado, 'hecha');
  assert.strictEqual(r1.resultado, 'feat: cimientos del repo', 'resultado inicial = titulo del PR que la cerro');
  assert.deepStrictEqual(r1.prs, [11]);
  assert.strictEqual(r1.fechas.cerrada, '2026-09-20');
  assert.ok(r1.origen.revisar.includes('objetivo'), 'sin seccion Objetivo: se usa el titulo como marcador y se marca');
  assert.strictEqual(r1.objetivo, 'Cimientos del repo');
});

test('cerrada como no planificada = descartada, con la justificacion marcada para revisar (no se inventa)', () => {
  const d = repo();
  const forja = { issues: [issue(8, { state: 'closed', state_reason: 'not_planned', closed_at: '2026-10-02T00:00:00Z', milestone: { title: 'Fase 2 — Segunda' } })], prs: [] };
  const r8 = mig.construirPlan(d, { forja, ahora: AHORA }).registros.find((r) => r.id === '8').registro;
  assert.strictEqual(r8.estado, 'descartada');
  assert.strictEqual(r8.justificacion, null);
  assert.ok(r8.origen.revisar.includes('justificacion'));
});

test('hecha sin PR que la respalde: resultado null y marcado para revisar', () => {
  const d = repo();
  const forja = { issues: [issue(1, { state: 'closed', closed_at: '2026-09-20T00:00:00Z' })], prs: [] };
  const r1 = mig.construirPlan(d, { forja, ahora: AHORA }).registros.find((r) => r.id === '1').registro;
  assert.strictEqual(r1.resultado, null);
  assert.ok(r1.origen.revisar.includes('resultado'));
});

test('issues de la forja fuera de ESTADO.md: solo con --incluir-cerradas se migran los cerrados; fase por hito o 0 a revisar', () => {
  const d = repo();
  const forja = { issues: [issue(30, { state: 'closed', closed_at: '2026-09-01T00:00:00Z', milestone: { title: 'Fase 1 — Primera' } }), issue(31), issue(32, { state: 'closed', closed_at: '2026-09-02T00:00:00Z' })], prs: [] };
  const sin = mig.construirPlan(d, { forja, ahora: AHORA });
  assert.deepStrictEqual(sin.registros.map((r) => r.id), ['1', '7', '8', '31', 'L-1']);
  assert.strictEqual(sin.registros.find((r) => r.id === '31').registro.fase, 0);
  assert.ok(sin.registros.find((r) => r.id === '31').registro.origen.revisar.includes('fase'));
  const con = mig.construirPlan(d, { forja, ahora: AHORA, incluirCerradas: true });
  assert.deepStrictEqual(con.registros.map((r) => r.id), ['1', '7', '8', '30', '31', '32', 'L-1']);
  assert.strictEqual(con.registros.find((r) => r.id === '30').registro.fase, 1);
});

test('monorepo: sin etiqueta app:<id> el registro queda con apps a revisar', () => {
  const d = repo();
  fs.mkdirSync(path.join(d, 'apps', 'web'), { recursive: true });
  fs.writeFileSync(path.join(d, 'apps', 'web', 'package.json'), '{}');
  fs.writeFileSync(path.join(d, '.faro.json'), JSON.stringify({ monorepo: {} }));
  const apps = require(path.join(HOOKS, 'lib', 'apps.js'));
  assert.ok(apps.esMonorepo(d));
  const r7 = mig.construirPlan(d, { forja: null, ahora: AHORA }).registros.find((r) => r.id === '7').registro;
  assert.ok(r7.origen.revisar.includes('apps'));
});

test('un numero de issue o un login raros de la forja no llegan al disco', () => {
  const d = repo();
  const forja = { issues: [issue('../x', { state: 'closed' }), issue(7, { assignee: { login: 'a b;rm -rf' } })], prs: [pr('9;x', { head: { ref: 'feat/7-y' } })] };
  const plan = mig.construirPlan(d, { forja, ahora: AHORA, incluirCerradas: true });
  assert.ok(!plan.registros.some((r) => r.id.includes('.')));
  const r7 = plan.registros.find((r) => r.id === '7').registro;
  assert.strictEqual(r7.responsable, 'luis', 'login no valido de la forja: se queda el de la linea');
  assert.deepStrictEqual(r7.prs, []);
});

// ---------- aplicar e idempotencia ----------

test('aplicar escribe registros validos, y volver a migrar no cambia ni un byte', () => {
  const d = repo({ cambios: { 'a-uno': [7, 'aprobada'] } });
  const forja = { issues: [issue(7, { body: CUERPO_7 })], prs: [] };
  const plan = mig.construirPlan(d, { forja, ahora: AHORA });
  const r = mig.aplicar(d, plan, { ahora: AHORA });
  assert.deepStrictEqual(r.errores, []);
  assert.deepStrictEqual(tj.listar(d), ['1', '7', '8', 'L-1']);
  for (const id of tj.listar(d)) assert.deepStrictEqual(tj.validarEstructura(tj.leer(d, id)), []);
  const antes = tj.listar(d).map((id) => textoTarea(d, id));
  const plan2 = mig.construirPlan(d, { forja, ahora: AHORA });
  assert.ok(plan2.registros.every((x) => x.accion === 'igual'), plan2.registros.map((x) => x.accion).join());
  mig.aplicar(d, plan2, { ahora: new Date('2027-01-01T00:00:00Z') });
  assert.deepStrictEqual(tj.listar(d).map((id) => textoTarea(d, id)), antes);
});

test('un registro editado a mano (sin origen migrada) NUNCA se pisa', () => {
  const mano = { v: 1, issue: 7, titulo: 'Titulo a mano', fase: 2, estado: 'en_curso', objetivo: 'Objetivo a mano', resultado: null, justificacion: null, requisitos: [], cambios: [], prs: [], fechas: { creada: null, inicio: null, objetivo: null, cerrada: null, actualizada: '2026-10-10T00:00:00Z' }, subtareas: { hechas: 0, total: 0, fuente: [] } };
  const d = repo({ tareas: { 7: mano } });
  const antes = textoTarea(d, 7);
  const plan = mig.construirPlan(d, { forja: { issues: [issue(7, { title: 'Otro titulo', body: CUERPO_7 })], prs: [] }, ahora: AHORA });
  assert.strictEqual(plan.registros.find((r) => r.id === '7').accion, 'omitir');
  mig.aplicar(d, plan, { ahora: AHORA });
  assert.strictEqual(textoTarea(d, 7), antes);
  assert.ok(tj.listar(d).includes('1'), 'los demas si se crean');
});

test('un migrado se actualiza solo en los campos aun por revisar; lo revisado se respeta', () => {
  const d = repo();
  mig.aplicar(d, mig.construirPlan(d, { forja: null, ahora: AHORA }), { ahora: AHORA });
  // una persona revisa el titulo (lo cambia) y deja objetivo por revisar
  const r = leerJson(d, 7);
  r.titulo = 'Titulo revisado por una persona';
  fs.writeFileSync(path.join(d, 'gestion', 'tareas', '7.json'), JSON.stringify(r, null, 2) + '\n');
  const forja = { issues: [issue(7, { title: 'Titulo de la forja', body: CUERPO_7, created_at: '2026-10-01T00:00:00Z' })], prs: [] };
  const plan = mig.construirPlan(d, { forja, ahora: AHORA });
  assert.strictEqual(plan.registros.find((x) => x.id === '7').accion, 'actualizar');
  mig.aplicar(d, plan, { ahora: AHORA });
  const n = leerJson(d, 7);
  assert.strictEqual(n.titulo, 'Titulo revisado por una persona', 'titulo ya revisado (fuera de revisar... no se toca)');
  assert.strictEqual(n.objetivo, 'Que la pagina use la marca nueva y sea coherente.', 'objetivo estaba en revisar y ahora se deduce');
  assert.ok(!n.origen.revisar.includes('objetivo'));
  assert.strictEqual(n.fechas.creada, '2026-10-01');
  assert.deepStrictEqual(n.subtareas, { hechas: 2, total: 3, fuente: ['issue'] });
});

// ---------- CLI ----------

test('tarea migrar sin --confirmo solo ensena el plan y no escribe', () => {
  const d = repo();
  const r = harness(d, 'tarea', 'migrar');
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /4 registro/);
  assert.match(r.stdout, /offline|sin forja/i);
  assert.match(r.stdout, /--confirmo/);
  assert.ok(!fs.existsSync(path.join(d, 'gestion', 'tareas')));
  const r2 = harness(d, 'tarea', 'migrar', '--dry-run', '--confirmo');
  assert.strictEqual(r2.status, 0);
  assert.ok(!fs.existsSync(path.join(d, 'gestion', 'tareas')), '--dry-run gana a --confirmo');
});

test('tarea migrar --confirmo escribe los registros y validate los muestra como pendientes de revisar', () => {
  const d = repo();
  const r = harness(d, 'tarea', 'migrar', '--confirmo');
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.deepStrictEqual(tj.listar(d), ['1', '7', '8', 'L-1']);
  const v = harness(d, 'validate');
  assert.match(v.stdout + v.stderr, /pendiente\(s\) de revisar|pendientes? de revisar/i);
  const val = harness(d, 'tarea', 'validar');
  assert.match(val.stdout, /#7.*objetivo/);
  const again = harness(d, 'tarea', 'migrar', '--confirmo');
  assert.match(again.stdout, /sin cambios|3 igual/i);
});

test('tarea migrar con argumento desconocido falla con el uso', () => {
  const d = repo();
  const r = harness(d, 'tarea', 'migrar', '--loquesea');
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /uso/i);
});

// ---------- estado-indice ----------

const reg = (id, o = {}) => ({
  v: 1, issue: Number(id), titulo: `Titulo ${id}`, fase: 2, estado: 'pendiente', objetivo: 'O', resultado: null, justificacion: null,
  requisitos: [], cambios: [], prs: [], responsable: 'ana', fechas: { creada: null, inicio: null, objetivo: null, cerrada: null, actualizada: '2026-10-11T10:00:00Z' },
  subtareas: { hechas: 0, total: 0, fuente: [] }, ...o,
});

test('estado-indice: regenera SOLO las lineas de tarea y respeta byte a byte el resto', () => {
  const regs = [reg(7, { titulo: 'Branding', estado: 'hecha', responsable: 'luis' }), reg(8, { estado: 'descartada' }), reg(1, { fase: 1, estado: 'hecha', titulo: 'Cimientos del repo' })];
  const { texto, cambios } = idx.regenerar(ESTADO, regs);
  const antes = ESTADO.split('\n'); const despues = texto.split('\n');
  assert.strictEqual(antes.length, despues.length);
  const difieren = antes.map((l, i) => (l === despues[i] ? null : i)).filter((i) => i !== null);
  for (const i of difieren) assert.match(antes[i], /^- \[[ x]\] #\d+/, 'solo cambian lineas de tarea');
  assert.match(texto, /^- \[x\] #7 · Branding — @luis \[cu:abc123\]$/m, 'conserva el marcador de ClickUp');
  assert.match(texto, /^- \[x\] #8 · Titulo 8 — @ana$/m, 'descartada => [x]');
  assert.match(texto, /^- \[x\] Trabajo antiguo sin issue — @ana$/m, 'sin #N: intacta');
  assert.ok(cambios.length >= 2);
});

test('estado-indice: finales de linea CRLF y LF se conservan; idempotente', () => {
  for (const crlf of [false, true]) {
    const base = crlf ? ESTADO.replace(/\n/g, '\r\n') : ESTADO;
    const regs = [reg(7, { titulo: 'Mejora del branding', responsable: 'luis' }), reg(8, { titulo: 'Informe de cobertura (REQ-05)' }), reg(1, { fase: 1, estado: 'hecha', titulo: 'Cimientos del repo' })];
    const { texto } = idx.regenerar(base, regs);
    assert.strictEqual(texto, base, `ya canonico => identico (crlf=${crlf})`);
    const cambiado = idx.regenerar(base, [reg(7, { titulo: 'Nuevo', responsable: 'luis' }), ...regs.slice(1)]).texto;
    assert.strictEqual(/\r\n/.test(cambiado), crlf);
    assert.strictEqual(cambiado.split(crlf ? '\r\n' : '\n').length, base.split(crlf ? '\r\n' : '\n').length);
    assert.strictEqual(idx.regenerar(cambiado, [reg(7, { titulo: 'Nuevo', responsable: 'luis' }), ...regs.slice(1)]).texto, cambiado);
  }
});

test('estado-indice: un registro sin linea se anade a su fase; una linea cuyo registro vive en otra fase se mueve', () => {
  const { texto } = idx.regenerar(ESTADO, [reg(9, { titulo: 'Nueva' }), reg(8, { fase: 1, titulo: 'Informe de cobertura (REQ-05)' })]);
  const f2 = texto.slice(texto.indexOf('### Fase 2'));
  const f1 = texto.slice(texto.indexOf('### Fase 1'), texto.indexOf('### Fase 2'));
  assert.match(f2, /- \[ \] #9 · Nueva — @ana/);
  assert.doesNotMatch(f2, /#8 ·/);
  assert.match(f1, /- \[ \] #8 · Informe de cobertura \(REQ-05\) — @ana/);
  assert.match(f2, /#7 · Mejora del branding — @luis \[cu:abc123\]/, 'sin registro: linea intacta');
});

test('estado-indice: sin responsable no se escribe @', () => {
  const { texto } = idx.regenerar(ESTADO, [reg(8, { responsable: null, titulo: 'Informe de cobertura (REQ-05)' })]);
  assert.match(texto, /^- \[ \] #8 · Informe de cobertura \(REQ-05\)$/m);
});

test('COMPATIBILIDAD: las lineas generadas las entienden refDeTarea, contabilidadFase y huecosDeFase', () => {
  const regs = [reg(12, { titulo: 'Identidad y marca (REQ-02)', estado: 'hecha', responsable: 'ana-b' }), reg(13, { titulo: 'Pantallas del informe', responsable: 'luis.g' })];
  const lineas = idx.lineasDe(regs);
  assert.deepStrictEqual(lineas, ['- [x] #12 · Identidad y marca (REQ-02) — @ana-b', '- [ ] #13 · Pantallas del informe — @luis.g']);
  const refs = lineas.map((l) => ciclo.refDeTarea(l));
  assert.deepStrictEqual(refs.map((r) => [r.issue, r.quien, r.titulo]), [['12', 'ana-b', 'Identidad y marca (REQ-02)'], ['13', 'luis.g', 'Pantallas del informe']]);
  const fase = { num: 2, estado: 'in_progress', descripcion: 'Algo', objetivo: '2026-10-31', tareas: lineas.map((l) => ({ done: /^- \[x\]/.test(l), text: l.replace(/^- \[[ x]\]\s*/, '') })) };
  assert.deepStrictEqual(ciclo.huecosDeFase(fase), []);
  const c = ciclo.contabilidadFase(fase, { 12: 'closed', 13: 'open' });
  assert.deepStrictEqual([c.total, c.hechas, c.conIssue, c.conResponsable, c.desajustes], [2, 1, 2, 2, []]);
  const des = ciclo.desajustesDelFaseo([fase], { 12: 'open', 13: 'open' });
  assert.ok(des.some((x) => /#12/.test(x)), 'el checkbox derivado se cruza con la forja como siempre');
});

test('COMPATIBILIDAD: validate acepta un ESTADO.md regenerado (sin huecos de faseo nuevos)', () => {
  const d = repo();
  const antes = harness(d, 'validate');
  harness(d, 'tarea', 'migrar', '--confirmo');
  assert.strictEqual(harness(d, 'estado-indice', '--escribir').status, 0);
  const despues = harness(d, 'validate');
  const faseo = (r) => (r.stdout + r.stderr).split('\n').filter((l) => /\[faseo\]/.test(l)).join('\n');
  assert.strictEqual(faseo(despues), faseo(antes));
});

test('estado-indice por CLI: --comprobar sale 1 si esta desactualizado, --escribir lo deja al dia y validate avisa antes', () => {
  const d = repo({ tareas: { 7: reg(7, { titulo: 'Titulo nuevo', responsable: 'luis' }), 8: reg(8, { titulo: 'Informe de cobertura (REQ-05)' }), 1: reg(1, { fase: 1, estado: 'hecha', titulo: 'Cimientos del repo' }) } });
  const v = harness(d, 'validate');
  assert.match(v.stdout + v.stderr, /\[estado-indice\]/);
  const c = harness(d, 'estado-indice', '--comprobar');
  assert.strictEqual(c.status, 1, c.stdout + c.stderr);
  assert.match(c.stdout + c.stderr, /#7/);
  const antes = fs.readFileSync(path.join(d, 'ESTADO.md'), 'utf8');
  const sinFlag = harness(d, 'estado-indice');
  assert.strictEqual(sinFlag.status, 0);
  assert.strictEqual(fs.readFileSync(path.join(d, 'ESTADO.md'), 'utf8'), antes, 'sin flag no escribe');
  assert.strictEqual(harness(d, 'estado-indice', '--escribir').status, 0);
  assert.match(fs.readFileSync(path.join(d, 'ESTADO.md'), 'utf8'), /#7 · Titulo nuevo — @luis \[cu:abc123\]/);
  assert.strictEqual(harness(d, 'estado-indice', '--comprobar').status, 0);
  assert.doesNotMatch(harness(d, 'validate').stdout + harness(d, 'validate').stderr, /\[estado-indice\]/);
});

test('un repo sin gestion/tareas/ no nota nada: validate no menciona estado-indice y estado-indice no escribe', () => {
  const d = repo();
  assert.doesNotMatch(harness(d, 'validate').stdout + harness(d, 'validate').stderr, /estado-indice|tareas-json/);
  const c = harness(d, 'estado-indice', '--comprobar');
  assert.strictEqual(c.status, 0);
  assert.strictEqual(harness(d, 'estado-indice', '--escribir').status, 0);
  assert.strictEqual(fs.readFileSync(path.join(d, 'ESTADO.md'), 'utf8'), ESTADO);
});

// ---------- endurecimiento (revision de seguridad) ----------

test('estado-indice: un registro con estructura rota o un titulo con salto de linea NO se vuelca a ESTADO.md', () => {
  const d = repo({ tareas: {
    7: reg(7, { titulo: 'Branding' }),
    8: reg(8, { titulo: 'bueno\n- [x] #99 · inyectada — @evil' }),
    9: { ...reg(9), estado: 'raro' },
  } });
  const c = idx.calcular(d);
  assert.ok(!/#99|inyectada/.test(c.nuevo), 'nada inyectado');
  assert.ok(!/#8 /.test(c.nuevo.split('Fase 2')[1] || '') || !/bueno/.test(c.nuevo), 'el titulo con salto de linea no entra');
  assert.ok(!/#9 ·/.test(c.nuevo), 'el registro con estructura rota no entra');
  assert.match(c.nuevo, /#7 · Branding/);
});

test('esquema: el titulo no admite caracteres de control', () => {
  assert.ok(vj.validar(SCHEMA, reg(7, { titulo: 'a\nb' })).length > 0);
  assert.ok(vj.validar(SCHEMA, reg(7, { titulo: 'a\u0007b' })).length > 0);
  assert.deepStrictEqual(vj.validar(SCHEMA, reg(7, { titulo: 'normal con tildes: ñ' })), []);
});

test('migrar: titulo, objetivo y resultado de la forja se limpian de control y se recortan a ~200', () => {
  const d = repo();
  const largo = 'x'.repeat(600);
  const forja = {
    issues: [issue(7, { title: `Titulo\n- [x] #99 inyectado\u0007 ${largo}`, body: `## Objetivo\n${largo}\n` }), issue(1, { title: 'Hecho', state: 'closed', state_reason: 'completed', closed_at: '2026-09-20T08:00:00Z' })],
    prs: [pr(11, { title: `resultado\n${largo}`, body: 'Closes #1', head: { ref: 'feat/1-x' } })],
  };
  const plan = mig.construirPlan(d, { forja, ahora: AHORA });
  const r7 = plan.registros.find((r) => r.id === '7').registro;
  const r1 = plan.registros.find((r) => r.id === '1').registro;
  assert.ok(!/[\x00-\x1f]/.test(r7.titulo) && r7.titulo.length <= 200, r7.titulo.length);
  assert.ok(r7.objetivo.length <= 200);
  assert.ok(!/[\x00-\x1f]/.test(r1.resultado) && r1.resultado.length <= 200);
  assert.deepStrictEqual(plan.registros.filter((r) => r.errores.length), []);
});

test('tarea <id>: el resumen corto recorta y limpia titulo, objetivo y resultado', () => {
  const cli = require(path.join(HOOKS, 'lib', 'tarea-cli.js'));
  const l = cli.resumenCorto(7, reg(7, { titulo: `T\u001b[31m${'a'.repeat(900)}`, objetivo: 'o'.repeat(900), resultado: 'r'.repeat(900), justificacion: 'j'.repeat(900) }));
  for (const x of l) { assert.ok(!/[\x00-\x08\x0b-\x1f]/.test(x), 'sin control'); assert.ok(x.length <= 260, `linea larga: ${x.length}`); }
});

test('fusionar: origen.revisar hostil (__proto__, constructor, no-array) no contamina ni rompe', () => {
  const base = mig.construirPlan(repo(), { forja: null, ahora: AHORA }).registros.find((r) => r.id === '7').registro;
  for (const revisar of [['__proto__.toString', 'constructor.name', 'constructor.prototype.polluted', 'fechas.__proto__.polluted2'], 'cadena', { 0: 'fase' }]) {
    const d = repo({ tareas: { 7: { ...base, origen: { tipo: 'migrada', revisar } } } });
    let plan;
    assert.doesNotThrow(() => { plan = mig.construirPlan(d, { forja: { issues: [issue(7, { body: CUERPO_7 })], prs: [] }, ahora: AHORA }); }, JSON.stringify(revisar));
    assert.strictEqual(({}).polluted, undefined);
    assert.strictEqual(({}).polluted2, undefined);
    assert.strictEqual(typeof ({}).toString, 'function');
    const r = plan.registros.find((x) => x.id === '7');
    if (r.accion !== 'omitir') assert.deepStrictEqual(r.errores, [], 'si se escribiera, seria valido');
  }
});

test('resumen-json: un registro que no valida contra el esquema no entra en el contrato publico', () => {
  const rj = require(path.join(HOOKS, 'lib', 'resumen-json.js'));
  const d = repo({ tareas: { 7: reg(7), 8: { ...reg(8), estado: 'raro' }, 9: { ...reg(9), titulo: 'a\nb' } } });
  const s = rj.construir(d);
  assert.deepStrictEqual(s.entregables.map((e) => e.id), ['7']);
  assert.strictEqual(s.fases.find((f) => f.num === 2).conteos.total, 1);
});
