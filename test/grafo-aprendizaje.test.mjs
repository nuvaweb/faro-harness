// Entrega 3 del grafo FARO (#302): aprendizajes versionados, nodos del grafo, minado con candidatos
// filtrados, confirmacion humana, cuidados para el revisor y minado en segundo plano.
// Spec: gestion/cambios/changes/grafo-faro/specs/grafo-aprendizaje/spec.md
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
const LIB = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'grafo');
const HARNESS = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'harness.js');
const SKILLS = path.join(RAIZ, 'plugins', 'faro', 'skills');
const I = require(path.join(LIB, 'indice.js'));
const A = require(path.join(LIB, 'aprendizajes.js'));
const M = require(path.join(LIB, 'minado.js'));
const AC = require(path.join(LIB, 'aprender-cli.js'));
const C = require(path.join(LIB, 'consultas.js'));
const H = require(path.join(LIB, 'historia.js'));
const E = require(path.join(LIB, 'empuje.js'));
const G = require(path.join(LIB, 'cli.js'));

const escribir = (dir, rel, txt) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };
const git = (d, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: d, encoding: 'utf8', windowsHide: true });
const commit = (d, msg) => { git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', msg); return git(d, 'rev-parse', 'HEAD').stdout.trim(); };
function repo(extra = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-apr-'));
  git(d, 'init', '-q', '-b', 'main');
  escribir(d, 'faro/ESTADO.md', '# estado\n');
  escribir(d, 'src/b.js', 'module.exports = 1;\n');
  escribir(d, 'src/a.js', "const b = require('./b.js');\nmodule.exports = b;\n");
  escribir(d, 'src/c.js', 'module.exports = 3;\n');
  for (const [rel, txt] of Object.entries(extra)) escribir(d, rel, txt);
  commit(d, 'base');
  return d;
}
const homeVacio = () => fs.mkdtempSync(path.join(os.tmpdir(), 'faro-home-'));
const correr = (root, argv, opts = {}) => { const l = []; const code = AC.cli(argv, { root, out: (t) => l.push(t), home: homeVacio(), ...opts }); return { code, out: l.join('\n') }; };
const dirApr = (d) => path.join(d, 'faro', 'gestion', 'aprendizajes');
const dirCand = (d) => path.join(d, 'faro', '.cache', 'candidatos');
const candidatos = (d) => { try { return fs.readdirSync(dirCand(d)).filter((f) => f.endsWith('.json') && f !== '_estado.json').map((f) => JSON.parse(fs.readFileSync(path.join(dirCand(d), f), 'utf8'))); } catch { return []; } };

// Conversacion de Claude Code en <home>/.claude/projects/<slug>/<sesion>.jsonl
function conversacion(home, root, nombre, eventos) {
  const slug = path.resolve(root).replace(/[^A-Za-z0-9]/g, '-');
  const dir = path.join(home, '.claude', 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  // Claude Code anota el cwd en cada evento; los tests lo ponen salvo que el evento lo traiga (o lo quite con null)
  const conCwd = eventos.map((e) => ('cwd' in e ? (e.cwd === null ? (({ cwd, ...x }) => x)(e) : e) : { ...e, cwd: root }));
  fs.writeFileSync(path.join(dir, nombre), conCwd.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return path.join(dir, nombre);
}
const asis = (texto, extra = []) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: texto }, ...extra] } });
const usu = (texto) => ({ type: 'user', message: { role: 'user', content: texto } });
const bash = (id, command) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const resultado = (id, ok, texto) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: !ok, content: texto }] } });

// ---------- Requisito: ficheros versionados que solo se añaden ----------

test('guardar crea AP-001-<slug>.md con frontmatter y el siguiente numero libre', () => {
  const d = repo();
  assert.strictEqual(A.siguienteId(d), 'AP-001');
  const r = A.guardar(d, { tipo: 'cuidado', titulo: 'La caché de índices: no tocar sin lock', toca: ['src/a.js', 'src/b.js'], fuente: 'manual', cuerpo: 'Dos procesos la escriben.\nUsa el lock.' });
  assert.strictEqual(r.id, 'AP-001');
  assert.match(r.rel, /^faro\/gestion\/aprendizajes\/AP-001-la-cache-de-indices-no-tocar-sin-lock\.md$/);
  const leidos = A.leer(d);
  assert.strictEqual(leidos.length, 1);
  assert.deepStrictEqual(leidos[0].toca, ['src/a.js', 'src/b.js']);
  assert.strictEqual(leidos[0].titulo, 'La caché de índices: no tocar sin lock');
  assert.strictEqual(leidos[0].tipo, 'cuidado');
  assert.strictEqual(leidos[0].vigente, true);
  assert.strictEqual(A.siguienteId(d), 'AP-002');
  // un hueco ocupado a mano no se pisa: el siguiente es el libre
  escribir(d, 'faro/gestion/aprendizajes/AP-007-a-mano.md', '---\nid: AP-007\ntitulo: a mano\ntipo: decidido\ntoca: [src/c.js, src/a.js]\nfuente: manual\n---\nx\n');
  assert.strictEqual(A.siguienteId(d), 'AP-008');
  assert.deepStrictEqual(A.leer(d).find((x) => x.id === 'AP-007').toca, ['src/c.js', 'src/a.js']);
});

