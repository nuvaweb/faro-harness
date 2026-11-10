// #149 (parte 3) — ids L-<n> para tareas historicas sin #N propio y sincronizacion con el issue.
//
//   harness.js tarea migrar            -> numera las lineas sin #N como L-1, L-2... (estable y determinista)
//   harness.js tarea sync <N|--todas> [--comprobar]
//
// La forja se SIMULA con un transporte falso ({ghApi, ghRepo}); nunca se toca la red.
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
const sync = require(path.join(HOOKS, 'lib', 'tarea-sync.js'));

const AHORA = new Date('2026-10-11T10:00:00Z');

// ESTADO.md que imita el de acme-aiops: fases cerradas con tareas historicas SIN #N, y una mezcla.
const ESTADO = `---
iniciativa: Acme
fases_total: 3
fase_actual: 3
owner: t
---

### Fase 1 · Cimientos — done
Cerrada.
Objetivo: 2026-08-31
- [x] Montar el repo — @ana
- [x] Configurar CI [cu:abc]
- [x] Montar el repo — @ana

### Fase 2 · Núcleo — done
Cerrada.
Objetivo: 2026-09-30
- [x] #3 · Pipeline de ingesta — @luis
- [x] Dashboard inicial (REQ-04)
- [ ] observabilidad#55 · enlazar trazas

### Fase 3 · Despliegue — in_progress
En marcha.
Objetivo: 2026-10-31
- [ ] #7 · Mejora del branding — @luis
- [ ] Preparar manual de usuario — @ana
`;
const LOCALES = ['L-1', 'L-2', 'L-3', 'L-4', 'L-5', 'L-6'];

function repo({ estado = ESTADO, crlf = false } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-loc-'));
  const sh = (...a) => spawnSync('git', a, { cwd: d, encoding: 'utf8' });
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 't@t.t'); sh('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'ESTADO.md'), crlf ? estado.replace(/\n/g, '\r\n') : estado);
  sh('add', '-A'); sh('commit', '-q', '-m', 'init');
  return d;
}
const harness = (d, ...a) => spawnSync(process.execPath, [HARNESS, ...a], { cwd: d, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: d, GH_TOKEN: '', GITHUB_TOKEN: '', FARO_TOKEN: '' } });
const leerJson = (d, id) => JSON.parse(fs.readFileSync(path.join(d, 'gestion', 'tareas', `${id}.json`), 'utf8'));
const textoTarea = (d, id) => fs.readFileSync(path.join(d, 'gestion', 'tareas', `${id}.json`), 'utf8');
const existe = (d, id) => fs.existsSync(path.join(d, 'gestion', 'tareas', `${id}.json`));
const SCHEMA = tj.esquema();

const migrar = (d) => { const plan = mig.construirPlan(d, { ahora: AHORA }); return { plan, ...mig.aplicar(d, plan, { ahora: AHORA }) }; };
const callado = async (f) => {
  const l = console.log; const e = console.error; const salida = [];
  console.log = (...a) => salida.push(a.join(' ')); console.error = (...a) => salida.push(a.join(' '));
  try { return { r: await f(), salida: salida.join('\n') }; } finally { console.log = l; console.error = e; }
};

// ---------- (a) ids L-n ----------

