// #157 — REFERENCIAS Y NAVEGACION: tipos de referencia con patron unico (faro-schema.json >
// referencias), `harness.js ir <ref>` (resuelve en vivo, barato, <= 20 lineas), `harness.js refs <ref>`
// (quien la cita), aviso de referencias rotas en validate y la linea de navegacion del arranque.
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
const ref = require(path.join(HOOKS, 'lib', 'referencias.js'));

const AHORA = '2026-10-11T10:00:00Z';
const reg = (o = {}) => ({
  v: 1, issue: 7, titulo: 'Mejora del branding', fase: 2, estado: 'en_curso',
  objetivo: 'Que la pagina use la marca nueva', resultado: null, justificacion: null,
  requisitos: ['REQ-01'], cambios: [{ slug: 'mi-cambio', estado: 'aprobado' }], prs: [31],
  apps: ['panel'],
  fechas: { creada: '2026-10-01', inicio: '2026-10-02', objetivo: '2026-10-20', cerrada: null, actualizada: AHORA },
  subtareas: { hechas: 1, total: 2, fuente: ['issue'] },
  ...o,
});

const ESTADO = `---
iniciativa: Demo
clave: DEMO
fases_total: 2
fase_actual: 2
owner: t
---

### Fase 1 · Primera — done
Cerrada.
Objetivo: 2026-09-30
- [x] #1 · Algo — @t

### Fase 2 · Segunda — in_progress
En marcha.
Objetivo: 2026-10-31
- [ ] #7 · Mejora del branding — @t
`;

function repo({ tareas = { 7: reg() }, extra = {} } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-ref-'));
  const w = (rel, txt) => { fs.mkdirSync(path.join(d, path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), txt); };
  const sh = (...a) => spawnSync('git', a, { cwd: d, encoding: 'utf8' });
  sh('init', '-q', '-b', 'main'); sh('config', 'user.email', 't@t.t'); sh('config', 'user.name', 't');
  w('ESTADO.md', ESTADO);
  w('.faro.json', JSON.stringify({ monorepo: { apps: { panel: { rol: 'Panel de administracion' } } } }));
  w('pnpm-workspace.yaml', 'packages:\n  - apps/*\n');
  w('apps/panel/package.json', '{"name":"panel","version":"1.2.0"}');
  w('apps/panel/CLAUDE.md', '# panel\n');
  w('gestion/requisitos.md', '# Requisitos\n\n## REQ-01 · Marca nueva en la web\n- estado: aceptado\n- origen: fuentes/reunion.vtt\n\n## REQ-02 · Otro\n- estado: propuesto\n- origen: x\n');
  w('gestion/risks.md', '| ID | Tipo | Desc | Impacto | Dueno | Estado |\n|---|---|---|---|---|---|\n| R-01 | Riesgo | El cliente cambia la marca | Alto | @t | abierto |\n| R-02 | Riesgo | Otro | Bajo | @t | cerrado |\n');
  w('gestion/cambios/changes/mi-cambio/proposal.md', '---\ntitulo: Mi cambio\ndescripcion: Aplica la marca nueva (REQ-01)\nestado: aprobada\nissue: 7\n---\n\n## Por que\nLo pide REQ-01.\n');
  w('gestion/cambios/changes/archive/viejo/proposal.md', '---\ntitulo: Viejo\ndescripcion: Ya archivado\nestado: archivada\n---\n');
  w('documentos/funcional/DEMO-FUN-001-funcional.md', '---\ndoc_id: DEMO-FUN-001\ntitle: Funcional de Demo\nversion: 1.0.0\ndate: 2026-10-01\nstatus: approved\nauthor: t\nclassification: interno\n---\n\n# Funcional\nCubre REQ-01.\n');
  for (const [id, r] of Object.entries(tareas)) w(`gestion/tareas/${id}.json`, typeof r === 'string' ? r : JSON.stringify(r, null, 2));
  for (const [rel, txt] of Object.entries(extra)) w(rel, txt);
  sh('add', '-A'); sh('commit', '-q', '-m', 'init');
  return d;
}
const harness = (d, ...a) => spawnSync(process.execPath, [HARNESS, ...a], { cwd: d, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: d } });
const salida = (r) => (r.stdout || '') + (r.stderr || '');
const sesion = (d, id) => {
  const r = spawnSync(process.execPath, [HARNESS, 'session'], { cwd: d, encoding: 'utf8', input: JSON.stringify({ session_id: id, source: 'startup' }), env: { ...process.env, CLAUDE_PROJECT_DIR: d } });
  try { const s = JSON.parse(r.stdout || '{}'); return (s.hookSpecificOutput && s.hookSpecificOutput.additionalContext) || ''; } catch { return r.stdout || ''; }
};