test('guardar rechaza tipos invalidos, sustituye inexistente y secretos', () => {
  const d = repo();
  assert.throws(() => A.guardar(d, { tipo: 'otro', titulo: 't', toca: [], cuerpo: 'x' }), /tipo/);
  assert.throws(() => A.guardar(d, { tipo: 'cuidado', titulo: 't', toca: [], sustituye: 'AP-009', cuerpo: 'x' }), /AP-009/);
  assert.throws(() => A.guardar(d, { tipo: 'cuidado', titulo: 't', toca: [], cuerpo: `ghp_${'a'.repeat(36)}` }), /secreto/);
  assert.ok(!fs.existsSync(dirApr(d)) || fs.readdirSync(dirApr(d)).length === 0);
});

test('escenario sustituir: AP-002 vigente, AP-001 no vigente y sin cambios en disco', () => {
  const d = repo();
  const r1 = A.guardar(d, { tipo: 'cuidado', titulo: 'Primero', toca: ['src/a.js'], cuerpo: 'uno' });
  const antes = fs.readFileSync(path.join(d, r1.rel));
  const r2 = A.guardar(d, { tipo: 'decidido', titulo: 'Segundo', toca: ['src/a.js'], sustituye: 'AP-001', cuerpo: 'dos' });
  assert.strictEqual(r2.id, 'AP-002');
  assert.deepStrictEqual(A.vigentes(d).map((x) => x.id), ['AP-002']);
  assert.ok(fs.readFileSync(path.join(d, r1.rel)).equals(antes), 'AP-001 sigue en disco sin cambios');
  const l = correr(d, ['lista']);
  assert.strictEqual(l.code, 0);
  assert.match(l.out, /AP-002 \[decidido\] Segundo/);
  assert.doesNotMatch(l.out, /AP-001/);
});

test('AP con el mismo numero desde dos ramas: vigencia por fichero, sustituye ambiguo y numeracion mira develop/main', () => {
  const d = repo();
  const ap = (nombre, titulo, extra = '') => escribir(d, `faro/gestion/aprendizajes/${nombre}.md`,
    `---\nid: AP-003\ntitulo: "${titulo}"\ntipo: cuidado\ntoca:\n  - "src/a.js"\nfuente: "manual"\n${extra}---\n\ncuerpo\n`);
  ap('AP-003-foo', 'Foo');
  ap('AP-003-bar', 'Bar');
  assert.deepStrictEqual(A.vigentes(d).map((x) => x.clave).sort(), ['AP-003-bar', 'AP-003-foo']);
  assert.throws(() => A.preparar(d, { tipo: 'cuidado', titulo: 'X', sustituye: 'AP-003', cuerpo: 'x' }), /ambiguo.*--sustituye AP-003-(bar|foo)/);
  const g = correr(d, ['guardar', '--confirmo', '--tipo', 'cuidado', '--titulo', 'X', '--sustituye', 'AP-003', '--cuerpo', 'x']);
  assert.strictEqual(g.code, 2, g.out);
  assert.match(g.out, /nombre completo/);
  const r = A.guardar(d, { tipo: 'cuidado', titulo: 'Nuevo foo', toca: ['src/a.js'], sustituye: 'AP-003-foo', cuerpo: 'x' });
  assert.strictEqual(r.id, 'AP-004');
  assert.match(fs.readFileSync(path.join(d, r.rel), 'utf8'), /^sustituye: AP-003-foo$/m);
  assert.deepStrictEqual(A.vigentes(d).map((x) => x.clave).sort(), ['AP-003-bar', 'AP-004-nuevo-foo'], 'solo cae el fichero sustituido');
  commit(d, 'aps');
  // develop ya uso el AP-009 (otra rama integrada): no se reutiliza aunque aqui no este
  git(d, 'checkout', '-q', '-b', 'develop');
  ap('AP-009-otro', 'Otro');
  commit(d, 'ap 9');
  git(d, 'checkout', '-q', 'main');
  git(d, 'checkout', '-q', '-b', 'feat/y');
  assert.ok(!fs.existsSync(path.join(dirApr(d), 'AP-009-otro.md')));
  assert.strictEqual(A.siguienteId(d), 'AP-010');
});

