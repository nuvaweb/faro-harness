// #149 (parte 1) — ESTADO ESTRUCTURADO DE TAREAS: un JSON por issue (gestion/tareas/<id>.json) con
// esquema cerrado, reglas cruzadas deterministas, comando `tarea`, `resumen` generado y `validate`.
//
// Y el reverso: un repo SIN gestion/tareas/ se comporta exactamente como antes (cero ruido).
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
const tj = require(path.join(HOOKS, 'lib', 'tareas-json.js'));
const vj = require(path.join(HOOKS, 'lib', 'validador-json.js'));
const SCHEMA = JSON.parse(fs.readFileSync(path.join(HOOKS, 'tarea.schema.json'), 'utf8'));

const AHORA = '2026-10-11T10:00:00Z';
const reg = (o = {}) => ({
  v: 1, issue: 7, titulo: 'Mejora del branding', fase: 2, estado: 'en_curso',
  objetivo: 'Que la pagina use la marca nueva', resultado: null, justificacion: null,
  requisitos: [], cambios: [], prs: [],
  fechas: { creada: '2026-10-01', inicio: '2026-10-02', objetivo: '2026-10-20', cerrada: null, actualizada: AHORA },
  subtareas: { hechas: 0, total: 2, fuente: ['issue'] },
  ...o,
});