test('las lineas sin #N propio reciben L-1.. en el orden de ESTADO.md, con origen y esquema valido', () => {
  const d = repo();
  const { plan, errores } = migrar(d);
  assert.deepStrictEqual(errores, []);
  assert.deepStrictEqual(plan.registros.filter((r) => String(r.id).startsWith('L-')).map((r) => r.id), LOCALES);
  const r1 = leerJson(d, 'L-1');
  assert.strictEqual(r1.issue, 'L-1');
  assert.strictEqual(r1.fase, 1);
  assert.strictEqual(r1.estado, 'hecha');
  assert.strictEqual(r1.responsable, 'ana');
  assert.strictEqual(r1.titulo, 'Montar el repo');
  assert.strictEqual(r1.origen.tipo, 'migrada');
  assert.ok(r1.origen.revisar.includes('objetivo') && r1.origen.revisar.includes('resultado'));
  const o = r1.extensiones['migracion.origen'];
  assert.strictEqual(o.fase, 1);
  assert.strictEqual(o.linea, 11);
  assert.match(o.texto, /Montar el repo/);
  for (const id of LOCALES) assert.deepStrictEqual(vj.validar(SCHEMA, leerJson(d, id)), [], id);
  assert.deepStrictEqual(leerJson(d, 'L-4').requisitos, ['REQ-04']);
  assert.strictEqual(leerJson(d, 'L-5').estado, 'pendiente');   // 'observabilidad#55' no es un issue propio: tarea local
  assert.strictEqual(leerJson(d, 'L-6').titulo, 'Preparar manual de usuario');
  assert.ok(existe(d, '3') && existe(d, '7'));                   // el #N propio sigue su camino
});

test('re-ejecutar la migracion no cambia nada (mismos ids, ficheros identicos)', () => {
  const d = repo();
  migrar(d);
  const antes = LOCALES.map((i) => textoTarea(d, i));
  const { plan } = migrar(d);
  assert.strictEqual(plan.resumen.crear, 0);
  assert.strictEqual(plan.resumen.actualizar, 0);
  assert.deepStrictEqual(LOCALES.map((i) => textoTarea(d, i)), antes);
});

test('lineas con el mismo texto no colisionan; marcar una casilla no cambia el id; la nueva toma el siguiente libre', () => {
  const d = repo();
  migrar(d);
  assert.strictEqual(leerJson(d, 'L-1').titulo, 'Montar el repo');
  assert.strictEqual(leerJson(d, 'L-3').titulo, 'Montar el repo');
  assert.notStrictEqual(leerJson(d, 'L-1').extensiones['migracion.origen'].linea, leerJson(d, 'L-3').extensiones['migracion.origen'].linea);
  const p = path.join(d, 'ESTADO.md');
  const t = fs.readFileSync(p, 'utf8').replace('- [ ] Preparar manual', '- [x] Preparar manual').replace('- [x] Configurar CI', '- [x] Linea nueva\n- [x] Configurar CI');
  fs.writeFileSync(p, t);
  const { plan } = migrar(d);
  assert.strictEqual(plan.registros.filter((r) => r.accion === 'crear').length, 1);
  assert.strictEqual(leerJson(d, 'L-6').titulo, 'Preparar manual de usuario');
  assert.strictEqual(leerJson(d, 'L-7').titulo, 'Linea nueva');
  assert.strictEqual(leerJson(d, 'L-2').titulo, 'Configurar CI');
});

test('un L-n editado a mano (sin origen migrada) no se pisa y su id no se reutiliza', () => {
  const d = repo();
  migrar(d);
  const r = leerJson(d, 'L-2'); delete r.origen; r.objetivo = 'Lo escribio una persona';
  fs.writeFileSync(path.join(d, 'gestion', 'tareas', 'L-2.json'), JSON.stringify(r, null, 2));
  const { plan } = migrar(d);
  assert.strictEqual(plan.registros.find((x) => x.id === 'L-2').accion, 'omitir');
  assert.strictEqual(leerJson(d, 'L-2').objetivo, 'Lo escribio una persona');
  assert.strictEqual(plan.registros.filter((x) => x.accion === 'crear').length, 0);
});

test('seguridad: el id L-n se valida antes de tocar disco; ids hostiles no llegan a rutas', async () => {
  for (const malo of ['L-', 'L-x', 'l-1', 'L-1/../x', '../L-1', 'L-1\n', 'L--1']) assert.strictEqual(tj.esIdValido(malo), false, malo);
  assert.throws(() => tj.rutaTarea('/tmp/x', 'L-1/../../etc'));
  const { r } = await callado(() => sync.cli(os.tmpdir(), ['L-1/../x'], { gh: null, ahora: AHORA }));
  assert.strictEqual(r, 1);
});