test('guardar: --candidato sin --toca hereda su toca; titulo y cuerpo enmascarados; secretos rechazados', () => {
  const d = repo();
  const home = homeVacio();
  conversacion(home, d, 's.jsonl', [asis('hecho'), usu('no, eso no: src/a.js no se toca')]);
  M.minar(d, { home });
  const conv = candidatos(d).find((c) => c.fuente.tipo === 'conversacion');
  assert.deepStrictEqual(conv.toca, ['src/a.js']);
  const g = correr(d, ['guardar', '--confirmo', '--tipo', 'cuidado', '--titulo', 'Avisar a ana@ejemplo.com', '--candidato', conv.id.slice(0, 8), '--cuerpo', 'Llamar al +34 600 123 456 antes.']);
  assert.strictEqual(g.code, 0, g.out);
  const a = A.leer(d)[0];
  assert.deepStrictEqual(a.toca, ['src/a.js']);
  const txt = fs.readFileSync(path.join(dirApr(d), `${a.clave}.md`), 'utf8');
  assert.doesNotMatch(txt, /ana@ejemplo\.com|600 123 456/);
  assert.match(txt, /\[email\]/);
  assert.match(txt, /\[tel\]/);
  const s = correr(d, ['guardar', '--confirmo', '--tipo', 'cuidado', '--titulo', 'clave', '--cuerpo', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB']);
  assert.strictEqual(s.code, 2, s.out);
  assert.match(s.out, /secreto/);
});

// ---------- Requisito: los aprendizajes son nodos del grafo ----------

test('contexto, porque y la linea de edicion citan los AP vigentes del fichero (ojo en cuidado)', () => {
  const d = repo();
  A.guardar(d, { tipo: 'cuidado', titulo: 'B se lee en caliente', toca: ['src/b.js'], cuerpo: 'x' });
  A.guardar(d, { tipo: 'decidido', titulo: 'A es la fachada', toca: ['src/a.js'], cuerpo: 'x' });
  A.guardar(d, { tipo: 'cuidado', titulo: 'Viejo', toca: ['src/b.js'], cuerpo: 'x' });
  A.guardar(d, { tipo: 'descartado', titulo: 'Nuevo', toca: ['src/c.js'], sustituye: 'AP-003', cuerpo: 'x' });
  const idx = I.construir(d, {});
  const ctx = C.contexto(d, idx, 'src/b.js').lineas.join('\n');
  assert.match(ctx, /AP-001 \[cuidado\] B se lee en caliente/);
  assert.doesNotMatch(ctx, /AP-003/, 'el sustituido no cuenta');
  const pq = H.porque(d, idx, 'src/a.js').lineas.join('\n');
  assert.match(pq, /AP-002 \[decidido\] A es la fachada/);
  const ed = E.lineaEdicion(idx, 'src/b.js', d);
  assert.match(ed, /lo importan 1/);
  assert.match(ed, /· ojo AP-001/);
  // decidido: se cita sin «ojo»; sin root la linea es la de siempre
  const eda = E.lineaEdicion(idx, 'src/a.js', d);
  assert.match(eda, /AP-002/);
  assert.doesNotMatch(eda, /ojo/);
  assert.doesNotMatch(E.lineaEdicion(idx, 'src/b.js'), /AP-/);
  // via CLI del grafo (presupuesto incluido)
  I.guardar(d, idx);
  const l = []; G.cli(['contexto', 'src/b.js'], { root: d, out: (t) => l.push(t) });
  assert.match(l.join('\n'), /AP-001 \[cuidado\]/);
});

// ---------- Requisito: minado determinista con candidatos filtrados ----------

test('escenario opt-out: con conversaciones=false no se abre ningun .jsonl', () => {
  const d = repo({ 'faro/config.json': JSON.stringify({ grafo: { aprender: { conversaciones: false } } }) });
  const home = homeVacio();
  conversacion(home, d, 's1.jsonl', [asis('hecho'), usu('no, eso no: usa el lock')]);
  const abiertos = [];
  const orig = { openSync: fs.openSync, readFileSync: fs.readFileSync, createReadStream: fs.createReadStream, readdirSync: fs.readdirSync };
  const espia = (n) => function (p, ...r) { if (String(p).includes('.claude')) abiertos.push(`${n} ${p}`); return orig[n].call(fs, p, ...r); };
  for (const n of Object.keys(orig)) fs[n] = espia(n);
  try { M.minar(d, { home }); } finally { Object.assign(fs, orig); }
  assert.deepStrictEqual(abiertos, []);
  assert.ok(!candidatos(d).some((c) => c.fuente.tipo === 'conversacion'));
});

test('conversacion: correccion del usuario tras el asistente es candidato; sin asistente previo no', () => {
  const d = repo();
  const home = homeVacio();
  conversacion(home, d, 's1.jsonl', [
    usu('no quiero nada raro'), // primer mensaje: no corrige a nadie
    asis('Edito src/a.js con un singleton', [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: path.join(d, 'src', 'a.js') } }]),
    usu('no hagas un singleton en src/a.js, en vez de eso inyecta la dependencia'),
    asis('vale'),
    usu('perfecto, sigue'),
  ]);
  const r = M.minar(d, { home });
  const conv = candidatos(d).filter((c) => c.fuente.tipo === 'conversacion');
  assert.strictEqual(conv.length, 1, JSON.stringify(conv));
  assert.strictEqual(r.nuevos >= 1, true);
  assert.ok(['cuidado', 'descartado'].includes(conv[0].tipo_sugerido));
  assert.ok(conv[0].toca.includes('src/a.js'));
  assert.match(conv[0].fragmento, /singleton/);
  assert.ok(conv[0].fragmento.length <= 400);
  assert.match(conv[0].id, /^[0-9a-f]{12,}$/);
});