const ESTADO = `---
iniciativa: Demo
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

function repo({ tareas = {}, estado = ESTADO, faro, conTareas = true } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-tj-'));
  const sh = (...a) => spawnSync('git', a, { cwd: d, encoding: 'utf8' });
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 't@t.t'); sh('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'ESTADO.md'), estado);
  if (faro) fs.writeFileSync(path.join(d, '.faro.json'), JSON.stringify(faro));
  if (conTareas) {
    fs.mkdirSync(path.join(d, 'gestion', 'tareas'), { recursive: true });
    for (const [id, r] of Object.entries(tareas)) fs.writeFileSync(path.join(d, 'gestion', 'tareas', `${id}.json`), typeof r === 'string' ? r : JSON.stringify(r, null, 2));
  }
  sh('add', '-A'); sh('commit', '-q', '-m', 'init');
  return d;
}
const harness = (d, ...a) => spawnSync(process.execPath, [HARNESS, ...a], { cwd: d, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: d } });
const errs = (r, d = '.') => tj.validarReglas(r, { root: d, id: String(r.issue), fases: [{ num: 2, estado: 'in_progress', objetivo: '2026-10-31', inicio: null }], monorepo: false, appsIds: [] });

// ---------- esquema y validador ----------

test('el esquema acepta un registro completo y valida el opcional origen y las extensiones', () => {
  assert.deepStrictEqual(vj.validar(SCHEMA, reg({ apps: ['api'], requisitos: ['REQ-01'], cambios: [{ slug: 'a-b', estado: 'archivado' }], prs: [3], origen: { tipo: 'migrada', revisar: ['resultado'] }, extensiones: { 'clickup.id': 'abc' } })), []);
  assert.deepStrictEqual(vj.validar(SCHEMA, reg({ issue: 'L-3' })), []);
});

test('el nucleo es CERRADO: un campo desconocido es error con su ruta; extensiones es libre pero con prefijo', () => {
  assert.ok(vj.validar(SCHEMA, reg({ colorFavorito: 'azul' })).some((e) => e.startsWith('colorFavorito')));
  const r = reg(); r.fechas.otra = '2026-01-01';
  assert.ok(vj.validar(SCHEMA, r).some((e) => e.startsWith('fechas.otra')));
  assert.ok(vj.validar(SCHEMA, reg({ extensiones: { sinprefijo: 1 } })).some((e) => e.startsWith('extensiones.sinprefijo')));
});

test('los mensajes llevan la ruta del campo', () => {
  const r = reg(); r.fechas.objetivo = '2026-13-45';
  const e = vj.validar(SCHEMA, r);
  assert.ok(e.some((m) => m.startsWith('fechas.objetivo:')), e.join('\n'));
  assert.ok(vj.validar(SCHEMA, reg({ cambios: [{ slug: 'x', estado: 'raro' }] })).some((m) => m.startsWith('cambios[0].estado')));
  assert.ok(vj.validar(SCHEMA, reg({ estado: 'hecho' })).some((m) => m.startsWith('estado:')));
  assert.ok(vj.validar(SCHEMA, reg({ fase: '2' })).some((m) => m.startsWith('fase:')));
  assert.ok(vj.validar(SCHEMA, reg({ requisitos: ['REQ-1'] })).some((m) => m.startsWith('requisitos[0]')));
  const s = reg(); delete s.fechas.actualizada;
  assert.ok(vj.validar(SCHEMA, s).some((m) => m.startsWith('fechas.actualizada')));
  assert.ok(vj.validar(SCHEMA, reg({ objetivo: '' })).some((m) => m.startsWith('objetivo:')));
});

// ---------- reglas cruzadas ----------

test('hecha exige resultado, fechas.cerrada, cambios archivados y subtareas cerradas', () => {
  const e = errs(reg({ estado: 'hecha', cambios: [{ slug: 'x', estado: 'implementada' }] })).map((x) => x.mensaje).join('\n');
  assert.match(e, /resultado/);
  assert.match(e, /fechas\.cerrada/);
  assert.match(e, /x/);
  assert.match(e, /subtareas/);
  const ok = reg({ estado: 'hecha', resultado: 'Hecho', cambios: [{ slug: 'x', estado: 'archivado' }], subtareas: { hechas: 2, total: 2, fuente: ['issue'] } });
  ok.fechas.cerrada = '2026-10-10';
  assert.deepStrictEqual(errs(ok), []);
});

test('hecha con subtareas sin cerrar se admite si hay justificacion (descartadas)', () => {
  const r = reg({ estado: 'hecha', resultado: 'Hecho', justificacion: 'Dos subtareas descartadas por cambio de alcance' });
  r.fechas.cerrada = '2026-10-10';
  assert.deepStrictEqual(errs(r), []);
});

test('descartada exige justificacion', () => {
  assert.match(errs(reg({ estado: 'descartada' })).map((x) => x.mensaje).join('\n'), /justificacion/);
  assert.deepStrictEqual(errs(reg({ estado: 'descartada', justificacion: 'Ya no aplica' })), []);
});

test('fechas: inicio <= objetivo y objetivo dentro de la fase si la fase lo declara', () => {
  const a = reg(); a.fechas.inicio = '2026-10-25'; a.fechas.objetivo = '2026-10-20';
  assert.match(errs(a).map((x) => x.mensaje).join('\n'), /fechas\.inicio/);
  const b = reg(); b.fechas.objetivo = '2026-11-15';
  assert.match(errs(b).map((x) => x.mensaje).join('\n'), /fechas\.objetivo.*fase 2/);
  const c = reg({ fase: 9 }); c.fechas.objetivo = '2030-01-01';
  assert.deepStrictEqual(errs(c), [], 'fase no declarada: no hay rango que exigir');
});

test('monorepo: apps obligatoria y cada id debe existir', () => {
  const ctx = { root: '.', id: '7', fases: [], monorepo: true, appsIds: ['api', 'web'] };
  assert.match(tj.validarReglas(reg(), ctx).map((x) => x.mensaje).join('\n'), /apps/);
  assert.match(tj.validarReglas(reg({ apps: ['nada'] }), ctx).map((x) => x.mensaje).join('\n'), /nada/);
  assert.deepStrictEqual(tj.validarReglas(reg({ apps: ['api'] }), ctx), []);
});

test('el id del fichero debe coincidir con el issue', () => {
  assert.match(tj.validarReglas(reg({ issue: 8 }), { root: '.', id: '7', fases: [], monorepo: false, appsIds: [] }).map((x) => x.mensaje).join('\n'), /issue/);
});

test('un cambio pertenece a UN solo issue (duplicados entre registros)', () => {
  const d = repo({ tareas: {
    7: reg({ cambios: [{ slug: 'comun', estado: 'borrador' }] }),
    8: reg({ issue: 8, cambios: [{ slug: 'comun', estado: 'borrador' }] }),
  } });
  const r = tj.validarTodo(d);
  const dup = r.problemas.filter((p) => /comun/.test(p.mensaje));
  assert.strictEqual(dup.length, 2, 'se avisa en los dos registros');
  assert.ok(dup.every((p) => p.tipo === 'regla'));
});

// ---------- escritura ----------

test('escribir: actualizada la pone el modulo, JSON estable en orden del esquema, y no deja temporales', () => {
  const d = repo();
  const r = reg(); r.fechas.actualizada = '1999-01-01T00:00:00Z';
  const desordenado = { fechas: r.fechas, titulo: r.titulo, v: 1, issue: 7, fase: 1, estado: r.estado, objetivo: r.objetivo, resultado: null, justificacion: null, requisitos: [], cambios: [], prs: [], subtareas: r.subtareas };
  tj.escribir(d, '7', desordenado, { ahora: new Date('2026-10-11T12:34:56Z') });
  const txt = fs.readFileSync(path.join(d, 'gestion', 'tareas', '7.json'), 'utf8');
  assert.ok(txt.endsWith('}\n'));
  assert.deepStrictEqual(Object.keys(JSON.parse(txt)).slice(0, 4), ['v', 'issue', 'titulo', 'fase']);
  assert.strictEqual(JSON.parse(txt).fechas.actualizada, '2026-10-11T12:34:56Z');
  assert.match(txt, /\n  "v": 1,/);
  assert.deepStrictEqual(fs.readdirSync(path.join(d, 'gestion', 'tareas')), ['7.json']);
  assert.strictEqual(tj.leer(d, '7').fechas.actualizada, '2026-10-11T12:34:56Z');
});

test('escribir rechaza un registro invalido sin tocar el disco', () => {
  const d = repo();
  assert.throws(() => tj.escribir(d, '7', reg({ estado: 'inventado' })), /estado/);
  assert.ok(!fs.existsSync(path.join(d, 'gestion', 'tareas', '7.json')));
});

test('seguridad de ids: solo ^\\d+$ o ^L-\\d+$ llegan al disco', () => {
  const d = repo();
  for (const malo of ['../x', '..\\x', '7/../8', 'a', '', '-1', '7.json', 'L-', 'l-3', '7 ', '7\n', '/etc/passwd']) {
    assert.strictEqual(tj.esIdValido(malo), false, JSON.stringify(malo));
    assert.throws(() => tj.rutaTarea(d, malo), /id/);
    assert.throws(() => tj.escribir(d, malo, reg()), /id/);
  }
  assert.strictEqual(tj.esIdValido('7'), true);
  assert.strictEqual(tj.esIdValido('L-12'), true);
  const r = harness(d, 'tarea', '../../etc/passwd', '--campo', 'estado');
  assert.notStrictEqual(r.status, 0);
  assert.ok(!/root:/.test(r.stdout));
});

// ---------- comando tarea ----------

test('tarea <id> --campo imprime UNA linea con el valor', () => {
  const d = repo({ tareas: { 7: reg() } });
  const r = harness(d, 'tarea', '7', '--campo', 'fechas.objetivo');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '2026-10-20\n');
  assert.strictEqual(harness(d, 'tarea', '7', '--campo', 'estado').stdout, 'en_curso\n');
  assert.strictEqual(harness(d, 'tarea', '7', '--campo', 'resultado').stdout, 'null\n');
  assert.strictEqual(harness(d, 'tarea', '7', '--campo', 'subtareas.hechas').stdout, '0\n');
  const mal = harness(d, 'tarea', '7', '--campo', 'no.existe');
  assert.notStrictEqual(mal.status, 0);
  assert.strictEqual(harness(d, 'tarea', '7', '--campo', '__proto__').status === 0, false);
});

test('tarea <id> sin --campo: resumen de 12 lineas como maximo; --json el registro entero', () => {
  const d = repo({ tareas: { 7: reg() } });
  const r = harness(d, 'tarea', '7');
  assert.strictEqual(r.status, 0, r.stderr);
  const lineas = r.stdout.trim().split('\n');
  assert.ok(lineas.length <= 12 && lineas.length >= 4, r.stdout);
  assert.match(r.stdout, /#7/);
  assert.match(r.stdout, /Mejora del branding/);
  assert.deepStrictEqual(JSON.parse(harness(d, 'tarea', '7', '--json').stdout), reg());
});

test('tarea <id> de un registro inexistente falla con mensaje', () => {
  const d = repo();
  const r = harness(d, 'tarea', '99');
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /99/);
});

test('tarea set: valida antes de escribir y refresca actualizada', () => {
  const d = repo({ tareas: { 7: reg() } });
  const ok = harness(d, 'tarea', 'set', '7', 'fechas.objetivo', '2026-10-25');
  assert.strictEqual(ok.status, 0, ok.stderr);
  const guardado = tj.leer(d, '7');
  assert.strictEqual(guardado.fechas.objetivo, '2026-10-25');
  assert.notStrictEqual(guardado.fechas.actualizada, AHORA);

  const antes = fs.readFileSync(path.join(d, 'gestion', 'tareas', '7.json'), 'utf8');
  for (const [campo, valor] of [['estado', 'hecha'], ['fechas.objetivo', 'manana'], ['estado', 'inventado'], ['descartada', 'x'], ['subtareas.hechas', '2'], ['fechas.actualizada', '2020-01-01T00:00:00Z'], ['__proto__.x', '1'], ['objetivo', '']]) {
    const r = harness(d, 'tarea', 'set', '7', campo, valor);
    assert.notStrictEqual(r.status, 0, `${campo}=${valor}`);
  }
  assert.strictEqual(fs.readFileSync(path.join(d, 'gestion', 'tareas', '7.json'), 'utf8'), antes, 'ningun set invalido escribe');
  assert.strictEqual(harness(d, 'tarea', 'set', '7', 'resultado', 'Listo').status, 0);
  assert.strictEqual(tj.leer(d, '7').resultado, 'Listo');
  assert.strictEqual(harness(d, 'tarea', 'set', '7', 'resultado', 'null').status, 0);
  assert.strictEqual(tj.leer(d, '7').resultado, null);
});

test('tarea validar [<id>]: exit 1 con errores, 0 sin ellos', () => {
  const d = repo({ tareas: { 7: reg(), 8: reg({ issue: 8, estado: 'hecha' }) } });
  assert.strictEqual(harness(d, 'tarea', 'validar', '7').status, 0);
  const todo = harness(d, 'tarea', 'validar');
  assert.strictEqual(todo.status, 1);
  assert.match(todo.stdout + todo.stderr, /8/);
  const roto = repo({ tareas: { 7: '{ no es json' } });
  assert.strictEqual(harness(roto, 'tarea', 'validar').status, 1);
});

// ---------- resumen.json ----------

test('resumen: contrato publico determinista y --comprobar detecta desfase', () => {
  const d = repo({ tareas: { 7: reg(), 8: reg({ issue: 8, titulo: 'Otra', estado: 'pendiente', fase: 2 }) } });
  assert.strictEqual(harness(d, 'resumen-json', '--comprobar').status, 1, 'sin resumen.json esta desactualizado');
  const g = harness(d, 'resumen-json');
  assert.strictEqual(g.status, 0, g.stderr);
  const f = path.join(d, 'gestion', 'resumen.json');
  const a = fs.readFileSync(f, 'utf8');
  const j = JSON.parse(a);
  assert.strictEqual(j.v, 1);
  assert.strictEqual(j.generado, AHORA);
  assert.deepStrictEqual(j.entregables.map((e) => e.id), ['7', '8']);
  assert.deepStrictEqual(Object.keys(j.entregables[0]), ['id', 'titulo', 'fase', 'apps', 'estado', 'fechas', 'subtareas']);
  const f2 = j.fases.find((x) => x.num === 2);
  assert.strictEqual(f2.conteos.total, 2);
  assert.strictEqual(f2.conteos.en_curso, 1);
  assert.strictEqual(f2.conteos.pendiente, 1);
  assert.strictEqual(f2.fechas.objetivo, '2026-10-31');
  harness(d, 'resumen-json');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), a, 'dos ejecuciones dan el mismo fichero');
  assert.strictEqual(harness(d, 'resumen-json', '--comprobar').status, 0);
  tj.establecer(d, '7', 'estado', 'bloqueada', { ahora: new Date('2026-10-12T00:00:00Z') });
  assert.strictEqual(harness(d, 'resumen-json', '--comprobar').status, 1);
});

test('resumen en monorepo: conteos por app', () => {
  const d = repo({ faro: { monorepo: { apps: {} } }, tareas: { 7: reg({ apps: ['api'] }) } });
  fs.mkdirSync(path.join(d, 'apps', 'api'), { recursive: true });
  fs.writeFileSync(path.join(d, 'apps', 'api', 'package.json'), '{"name":"api","version":"1.0.0"}');
  fs.writeFileSync(path.join(d, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  harness(d, 'resumen-json');
  const j = JSON.parse(fs.readFileSync(path.join(d, 'gestion', 'resumen.json'), 'utf8'));
  assert.deepStrictEqual(j.apps.map((a) => a.id), ['api']);
  assert.strictEqual(j.apps[0].conteos.en_curso, 1);
});

// ---------- validate ----------

test('validate avisa de registros invalidos en fases abiertas y de resumen desactualizado', () => {
  const d = repo({ tareas: { 7: reg({ estado: 'descartada' }) } });
  const r = harness(d, 'validate');
  const salida = r.stdout + r.stderr;
  assert.match(salida, /\[tareas-json\].*#?7.*justificacion/);
  assert.match(salida, /resumen\.json/);
});

test('validate: en fases cerradas solo errores estructurales', () => {
  const sinJust = reg({ issue: 1, fase: 1, estado: 'descartada' });          // regla: fase cerrada, se calla
  const roto = reg({ issue: 2, fase: 1 }); roto.colorFavorito = 'azul';     // estructura: se dice
  const d = repo({ tareas: { 1: sinJust, 2: roto } });
  const salida = harness(d, 'validate').stdout + harness(d, 'validate').stderr;
  assert.ok(!/\[tareas-json\][^\n]*#1\b/.test(salida), salida);
  assert.match(salida, /\[tareas-json\][^\n]*#2[^\n]*colorFavorito/);
});

test('un repo SIN gestion/tareas/ no cambia: ningun aviso ni fichero nuevo, y no carga el modulo', () => {
  const d = repo({ conTareas: false });
  const salida = harness(d, 'validate').stdout + harness(d, 'validate').stderr;
  assert.ok(!/tareas-json|resumen\.json/.test(salida), salida);
  assert.ok(!fs.existsSync(path.join(d, 'gestion', 'tareas')));
  assert.strictEqual(tj.hayTareas(d), false);
  assert.deepStrictEqual(tj.listar(d), []);
});

test('faro-schema.json documenta el esquema y los comandos; el desconocido los lista', () => {
  const s = fs.readFileSync(path.join(HOOKS, 'faro-schema.json'), 'utf8');
  assert.match(s, /tarea\.schema\.json/);
  assert.match(s, /harness\.js tarea/);
  assert.match(s, /harness\.js resumen/);
  const r = spawnSync(process.execPath, [HARNESS, 'comando-que-no-existe'], { encoding: 'utf8' });
  assert.match(r.stderr, /tarea/);
  assert.match(r.stderr, /resumen-json/);
});

// ---------- endurecimiento (revision de seguridad) ----------

test('JSON ilegible: el mensaje NO cita el contenido del fichero', () => {
  const d = repo({ tareas: { 7: '{"token": "SECRETO-ABC123" oops' } });
  const r = tj.validarTodo(d);
  const p = r.problemas.find((x) => x.id === '7');
  assert.ok(p, 'hay problema');
  assert.match(p.mensaje, /JSON ilegible/);
  assert.ok(!/SECRETO|ABC123/.test(p.mensaje), p.mensaje);
});

test('un symlink en gestion/tareas/ no se lee: es un problema de estructura', (t) => {
  const d = repo({ tareas: { 7: reg() } });
  const fuera = path.join(d, 'fuera.json');
  fs.writeFileSync(fuera, JSON.stringify(reg({ issue: 8 })));
  try { fs.symlinkSync(fuera, path.join(d, 'gestion', 'tareas', '8.json')); } catch { t.skip('sin permiso para symlinks'); return; }
  const r = tj.validarTodo(d);
  assert.ok(r.problemas.some((p) => p.id === '8' && /fichero regular/.test(p.mensaje)), JSON.stringify(r.problemas));
  assert.strictEqual(tj.leer(d, '8'), null);
});

test('fases-lite: lineas en blanco masivas no cuestan tiempo cuadratico', () => {
  const d = repo({});
  const blanco = '\n'.repeat(40000);
  fs.writeFileSync(path.join(d, 'ESTADO.md'), `### Fase 1 · Algo — in_progress\n${blanco}Objetivo: 2026-10-31\n${' \n'.repeat(20000)}`);
  const fl = require(path.join(HOOKS, 'lib', 'fases-lite.js'));
  conReintento(() => {
    const t0 = Date.now();
    const fases = fl.leerFases(d);
    const ms = Date.now() - t0;
    assert.strictEqual(fases.length, 1);
    assert.ok(ms < umbral(200), `leerFases tardo ${ms} ms (umbral ${umbral(200)})`);
  }, 'fases-lite');
});