test('tarea, ir y refs resuelven L-n por CLI', () => {
  const d = repo();
  assert.strictEqual(harness(d, 'tarea', 'migrar', '--confirmo').status, 0);
  const t = harness(d, 'tarea', 'L-1', '--campo', 'titulo');
  assert.strictEqual(t.status, 0, t.stderr);
  assert.strictEqual(t.stdout.trim(), 'Montar el repo');
  const ir = harness(d, 'ir', 'L-1');
  assert.strictEqual(ir.status, 0, ir.stderr + ir.stdout);
  assert.match(ir.stdout, /L-1\.json/);
  assert.notStrictEqual(harness(d, 'tarea', 'L-1/../x').status, 0);
});

test('tarea validar: los L-n migrados son estructuralmente validos (los pendientes de revisar son informativos)', () => {
  const d = repo();
  migrar(d);
  const r = harness(d, 'tarea', 'validar');
  assert.match(r.stdout, /\[revisar\]/);
  assert.doesNotMatch(r.stdout, /\[estructura\]/);
});

// ---------- (c) ESTADO.md ----------

test('estado-indice: las lineas sin #N ganan su L-n sin romper el resto de ESTADO.md; es idempotente', () => {
  const d = repo();
  migrar(d);
  assert.ok(idx.calcular(d).cambios.some((x) => x.id === 'L-1'));
  const e = harness(d, 'estado-indice', '--escribir');
  assert.strictEqual(e.status, 0, e.stderr);
  const t = fs.readFileSync(path.join(d, 'ESTADO.md'), 'utf8');
  assert.match(t, /^- \[x\] L-1 · Montar el repo — @ana$/m);
  assert.match(t, /^- \[x\] L-2 · Configurar CI \[cu:abc\]$/m);
  assert.match(t, /^- \[ \] L-5 · observabilidad#55 · enlazar trazas$/m);
  assert.match(t, /^- \[ \] L-6 · Preparar manual de usuario — @ana$/m);
  assert.match(t, /^### Fase 2 · Núcleo — done$/m);
  assert.match(t, /^- \[x\] #3 · /m);
  assert.strictEqual(harness(d, 'estado-indice', '--comprobar').status, 0);
  assert.deepStrictEqual(idx.calcular(d).cambios, []);
  // con las lineas ya rotuladas, volver a migrar no crea registros nuevos ni renumera
  const { plan } = migrar(d);
  assert.strictEqual(plan.resumen.crear, 0);
  assert.deepStrictEqual(plan.registros.filter((r) => r.id.startsWith('L-')).map((r) => r.id), LOCALES);
});

test('estado-indice conserva CRLF con lineas L-n', () => {
  const d = repo({ crlf: true });
  migrar(d);
  assert.strictEqual(harness(d, 'estado-indice', '--escribir').status, 0);
  const t = fs.readFileSync(path.join(d, 'ESTADO.md'), 'utf8');
  assert.ok(!/[^\r]\n/.test(t), 'sin LF sueltos');
  assert.match(t, /L-1 · Montar el repo — @ana\r\n/);
});

// ---------- (b) sincronizacion ----------

const issue = (n, o = {}) => ({ number: n, title: `Issue ${n}`, state: 'open', state_reason: null, body: '', labels: [], assignee: null, assignees: [], milestone: null, created_at: '2026-10-01T09:00:00Z', closed_at: null, ...o });
const pr = (n, o = {}) => ({ number: n, title: `PR ${n}`, body: '', state: 'closed', merged_at: '2026-10-05T12:00:00Z', base: { ref: 'develop' }, head: { ref: `feat/${n}-x` }, ...o });

function transporte({ issues = [], prs = [], falla = false } = {}) {
  return {
    ghRepo: () => ({ org: 'o', repo: 'r' }),
    ghApi: async (ruta) => {
      if (falla) return { ok: false, status: 500, body: null };
      const m = /^repos\/o\/r\/(issues|pulls)\?.*page=(\d+)/.exec(ruta);
      if (!m) return { ok: false, status: 404, body: null };
      const lista = m[1] === 'issues' ? issues : prs;
      return { ok: true, status: 200, body: m[2] === '1' ? lista : [] };
    },
  };
}

const registro7 = (o = {}) => ({
  v: 1, issue: 7, titulo: 'Mejora del branding', fase: 3, estado: 'en_curso', responsable: 'luis',
  objetivo: 'Objetivo escrito por una persona', resultado: null, justificacion: 'nota humana', requisitos: [], cambios: [], prs: [],
  fechas: { creada: '2026-10-01', inicio: '2026-10-02', objetivo: '2026-10-20', cerrada: null, actualizada: '2026-10-01T00:00:00Z' },
  subtareas: { hechas: 0, total: 0, fuente: [] }, extensiones: { 'clickup.id': 'abc123' }, ...o,
});
function repoConRegistro(o) {
  const d = repo();
  tj.escribir(d, '7', registro7(o), { ahora: new Date('2026-10-01T00:00:00Z') });
  return d;
}
const CUERPO = '## Objetivo\nOTRO objetivo del issue\n\n## Subtareas\n- [x] a\n- [x] b\n- [ ] c\n';

test('sync <N> refresca solo los campos derivables y NO pisa los que edita la persona', async () => {
  const d = repoConRegistro();
  const gh = transporte({ issues: [issue(7, { state: 'closed', closed_at: '2026-10-09T08:00:00Z', body: CUERPO, title: 'Titulo nuevo en la forja' })], prs: [pr(21, { body: 'Closes #7', title: 'feat: branding' })] });
  const r = await sync.sincronizar(d, ['7'], { gh, ahora: AHORA });
  assert.strictEqual(r.resultados[0].accion, 'actualizar');
  const n = leerJson(d, '7');
  assert.strictEqual(n.estado, 'hecha');
  assert.deepStrictEqual(n.prs, [21]);
  assert.strictEqual(n.fechas.cerrada, '2026-10-09');
  assert.deepStrictEqual({ h: n.subtareas.hechas, t: n.subtareas.total }, { h: 2, t: 3 });
  assert.ok(n.subtareas.fuente.includes('issue'));
  assert.strictEqual(n.objetivo, 'Objetivo escrito por una persona');
  assert.strictEqual(n.justificacion, 'nota humana');
  assert.strictEqual(n.resultado, null);
  assert.strictEqual(n.titulo, 'Mejora del branding');
  assert.deepStrictEqual(n.extensiones, { 'clickup.id': 'abc123' });
  assert.strictEqual(n.fechas.inicio, '2026-10-02');
  assert.strictEqual(n.fechas.objetivo, '2026-10-20');
  assert.deepStrictEqual(vj.validar(SCHEMA, n), []);
});

test('sync: not_planned pasa a descartada; reabierto, un registro hecha vuelve a en_curso sin perder su resultado', async () => {
  let d = repoConRegistro();
  await sync.sincronizar(d, ['7'], { gh: transporte({ issues: [issue(7, { state: 'closed', state_reason: 'not_planned', closed_at: '2026-10-09T08:00:00Z' })] }), ahora: AHORA });
  assert.strictEqual(leerJson(d, '7').estado, 'descartada');
  d = repoConRegistro({ estado: 'hecha', resultado: 'Entregado', fechas: { creada: '2026-10-01', inicio: null, objetivo: null, cerrada: '2026-10-05', actualizada: '2026-10-05T00:00:00Z' } });
  await sync.sincronizar(d, ['7'], { gh: transporte({ issues: [issue(7)] }), ahora: AHORA });
  const n = leerJson(d, '7');
  assert.strictEqual(n.estado, 'en_curso');
  assert.strictEqual(n.fechas.cerrada, null);
  assert.strictEqual(n.resultado, 'Entregado');
});

test('sync es idempotente: sin deriva no reescribe el fichero', async () => {
  const d = repoConRegistro();
  const gh = transporte({ issues: [issue(7, { body: CUERPO })] });
  await sync.sincronizar(d, ['7'], { gh, ahora: AHORA });
  const t1 = textoTarea(d, '7');
  const r = await sync.sincronizar(d, ['7'], { gh, ahora: new Date('2026-12-01T00:00:00Z') });
  assert.strictEqual(r.resultados[0].accion, 'igual');
  assert.strictEqual(textoTarea(d, '7'), t1);
});

test('--comprobar solo informa de la deriva: no escribe y sale 1 si la hay, 0 si no', async () => {
  const d = repoConRegistro();
  const antes = textoTarea(d, '7');
  const gh = transporte({ issues: [issue(7, { state: 'closed', closed_at: '2026-10-09T08:00:00Z' })] });
  const a = await callado(() => sync.cli(d, ['7', '--comprobar'], { gh, ahora: AHORA }));
  assert.strictEqual(a.r, 1);
  assert.strictEqual(textoTarea(d, '7'), antes);
  assert.match(a.salida, /#7/);
  assert.match(a.salida, /estado/);
  const b = await callado(() => sync.cli(d, ['7', '--comprobar'], { gh: transporte({ issues: [issue(7)] }), ahora: AHORA }));
  assert.strictEqual(b.r, 0);
});

test('--todas sincroniza los registros numericos y omite los L-n (no tienen issue)', async () => {
  const d = repoConRegistro();
  migrar(d);
  const gh = transporte({ issues: [issue(7, { body: CUERPO }), issue(3, { state: 'closed', closed_at: '2026-09-01T00:00:00Z' })] });
  const r = await sync.sincronizar(d, null, { gh, ahora: AHORA });
  const ids = r.resultados.map((x) => x.id);
  assert.ok(ids.includes('7') && ids.includes('3'));
  assert.ok(!ids.some((i) => i.startsWith('L-')));
  assert.strictEqual(leerJson(d, '7').subtareas.total, 3);
});

test('fail-closed: sin forja o con error de red no se escribe nada; ids dudosos o sin registro se rechazan', async () => {
  const d = repoConRegistro();
  const antes = textoTarea(d, '7');
  const cod = async (argv, gh) => (await callado(() => sync.cli(d, argv, { gh, ahora: AHORA }))).r;
  assert.strictEqual(await cod(['7'], null), 1);
  assert.strictEqual(await cod(['7'], transporte({ falla: true })), 1);
  assert.strictEqual(await cod(['7'], transporte({ issues: [issue(99)] })), 1);     // el issue 7 no esta en la forja
  assert.strictEqual(await cod(['8'], transporte({ issues: [issue(8)] })), 1);      // sin registro 8
  assert.strictEqual(await cod(['L-1'], transporte()), 1);
  assert.strictEqual(await cod(['7; echo hola'], transporte()), 1);
  assert.strictEqual(await cod([], transporte()), 1);
  assert.strictEqual(textoTarea(d, '7'), antes);
});

test('el texto de la forja es dato no confiable: al registro solo llegan enteros, fechas validas y enums', async () => {
  const d = repoConRegistro();
  const hostil = issue(7, { title: 'x\n## Inyeccion', state: 'closed', closed_at: 'no-es-fecha\n', body: CUERPO });
  const gh = transporte({ issues: [hostil], prs: [pr(21, { body: 'Closes #7', title: 'a'.repeat(500) + '\nmalo' })] });
  const r = await sync.sincronizar(d, ['7'], { gh, ahora: AHORA });
  const n = leerJson(d, '7');
  assert.deepStrictEqual(vj.validar(SCHEMA, n), []);
  assert.ok(!/Inyeccion/.test(textoTarea(d, '7')));
  assert.strictEqual(n.fechas.cerrada, null);                          // closed_at ilegible: no se inventa
  assert.ok(r.resultados[0].avisos.some((a) => /cerrada/.test(a)));
  for (const a of r.resultados[0].avisos) { assert.ok(a.length <= 200); assert.ok(!/[\r\n]/.test(a)); }
});

test('sync no usa shell ni procesos', () => {
  const src = fs.readFileSync(path.join(HOOKS, 'lib', 'tarea-sync.js'), 'utf8');
  assert.doesNotMatch(src, /child_process|shell:\s*true|execSync|spawn/);
});

test('CLI: tarea sync sin forja (sin token) falla cerrado con un mensaje claro', () => {
  const d = repoConRegistro();
  const antes = textoTarea(d, '7');
  const r = harness(d, 'tarea', 'sync', '7');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /forja/i);
  assert.strictEqual(textoTarea(d, '7'), antes);
  assert.strictEqual(harness(d, 'tarea', 'sync').status, 1);
});

// ---------- revision adversaria ----------

test('rendimiento: un cuerpo de PR hostil (closes + 60k espacios) no tarda ni un segundo', () => {
  const tarea = require(path.join(HOOKS, 'lib', 'tarea.js'));
  const hostil = { number: 1, title: 'x', body: 'closes' + ' '.repeat(60000) + 'x refs' + ' '.repeat(60000), head: { ref: 'feat/9-x' } };
  const t = Date.now();
  tarea.issuesDePr(hostil);
  assert.ok(Date.now() - t < 1000, `tardo ${Date.now() - t} ms`);
  assert.ok(tarea.issuesDePr({ number: 2, title: 'x', body: 'Closes #7 y fixes: #8', head: { ref: 'main' } }).has(7));
  assert.ok(tarea.issuesDePr({ number: 2, title: 'x', body: 'Closes #7 y fixes: #8', head: { ref: 'main' } }).has(8));
});

test('sync calcula issuesDePr una vez por PR, no por registro', async () => {
  const d = repoConRegistro();
  tj.escribir(d, '8', registro7({ issue: 8, titulo: 'Otro' }), { ahora: AHORA });
  let n = 0;
  const p = pr(21, { body: 'Closes #7' });
  Object.defineProperty(p, 'head', { get() { n++; return { ref: 'feat/7-x' }; } });
  await sync.sincronizar(d, null, { gh: transporte({ issues: [issue(7), issue(8)], prs: [p] }), ahora: AHORA });
  assert.ok(n <= 2, `issuesDePr se calculo ${n} veces para un PR`);
});

test('un L-n enorme en ESTADO.md no rompe la numeracion ni duplica ids', () => {
  const d = repo({ estado: ESTADO.replace('- [ ] Preparar manual', '- [ ] L-99999999999999999999999 · Gigante\n- [ ] Preparar manual') });
  const { plan } = migrar(d);
  const ids = plan.registros.map((r) => r.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.ok(ids.every((i) => tj.esIdValido(i) && !/e\+/.test(i)));
});

test('sync: un registro sin fechas se salta con aviso y no aborta --todas', async () => {
  const d = repoConRegistro();
  const roto = registro7({ issue: 8 }); delete roto.fechas;
  fs.writeFileSync(path.join(d, 'gestion', 'tareas', '8.json'), JSON.stringify(roto));
  const r = await sync.sincronizar(d, null, { gh: transporte({ issues: [issue(7, { body: CUERPO }), issue(8)] }), ahora: AHORA });
  assert.strictEqual(r.resultados.find((x) => x.id === '8').accion, 'omitir');
  assert.strictEqual(r.resultados.find((x) => x.id === '7').accion, 'actualizar');
});