test('escenario datos personales: email y telefono enmascarados, el del token no se guarda', () => {
  const d = repo();
  const home = homeVacio();
  conversacion(home, d, 's1.jsonl', [
    asis('Mando el aviso'),
    usu('no, eso no: escríbele a ana@ejemplo.com o llama al +34 600 123 456 antes de tocar src/a.js'),
    asis('Uso el token'),
    usu(`no hagas eso, el token es ghp_${'A1b2'.repeat(10)} y no va aquí`),
    asis('Apunto la referencia'),
    usu(`mal, la referencia es ${'x'.repeat(20)}${'Z9'.repeat(10)} y no otra`),
  ]);
  M.minar(d, { home });
  const todos = candidatos(d);
  const texto = JSON.stringify(todos);
  assert.doesNotMatch(texto, /ana@ejemplo\.com/);
  assert.doesNotMatch(texto, /600 123 456/);
  assert.doesNotMatch(texto, /ghp_/);
  assert.match(texto, /\[email\]/);
  assert.match(texto, /\[tel\]/);
  assert.match(texto, /\[token\]/);
  assert.strictEqual(todos.filter((c) => c.fuente.tipo === 'conversacion').length, 2, 'el del secreto se descarta entero');
  // tampoco queda en la cache nada del secreto
  for (const f of fs.readdirSync(dirCand(d))) assert.doesNotMatch(fs.readFileSync(path.join(dirCand(d), f), 'utf8'), /ghp_/);
});

test('conversacion: un comando de tests que falla dos veces y luego pasa es candidato cuidado', () => {
  const d = repo({ 'test/a.test.mjs': "import 'node:test';\n" });
  const home = homeVacio();
  conversacion(home, d, 's2.jsonl', [
    bash('b1', 'node --test test/a.test.mjs'), resultado('b1', false, 'not ok 1 - falla'),
    bash('b2', 'node --test test/a.test.mjs'), resultado('b2', false, 'not ok 1 - falla'),
    bash('b3', 'node --test test/a.test.mjs'), resultado('b3', true, 'ok 1 - pasa'),
    bash('b4', 'npm run test:x'), resultado('b4', false, 'FAIL'),
    bash('b5', 'npm run test:x'), resultado('b5', true, 'ok'),
  ]);
  M.minar(d, { home });
  const rv = candidatos(d).filter((c) => c.fuente.tipo === 'conversacion');
  assert.strictEqual(rv.length, 1, JSON.stringify(rv));
  assert.strictEqual(rv[0].tipo_sugerido, 'cuidado');
  assert.ok(rv[0].toca.includes('test/a.test.mjs'));
  assert.match(rv[0].fragmento, /2/);
});

test('git: revert -> descartado, co-cambio >=5 -> cuidado con ambos, ADR citado como ref', () => {
  const d = repo({ 'faro/gestion/decisions/ADR-001-lock.md': '# ADR-001\nEl indice se toca desde `src/a.js`.\n' });
  commit(d, 'adr');
  escribir(d, 'src/c.js', 'module.exports = 30;\n');
  commit(d, 'cambio c');
  git(d, 'revert', '--no-edit', 'HEAD');
  for (let i = 0; i < 5; i++) { escribir(d, 'src/a.js', `module.exports = ${i};\n`); escribir(d, 'src/b.js', `module.exports = ${i + 1};\n`); commit(d, `ab ${i}`); }
  M.minar(d, { home: homeVacio() });
  const cs = candidatos(d);
  const rev = cs.find((c) => c.fuente.tipo === 'revert');
  assert.ok(rev, JSON.stringify(cs));
  assert.strictEqual(rev.tipo_sugerido, 'descartado');
  assert.ok(rev.toca.includes('src/c.js'));
  const co = cs.find((c) => c.fuente.tipo === 'cochange');
  assert.ok(co);
  assert.strictEqual(co.tipo_sugerido, 'cuidado');
  assert.deepStrictEqual([...co.toca].sort(), ['src/a.js', 'src/b.js']);
  assert.ok(co.refs.includes('faro/gestion/decisions/ADR-001-lock.md'));
  assert.doesNotMatch(co.fragmento, /El indice se toca/, 'el ADR no se copia');
});

test('ids estables: minar dos veces no duplica; descartados y aceptados no vuelven', () => {
  const d = repo();
  escribir(d, 'src/c.js', 'module.exports = 30;\n');
  commit(d, 'cambio c');
  git(d, 'revert', '--no-edit', 'HEAD');
  const home = homeVacio();
  conversacion(home, d, 's1.jsonl', [asis('hecho'), usu('no, eso no: src/a.js no se toca')]);
  const r1 = M.minar(d, { home });
  const ids1 = candidatos(d).map((c) => c.id).sort();
  assert.ok(ids1.length >= 2);
  const r2 = M.minar(d, { home });
  assert.strictEqual(r2.nuevos, 0);
  assert.deepStrictEqual(candidatos(d).map((c) => c.id).sort(), ids1);
  assert.strictEqual(r2.total, r1.total);
  const rev = candidatos(d).find((c) => c.fuente.tipo === 'revert');
  const conv = candidatos(d).find((c) => c.fuente.tipo === 'conversacion');
  assert.strictEqual(correr(d, ['descartar', rev.id.slice(0, 8)]).code, 0);
  const g = correr(d, ['guardar', '--confirmo', '--tipo', 'cuidado', '--titulo', 'A no se toca', '--toca', 'src/a.js', '--candidato', conv.id.slice(0, 8), '--cuerpo', 'Lo dijo el usuario.']);
  assert.strictEqual(g.code, 0, g.out);
  M.minar(d, { home });
  const ids3 = candidatos(d).map((c) => c.id);
  assert.ok(!ids3.includes(rev.id) && !ids3.includes(conv.id));
  const est = JSON.parse(fs.readFileSync(path.join(dirCand(d), '_estado.json'), 'utf8'));
  assert.ok(est.descartados.includes(rev.id) && est.aceptados.includes(conv.id));
  assert.match(A.leer(d)[0].fuente, /conversacion/);
});