// ---------- tipos de referencia ----------

test('tipoDe reconoce los siete tipos y rechaza lo demas', () => {
  const casos = {
    'fase:2': 'fase', '#149': 'tarea', 'L-3': 'tarea', 'cambio:mi-cambio': 'cambio', 'REQ-136': 'req',
    'R-07': 'riesgo', 'DEMO-FUN-001': 'doc', 'ACME-PROY-ARQ-012': 'doc', 'app:gold-api': 'app',
  };
  for (const [t, tipo] of Object.entries(casos)) assert.strictEqual(ref.tipoDe(t), tipo, t);
  for (const malo of ['', 'REQ-1', 'fase:', 'fase:x', '../x', 'cambio:../x', 'cambio:A/B', 'app:a/b', '#', '#x', 'hola', 'R-1', 'DEMO-FUN-1', null, undefined, 42, 'a'.repeat(200)]) {
    assert.strictEqual(ref.tipoDe(malo), null, String(malo));
  }
});

test('normalizar fija la forma canonica y devuelve null si no es referencia', () => {
  assert.strictEqual(ref.normalizar('  req-136 '), 'REQ-136');
  assert.strictEqual(ref.normalizar('r-07'), 'R-07');
  assert.strictEqual(ref.normalizar('l-3'), 'L-3');
  assert.strictEqual(ref.normalizar('FASE:2'), 'fase:2');
  assert.strictEqual(ref.normalizar('Cambio:Mi-Cambio'), 'cambio:mi-cambio');
  assert.strictEqual(ref.normalizar('demo-fun-001'), 'DEMO-FUN-001');
  assert.strictEqual(ref.normalizar('app:Panel'), 'app:Panel');
  assert.strictEqual(ref.normalizar('../../etc/passwd'), null);
});

test('los patrones viven UNA vez en faro-schema.json (bloque referencias)', () => {
  const s = JSON.parse(fs.readFileSync(path.join(HOOKS, 'faro-schema.json'), 'utf8'));
  assert.ok(s.referencias && s.referencias.tipos, 'falta el bloque referencias');
  for (const t of ['fase', 'tarea', 'cambio', 'req', 'riesgo', 'doc', 'app']) {
    assert.ok(s.referencias.tipos[t] && typeof s.referencias.tipos[t].patron === 'string' && s.referencias.tipos[t].ejemplo, t);
  }
});

// ---------- ir ----------

test('ir de una tarea: ruta, estado y relacionados en <= 20 lineas', () => {
  const d = repo();
  const r = harness(d, 'ir', '#7');
  assert.strictEqual(r.status, 0, salida(r));
  assert.ok(r.stdout.trim().split('\n').length <= 20, r.stdout);
  assert.match(r.stdout, /tarea/);
  assert.match(r.stdout, /gestion\/tareas\/7\.json/);
  assert.match(r.stdout, /en_curso/);
  assert.match(r.stdout, /REQ-01/);
  assert.match(r.stdout, /cambio:mi-cambio/);
  assert.match(r.stdout, /app:panel/);
  assert.match(r.stdout, /fase:2/);
});

test('ir --campo devuelve UNA linea; --json, un objeto', () => {
  const d = repo();
  const c = harness(d, 'ir', '#7', '--campo', 'fechas.objetivo');
  assert.strictEqual(c.status, 0, salida(c));
  assert.strictEqual(c.stdout, '2026-10-20\n');
  assert.strictEqual(harness(d, 'ir', '#7', '--campo', 'estado').stdout, 'en_curso\n');
  const j = JSON.parse(harness(d, 'ir', 'REQ-01', '--json').stdout);
  assert.strictEqual(j.tipo, 'req');
  assert.strictEqual(j.ref, 'REQ-01');
  assert.strictEqual(j.estado, 'aceptado');
  assert.match(j.ruta, /gestion\/requisitos\.md/);
  assert.ok(Array.isArray(j.relacionados));
});

test('ir de un campo inexistente falla con exit 1 y mensaje claro', () => {
  const r = harness(repo(), 'ir', '#7', '--campo', 'no.existe');
  assert.strictEqual(r.status, 1);
  assert.match(salida(r), /no\.existe/);
});