// ---------- Requisito: el minado no confunde ruido con aprendizajes ----------

test('conversacion: solo cuenta lo tecleado por la persona (ni harness, ni resumen, ni agentes, ni tool_result)', () => {
  const d = repo();
  const home = homeVacio();
  const tras = (ev) => [asis('Edito src/a.js', [{ type: 'tool_use', id: 'e', name: 'Edit', input: { file_path: path.join(d, 'src', 'a.js') } }]), ev];
  const ruido = [
    usu('This session is being continued from a previous conversation that ran out of context. No hagas eso en src/a.js.'),
    { ...usu('no hagas eso en src/a.js'), isMeta: true },
    { ...usu('no hagas eso en src/a.js'), isCompactSummary: true },
    { ...usu('no hagas eso en src/a.js'), isSidechain: true },
    usu('<system-reminder>no hagas eso en src/a.js</system-reminder>'),
    usu('<command-name>/faro:pr</command-name> no hagas eso'),
    usu('<task-notification>no hagas eso</task-notification>'),
    usu('<local-command-stdout>no hagas eso</local-command-stdout>'),
    usu('[Request interrupted by user] no hagas eso'),
    usu('Another Claude session sent a message: no hagas eso en src/a.js'),
    usu('[Subagent hand-back] no hagas eso en src/a.js'),
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e', content: 'no hagas eso' }, { type: 'text', text: 'no hagas eso en src/a.js' }] } },
    usu(`no hagas eso en src/a.js ${'x'.repeat(700)}`), // demasiado largo para ser una correccion tecleada
  ];
  conversacion(home, d, 'ruido.jsonl', ruido.flatMap(tras));
  M.minar(d, { home });
  assert.deepStrictEqual(candidatos(d).filter((c) => c.fuente.tipo === 'conversacion'), []);
  // y lo tecleado si cuenta, con toca solo de ficheros del indice (max 5)
  const muchos = ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js', 'src/e.js', 'src/f.js', 'src/noexiste.js', 'docs/x.md'];
  for (const f of ['src/d.js', 'src/e.js', 'src/f.js']) escribir(d, f, 'module.exports = 0;\n');
  commit(d, 'mas');
  conversacion(home, d, 'bueno.jsonl', [asis('hecho'), usu(`no, eso no: ${muchos.join(' ')}`)]);
  M.minar(d, { home });
  const conv = candidatos(d).filter((c) => c.fuente.tipo === 'conversacion');
  assert.strictEqual(conv.length, 1, JSON.stringify(conv));
  assert.strictEqual(conv[0].toca.length, 5);
  assert.ok(conv[0].toca.every((t) => t.startsWith('src/') && t !== 'src/noexiste.js'), conv[0].toca.join());
});

test('co-cambios: fuera version, registro y gestion; solo codigo o test que existe en el indice', () => {
  const d = repo({
    'CHANGELOG.md': '# c\n', 'package.json': '{}\n', 'package-lock.json': '{}\n', 'plugins/p/.claude-plugin/plugin.json': '{}\n',
    '.claude-plugin/marketplace.json': '{}\n', '.faro.json': '{}\n', 'faro/config.json': '{}\n', 'faro/gestion/x.js': '1\n', 'gestion/y.js': '1\n',
    'README.md': '# r\n', 'test/a.test.mjs': '1\n', 'src/borrado.js': '1\n',
  });
  const proceso = ['CHANGELOG.md', 'package.json', 'package-lock.json', 'plugins/p/.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.faro.json', 'faro/config.json', 'faro/ESTADO.md', 'faro/gestion/x.js', 'gestion/y.js', 'README.md', 'src/borrado.js'];
  for (let i = 0; i < 6; i++) {
    for (const f of [...proceso, 'src/a.js', 'test/a.test.mjs']) escribir(d, f, `${f.endsWith('.json') ? '{"v":' + i + '}' : '// ' + i}\n`);
    commit(d, `release ${i}`);
  }
  fs.rmSync(path.join(d, 'src', 'borrado.js'));
  commit(d, 'borra');
  M.minar(d, { home: homeVacio() });
  const co = candidatos(d).filter((c) => c.fuente.tipo === 'cochange');
  assert.deepStrictEqual(co.map((c) => [...c.toca].sort()), [['src/a.js', 'test/a.test.mjs']], JSON.stringify(co.map((c) => c.toca)));
});

test('regenerar: los pendientes que ya no pasan el filtro se borran; aceptados, descartados y externos se quedan', () => {
  const d = repo();
  const home = homeVacio();
  const jsonl = conversacion(home, d, 's.jsonl', [asis('hecho'), usu('no, eso no: src/a.js no se toca')]);
  M.minar(d, { home });
  const bueno = candidatos(d).find((c) => c.fuente.tipo === 'conversacion');
  assert.ok(bueno);
  // candidatos que dejo la version ruidosa: misma forma, ids de fuentes que ya no salen
  const viejo = (tipo, ref, extra = {}) => {
    const c = { id: M.idDe({ tipo, ref }), fuente: { tipo, ref, ...extra }, tipo_sugerido: 'cuidado', toca: [], fragmento: 'ruido', refs: [], puntuacion: 9, creado: '2026-01-01T00:00:00.000Z' };
    escribir(d, `faro/.cache/candidatos/${c.id}.json`, JSON.stringify(c));
    return c.id;
  };
  const rConv = viejo('conversacion', 's.jsonl#L99');
  const rCo = viejo('cochange', 'CHANGELOG.md|package.json');
  const rRev = viejo('revert', 'deadbeef');
  const ext = viejo('revision', 'PR#1/2', { externa: true });
  const desc = viejo('cochange', 'a|b');
  M.marcar(d, desc, 'descartados');
  // la version anterior del filtro: las conversaciones se releen aunque no cambien
  const est = JSON.parse(fs.readFileSync(path.join(dirCand(d), '_estado.json'), 'utf8'));
  delete est.filtro;
  fs.writeFileSync(path.join(dirCand(d), '_estado.json'), JSON.stringify(est));
  M.minar(d, { home });
  const ids = candidatos(d).map((c) => c.id);
  assert.ok(ids.includes(bueno.id), 'el que pasa el filtro se queda');
  assert.ok(ids.includes(ext), 'los de la forja no se tocan al minar en local');
  for (const id of [rConv, rCo, rRev]) assert.ok(!ids.includes(id), id);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dirCand(d), '_estado.json'), 'utf8')).descartados.includes(desc));
  assert.ok(fs.existsSync(jsonl));
});

test('conversacion: solo eventos cuyo cwd es este repo o un subdirectorio (slugs que colisionan, sin cwd)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-slug-'));
  const d = path.join(base, 'repo-v2');
  const otro = path.join(base, 'repo_v2'); // mismo slug que repo-v2
  for (const r of [d, otro]) { fs.mkdirSync(r); git(r, 'init', '-q', '-b', 'main'); escribir(r, 'src/a.js', '1\n'); commit(r, 'base'); }
  const home = homeVacio();
  const corr = (cwd) => [{ ...asis('hecho'), cwd }, { ...usu('no, eso no: src/a.js no se toca'), cwd }];
  conversacion(home, d, 'otro.jsonl', corr(otro));
  conversacion(home, d, 'sin.jsonl', corr(null));
  M.minar(d, { home });
  assert.deepStrictEqual(candidatos(d).filter((c) => c.fuente.tipo === 'conversacion'), [], 'ni de otro repo ni sin cwd');
  const sub = path.join(d, 'src');
  const cwdSub = process.platform === 'win32' ? sub.toUpperCase().split('\\').join('/') : sub;
  conversacion(home, d, 'sub.jsonl', corr(cwdSub));
  M.minar(d, { home });
  const conv = candidatos(d).filter((c) => c.fuente.tipo === 'conversacion');
  assert.strictEqual(conv.length, 1, JSON.stringify(conv));
  assert.match(conv[0].fuente.ref, /^sub\.jsonl#/);
});

test('conversacion: ruta del repo con espacios o acentos no genera toca falsos', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-esp-'));
  const d = path.join(base, 'Ana Pérez', 'mi repo');
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  escribir(d, 'src/a.js', '1\n');
  commit(d, 'base');
  const home = homeVacio();
  const abs = path.join(d, 'src', 'a.js');
  conversacion(home, d, 's.jsonl', [
    asis(`Edito ${abs}`, [{ type: 'tool_use', id: 'e', name: 'Edit', input: { file_path: abs } }]),
    usu(`no hagas eso en ${abs}`),
  ]);
  M.minar(d, { home });
  const conv = candidatos(d).filter((c) => c.fuente.tipo === 'conversacion');
  assert.strictEqual(conv.length, 1, JSON.stringify(conv));
  assert.deepStrictEqual(conv[0].toca, ['src/a.js']);
});

// ---------- Requisito: nada se guarda sin confirmacion ----------