test('ir resuelve REQ, R, cambio (vivo y archivado), doc_id, app y fase', () => {
  const d = repo();
  const req = harness(d, 'ir', 'REQ-01').stdout;
  assert.match(req, /Marca nueva en la web/);
  assert.match(req, /aceptado/);
  assert.match(req, /#7/);
  const riesgo = harness(d, 'ir', 'R-01').stdout;
  assert.match(riesgo, /cliente cambia la marca/);
  assert.match(riesgo, /abierto/);
  assert.match(harness(d, 'ir', 'cambio:mi-cambio').stdout, /gestion\/cambios\/changes\/mi-cambio/);
  const arch = harness(d, 'ir', 'cambio:viejo').stdout;
  assert.match(arch, /archive\/viejo/);
  assert.match(arch, /archiv/);
  const doc = harness(d, 'ir', 'DEMO-FUN-001').stdout;
  assert.match(doc, /documentos\/funcional\/DEMO-FUN-001-funcional\.md/);
  assert.match(doc, /approved/);
  const app = harness(d, 'ir', 'app:panel').stdout;
  assert.match(app, /apps\/panel/);
  assert.match(app, /Panel de administracion/);
  const fase = harness(d, 'ir', 'fase:2').stdout;
  assert.match(fase, /ESTADO\.md/);
  assert.match(fase, /in_progress/);
  assert.match(fase, /#7/);
});

test('ir de algo inexistente o mal formado: mensaje claro y exit 1', () => {
  const d = repo();
  for (const x of ['REQ-99', 'R-77', 'cambio:nada', 'DEMO-FUN-099', 'app:nada', 'fase:9', '#999']) {
    const r = harness(d, 'ir', x);
    assert.strictEqual(r.status, 1, x);
    assert.match(salida(r), /no existe/i, x);
  }
  const mal = harness(d, 'ir', '../../etc/passwd');
  assert.strictEqual(mal.status, 1);
  assert.match(salida(mal), /referencia no v[aá]lida/i);
  assert.strictEqual(harness(d, 'ir').status, 1);
});

test('ir con doc_id duplicado es ambiguo: exit 1 y lista los ficheros', () => {
  const d = repo({ extra: { 'documentos/otro/DEMO-FUN-001-copia.md': '---\ndoc_id: DEMO-FUN-001\ntitle: Copia\n---\n' } });
  const r = harness(d, 'ir', 'DEMO-FUN-001');
  assert.strictEqual(r.status, 1);
  assert.match(salida(r), /ambigu/i);
  assert.match(salida(r), /DEMO-FUN-001-copia\.md/);
});

test('SEGURIDAD: una referencia con separadores o .. nunca llega a construir una ruta', () => {
  const d = repo({ extra: { 'secreto.json': '{"x":1}' } });
  for (const x of ['cambio:..', 'cambio:../..', '#../secreto', 'app:../x', 'cambio:a/b', 'cambio:a\\b', 'L-3/../../x', 'DEMO-FUN-001/../..', 'REQ-01;ls', 'cambio:a b']) {
    const r = harness(d, 'ir', x);
    assert.strictEqual(r.status, 1, x);
    assert.match(salida(r), /referencia no v[aá]lida/i, x);
    assert.strictEqual(harness(d, 'refs', x).status, 1, x);
  }
});

// ---------- refs ----------

test('refs lista quien cita la referencia, con rutas', () => {
  const d = repo();
  const r = harness(d, 'refs', 'REQ-01');
  assert.strictEqual(r.status, 0, salida(r));
  assert.match(r.stdout, /gestion\/tareas\/7\.json/);
  assert.match(r.stdout, /gestion\/cambios\/changes\/mi-cambio\/proposal\.md/);
  assert.match(r.stdout, /documentos\/funcional\/DEMO-FUN-001-funcional\.md/);
  assert.ok(!/gestion\/requisitos\.md/.test(r.stdout), 'la definicion no se lista como cita');
  assert.match(harness(d, 'refs', 'cambio:mi-cambio').stdout, /gestion\/tareas\/7\.json/);
  const t = harness(d, 'refs', '#7').stdout;
  assert.match(t, /ESTADO\.md/);
  assert.match(t, /proposal\.md/);
  assert.match(harness(d, 'refs', 'app:panel').stdout, /gestion\/tareas\/7\.json/);
});

test('refs de algo que nadie cita: lo dice y sale con 0; --json da lista', () => {
  const d = repo();
  const r = harness(d, 'refs', 'REQ-02');
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /nadie|ninguna/i);
  const j = JSON.parse(harness(d, 'refs', 'REQ-01', '--json').stdout);
  assert.ok(Array.isArray(j.citas) && j.citas.length >= 3);
});

// ---------- validate ----------

test('validate avisa de referencias rotas en UNA linea con los 5 primeros ejemplos y no bloquea', () => {
  const rotas = {};
  for (let i = 10; i < 18; i++) rotas[i] = reg({ issue: i, titulo: `T${i}`, requisitos: [`REQ-9${i}`], cambios: [], apps: ['panel'], prs: [] });
  rotas[20] = reg({ issue: 20, requisitos: [], cambios: [{ slug: 'fantasma', estado: 'borrador' }], apps: ['no-existe'] });
  const d = repo({ tareas: { 7: reg(), ...rotas } });
  const lineas = salida(harness(d, 'validate')).split('\n').filter((l) => /\[referencias\]/.test(l));
  assert.strictEqual(lineas.length, 1, lineas.join('\n'));
  assert.match(lineas[0], /REQ-910/);
  assert.match(lineas[0], /\+\d+ m[aá]s/);
  assert.ok((lineas[0].match(/REQ-9\d\d|fantasma|no-existe/g) || []).length <= 5, lineas[0]);
  assert.ok(!/\[referencias\][^\n]*REQ-01\b/.test(lineas[0]), 'las referencias sanas no se avisan');
});

test('validate avisa de cambio sin carpeta y app no declarada', () => {
  const d = repo({ tareas: { 7: reg({ cambios: [{ slug: 'fantasma', estado: 'borrador' }], apps: ['no-existe'] }) } });
  const l = salida(harness(d, 'validate')).split('\n').find((x) => /\[referencias\]/.test(x)) || '';
  assert.match(l, /fantasma/);
  assert.match(l, /no-existe/);
});

test('validate no dice nada de referencias si todas resuelven (ni en repo sin tareas)', () => {
  assert.ok(!/\[referencias\]/.test(salida(harness(repo(), 'validate'))));
  const s = repo({ tareas: {} });
  fs.rmSync(path.join(s, 'gestion', 'tareas'), { recursive: true, force: true });
  assert.ok(!/\[referencias\]/.test(salida(harness(s, 'validate'))));
});

// ---------- arranque ----------

test('el indice de sesion lleva la linea de navegacion (<= 160 car.) solo si hay tareas o documentos controlados', () => {
  const ctx = sesion(repo(), 'ref-1');
  const linea = ctx.split('\n').find((l) => /harness\.js ir </.test(l));
  assert.ok(linea, ctx);
  assert.ok(linea.length <= 160, `${linea.length} car.: ${linea}`);
  assert.match(linea, /refs/);

  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-ref-vacio-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: v });
  fs.writeFileSync(path.join(v, 'ESTADO.md'), ESTADO);
  assert.ok(!/harness\.js ir </.test(sesion(v, 'ref-2')), 'sin tareas ni documentos controlados no hay linea');
});