test('lista no escribe nada versionado y ordena por puntuacion; ver muestra un candidato', () => {
  const d = repo();
  escribir(d, 'src/c.js', 'module.exports = 30;\n');
  commit(d, 'cambio c');
  git(d, 'revert', '--no-edit', 'HEAD');
  const home = homeVacio();
  conversacion(home, d, 's1.jsonl', [asis('hecho'), usu('no, eso no: src/a.js no se toca')]);
  correr(d, ['minar'], { home });
  const antes = git(d, 'status', '--porcelain', '--', 'faro/gestion').stdout;
  const l = correr(d, ['lista']);
  assert.strictEqual(l.code, 0);
  assert.strictEqual(git(d, 'status', '--porcelain', '--', 'faro/gestion').stdout, antes);
  assert.ok(!fs.existsSync(dirApr(d)));
  const lineas = l.out.split('\n').filter((x) => /^\[?[0-9a-f]{8}/.test(x) || /^c:/.test(x));
  assert.ok(lineas.length >= 2, l.out);
  const pts = candidatos(d).sort((a, b) => b.puntuacion - a.puntuacion);
  assert.ok(lineas[0].includes(pts[0].id.slice(0, 8)), 'el mas valioso primero');
  const corta = correr(d, ['lista', '--presupuesto', '2']);
  assert.ok(corta.out.split('\n').length <= 2);
  const v = correr(d, ['ver', pts[0].id.slice(0, 8)]);
  assert.match(v.out, new RegExp(pts[0].fuente.tipo));
  assert.match(correr(d, ['ver', 'ffffffff']).out, /no existe/);
});

test('guardar sin --confirmo no escribe; con --confirmo escribe; descartar marca', () => {
  const d = repo();
  const sin = correr(d, ['guardar', '--tipo', 'cuidado', '--titulo', 'Ojo con b', '--toca', 'src/b.js,src/a.js', '--cuerpo', 'Se lee en caliente.']);
  assert.strictEqual(sin.code, 0);
  assert.match(sin.out, /guardaría AP-001/);
  assert.match(sin.out, /--confirmo/);
  assert.ok(!fs.existsSync(dirApr(d)) || !fs.readdirSync(dirApr(d)).length);
  const con = correr(d, ['guardar', '--confirmo', '--tipo', 'cuidado', '--titulo', 'Ojo con b', '--toca', 'src/b.js,src/a.js', '--cuerpo', 'Se lee en caliente.']);
  assert.strictEqual(con.code, 0, con.out);
  assert.deepStrictEqual(A.leer(d)[0].toca, ['src/b.js', 'src/a.js']);
  assert.strictEqual(correr(d, ['guardar', '--confirmo', '--tipo', 'raro', '--titulo', 'x', '--cuerpo', 'y']).code, 2);
  assert.strictEqual(correr(d, ['descartar', 'abcdef12']).code, 2);
  assert.strictEqual(correr(d, ['nada']).code, 2);
});

test('ids de fuera: descartar ../../x no borra nada; un candidato con id manipulado se ignora', () => {
  const d = repo();
  escribir(d, 'x.json', '{"intocable":true}\n');
  escribir(d, 'faro/.cache/candidatos/x.json', '{}\n');
  escribir(d, 'faro/x.json', '{}\n'); // destino real de ../../x desde la carpeta de candidatos
  for (const id of ['../../x', '../x', '..', 'abc/../../x']) {
    const r = correr(d, ['descartar', id]);
    assert.strictEqual(r.code, 2, id);
    assert.match(r.out, /no existe o no es un id válido/);
    assert.strictEqual(correr(d, ['guardar', '--confirmo', '--tipo', 'cuidado', '--titulo', 't', '--candidato', id, '--cuerpo', 'c']).code, 2);
  }
  assert.ok(fs.existsSync(path.join(d, 'x.json')) && fs.existsSync(path.join(d, 'faro/x.json')) && fs.existsSync(path.join(d, 'faro/.cache/candidatos/x.json')));
  assert.throws(() => M.marcar(d, '../../x', 'descartados'), /no válido/);
  assert.ok(fs.existsSync(path.join(d, 'x.json')));
  // fichero con nombre valido pero id interno que apunta fuera: no es un pendiente y no se puede marcar
  const falso = 'abcdef0123456789';
  escribir(d, `faro/.cache/candidatos/${falso}.json`, JSON.stringify({ id: '../../x', fuente: { tipo: 'git', ref: 'r' }, tipo_sugerido: 'cuidado', toca: [], fragmento: 'f', refs: [], puntuacion: 9 }));
  assert.deepStrictEqual(M.pendientes(d), []);
  assert.strictEqual(correr(d, ['descartar', falso.slice(0, 8)]).code, 2);
  assert.ok(fs.existsSync(path.join(d, 'x.json')));
});

// ---------- Requisito: el revisor recibe los cuidados que toca el cambio ----------

test('cuidados: cuidado y decidido vigentes que cruzan con el diff; descartado y ajenos fuera', () => {
  const d = repo();
  A.guardar(d, { tipo: 'cuidado', titulo: 'B en caliente', toca: ['src/b.js'], cuerpo: 'x' });
  A.guardar(d, { tipo: 'decidido', titulo: 'C es puro', toca: ['src/c.js'], cuerpo: 'x' });
  A.guardar(d, { tipo: 'descartado', titulo: 'B con cache', toca: ['src/b.js'], cuerpo: 'x' });
  A.guardar(d, { tipo: 'decidido', titulo: 'B fachada', toca: ['src/b.js'], cuerpo: 'x' });
  commit(d, 'aprendizajes');
  git(d, 'checkout', '-q', '-b', 'feat/x');
  escribir(d, 'src/b.js', 'module.exports = 2;\n');
  commit(d, 'toca b');
  const r = correr(d, ['cuidados']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /base main/);
  assert.match(r.out, /AP-001 \[cuidado\] B en caliente/);
  assert.match(r.out, /AP-004 \[decidido\] B fachada/);
  assert.doesNotMatch(r.out, /AP-002|AP-003/);
  const rb = correr(d, ['cuidados', '--base', 'HEAD']);
  assert.doesNotMatch(rb.out, /AP-001/);
});

test('cuidados --rama: desde la base (como consolidar) compara la rama del PR sin checkout', () => {
  const d = repo();
  A.guardar(d, { tipo: 'cuidado', titulo: 'B en caliente', toca: ['src/b.js'], cuerpo: 'x' });
  A.guardar(d, { tipo: 'decidido', titulo: 'C es puro', toca: ['src/c.js'], cuerpo: 'x' });
  commit(d, 'aprendizajes');
  git(d, 'checkout', '-q', '-b', 'feat/x');
  escribir(d, 'src/b.js', 'module.exports = 2;\n');
  commit(d, 'toca b');
  git(d, 'checkout', '-q', 'main');
  assert.match(correr(d, ['cuidados']).out, /aprender cuidados: 0/, 'sin --rama, desde main no hay nada');
  const r = correr(d, ['cuidados', '--rama', 'feat/x']);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /rama feat\/x · base main/);
  assert.match(r.out, /AP-001 \[cuidado\] B en caliente/);
  assert.doesNotMatch(r.out, /AP-002/);
  assert.match(correr(d, ['cuidados', '--rama', 'feat/x', '--base', 'main']).out, /AP-001/);
  assert.strictEqual(correr(d, ['cuidados', '--rama', 'no-existe']).code, 2);
  assert.strictEqual(correr(d, ['cuidados', '--rama', '--x']).code, 2);
});

test('skills: aprender pide confirmacion; pr y consolidar pasan aprender cuidados al revisor', () => {
  const s = fs.readFileSync(path.join(SKILLS, 'aprender', 'SKILL.md'), 'utf8');
  assert.match(s, /^---\r?\ndescription: "Úsala/);
  for (const t of ['aprender minar', 'aprender lista', 'aprender ver', 'AskUserQuestion', 'aprender guardar --confirmo', 'aprender descartar']) assert.ok(s.includes(t), t);
  assert.doesNotMatch(s, new RegExp(["frac", "talia"].join(""), "i")); // la marca no va literal: este test se publica
  for (const k of ['pr', 'consolidar']) {
    const t = fs.readFileSync(path.join(SKILLS, k, 'SKILL.md'), 'utf8');
    assert.match(t, /harness\.js" aprender cuidados/, k);
    assert.match(t, /revisor-code/, k);
  }
  assert.match(fs.readFileSync(path.join(SKILLS, 'consolidar', 'SKILL.md'), 'utf8'), /aprender cuidados --rama origin\/<rama-del-PR>/);
  assert.doesNotMatch(fs.readFileSync(path.join(SKILLS, 'pr', 'SKILL.md'), 'utf8'), /aprender cuidados --rama/);
});

test('harness.js aprender despacha al CLI', () => {
  const d = repo();
  const r = spawnSync(process.execPath, [HARNESS, 'aprender', 'lista'], { cwd: d, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: d }, timeout: 60000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /aprender: 0 vigentes · 0 por revisar/);
});

// ---------- Requisito: el minado incremental corre en segundo plano ----------

test('grafo construir --fondo mina tras construir, en silencio, y no re-mina en 10 min', () => {
  const d = repo();
  escribir(d, 'src/c.js', 'module.exports = 30;\n');
  commit(d, 'cambio c');
  git(d, 'revert', '--no-edit', 'HEAD');
  const l = [];
  let t = Date.parse('2026-11-13T10:00:00Z');
  const ahora = () => t;
  const code = G.cli(['construir', '--fondo'], { root: d, out: (x) => l.push(x), ahora, home: homeVacio() });
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(l, []);
  assert.ok(fs.existsSync(I.rutaIndice(d)));
  assert.ok(candidatos(d).some((c) => c.fuente.tipo === 'revert'));
  // indice fresco y minado reciente: no hace nada (aunque haya un revert nuevo)
  for (const f of fs.readdirSync(dirCand(d))) if (f !== '_estado.json') fs.unlinkSync(path.join(dirCand(d), f));
  t += 5 * 60 * 1000;
  G.cli(['construir', '--fondo'], { root: d, out: (x) => l.push(x), ahora, home: homeVacio() });
  assert.strictEqual(candidatos(d).length, 0);
  // pasado el margen, con el indice ya fresco, vuelve a minar
  t += 6 * 60 * 1000;
  G.cli(['construir', '--fondo'], { root: d, out: (x) => l.push(x), ahora, home: homeVacio() });
  assert.ok(candidatos(d).some((c) => c.fuente.tipo === 'revert'));
  assert.deepStrictEqual(l, []);
  // un minado que revienta no hace fallar el fondo
  const orig = M.minar;
  M.minar = () => { throw new Error('boom'); };
  try { t += 20 * 60 * 1000; assert.strictEqual(G.cli(['construir', '--fondo'], { root: d, out: (x) => l.push(x), ahora }), 0); } finally { M.minar = orig; }
  assert.deepStrictEqual(l, []);
});