// ---------- despacho ligero ----------

test('ir y refs se despachan sin cargar el motor (rapido)', () => {
  const d = repo();
  harness(d, 'ir', '#7');   // calienta
  conReintento(() => {
    const t0 = process.hrtime.bigint();
    harness(d, 'ir', '#7');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`# ir #7 = ${ms.toFixed(0)} ms (incluye arranque de node)`);
    assert.ok(ms < umbral(1500), `ir tardo ${ms} ms (umbral ${umbral(1500)})`);
  }, 'ir');
});

test('navegacion: ESTADO.md con lineas en blanco masivas no cuesta tiempo cuadratico al resolver una tarea sin registro', () => {
  const d = repo({ tareas: {} });
  fs.writeFileSync(path.join(d, 'ESTADO.md'), `${'\n'.repeat(40000)}${' \n'.repeat(20000)}- [ ] #5 · algo\n`);
  const nav = require(path.join(HOOKS, 'lib', 'navegacion.js'));
  conReintento(() => {
    const t0 = Date.now();
    assert.throws(() => nav.resolver(d, '#999'), /no existe/);
    const ms = Date.now() - t0;
    assert.ok(ms < umbral(200), `resolver tardo ${ms} ms (umbral ${umbral(200)})`);
  }, 'navegacion');
});
