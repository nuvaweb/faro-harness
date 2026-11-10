// Un repo que AUN NO ha adoptado FARO no se toca. Ni se le crean carpetas, ni se le ordena nada.
//
// El bug que motiva esto: abrir un repo legacy con el plugin instalado bastaba para que FARO se
// considerara duenno del repo. La cadena completa, medida:
//   1. SessionStart creaba 14 carpetas (gestion/, documentos/, src/, borrador/...) encima del repo
//      ajeno, en CADA arranque y sin preguntar.
//   2. Se inyectaba en el contexto del modelo "ONBOARDING — OBLIGATORIO completarlo ANTES de
//      cualquier otra tarea: crea ESTADO.md", y se REPETIA en CADA prompt.
//   3. El agente obedecia (es una instruccion de sistema imperativa) y creaba ESTADO.md, estando en
//      develop.
//   4. El gate de Stop bloqueaba el turno exigiendo commitearlo.
//   5. El propio motor PROHIBE commitear en develop -> callejon sin salida.
//
// El error esta en 1 y 2: todo lo demas es consecuencia mecanica y correcta DADO que el repo se
// considera instancia. La marca de adopcion es EXPLICITA (.faro.json o ESTADO.md) y deliberadamente
// NO cuenta tener el plugin instalado: eso dice que el USUARIO usa FARO, no que ESTE repo quiera
// ser gobernado por el.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'harness.js');

// Un repo de verdad: con codigo propio, historia y NADA de FARO.
function repoLegacy({ adoptado = false, rama = 'develop' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-legacy-'));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', rama);
  git('config', 'user.email', 't@t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'index.js'), "console.log('hola')\n");
  fs.writeFileSync(path.join(dir, 'README.md'), '# Mi proyecto\n');
  if (adoptado) fs.writeFileSync(path.join(dir, '.faro.json'), JSON.stringify({ domain: 'x', concept: 'y' }));
  git('add', '-A'); git('commit', '-q', '-m', 'proyecto legacy');
  return dir;
}
const corre = (dir, cmd, entrada) => spawnSync(process.execPath, [HARNESS, cmd], {
  cwd: dir, encoding: 'utf8', timeout: 60000, input: entrada,
  env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
});
const contexto = (r) => {
  try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext || ''; } catch { return r.stdout; }
};

// ---------- no escribir ----------

test('arrancar en un repo sin adoptar NO crea ni una carpeta', () => {
  const dir = repoLegacy();
  const antes = fs.readdirSync(dir).sort();
  corre(dir, 'session');
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), antes,
    'el arranque escribio en el repo de otro sin que nadie lo pidiera');
});

test('y el repo queda LIMPIO en git (ni un fichero suelto)', () => {
  const dir = repoLegacy();
  corre(dir, 'session');
  const st = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(st.stdout.trim(), '', `el arranque dejo cambios sin commitear:\n${st.stdout}`);
});

// La misma guarda tiene que estar en validate: tambien creaba el andamiaje.
test('validate tampoco crea el andamiaje en un repo sin adoptar', () => {
  const dir = repoLegacy();
  const antes = fs.readdirSync(dir).sort();
  corre(dir, 'validate');
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), antes);
});

// ---------- no ordenar ----------

test('NO se ordena el onboarding: se OFRECE /faro:adoptar', () => {
  const ctx = contexto(corre(repoLegacy(), 'session'));
  assert.ok(!/OBLIGATORIO/.test(ctx), `sigue ordenando: ${ctx.slice(0, 400)}`);
  assert.match(ctx, /NO crees (faro\/)?ESTADO\.md/i,'debe decir explicitamente que no lo cree');
  assert.match(ctx, /faro:adoptar/, 'y ofrecer el camino correcto para un repo con historia');
});

// Este era el martillo: la MISMA orden reinyectada turno tras turno. Un agente que la ve en cada
// prompt no esta decidiendo nada, esta obedeciendo.
test('prompt-context NO reinyecta nada en cada turno', () => {
  const r = corre(repoLegacy(), 'prompt-context', '{"prompt":"hola"}');
  assert.strictEqual(r.stdout.trim(), '', `martillea en cada prompt:\n${r.stdout}`);
});

test('no se afirma que al repo le falte nada (no le falta: no es suyo)', () => {
  const ctx = contexto(corre(repoLegacy(), 'session'));
  assert.ok(!/falta el funcional/i.test(ctx), `le dice al agente que hay algo roto: ${ctx.slice(0, 400)}`);
  assert.ok(!/onboarding requerido/i.test(ctx), ctx.slice(0, 400));
  // Y tampoco se le llama "workspace de documentacion": tiene codigo, es el repo de alguien.
  assert.ok(!/workspace de DOCUMENTACION, NO de codigo/.test(ctx), ctx.slice(0, 300));
});

// ---------- la frontera: vacio vs con trabajo propio ----------
//
// "No tiene ESTADO.md" NO basta para eximir: un repo RECIEN CREADO por el CLI de FARO tampoco lo
// tiene, y ahi el onboarding SI es la tarea (es un repo vacio esperando que lo definan). Lo que
// distingue un caso del otro es que haya TRABAJO PROPIO PREVIO. Este matiz se rompio una vez: la
// primera version eximia a cualquier repo sin ESTADO.md y dejo mudo el onboarding de los repos
// nuevos, que es justo para lo que existe.

test('un repo VACIO recien creado SI recibe el onboarding (es para lo que se creo)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-nuevo-'));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'develop');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n');   // un README suelto no es trabajo previo
  git('add', '-A'); git('commit', '-q', '-m', 'init');
  const ctx = contexto(corre(dir, 'session'));
  assert.ok(!/AUN NO usa FARO/.test(ctx), `un repo vacio no debe recibir la oferta:\n${ctx.slice(0, 300)}`);
  assert.match(ctx, /ONBOARDING|onboarding/, 'y SI debe recibir el onboarding');
});

test('en cuanto hay codigo propio, deja de ser un repo nuevo', () => {
  const ctx = contexto(corre(repoLegacy(), 'session'));   // repoLegacy trae app/index.js
  assert.match(ctx, /AUN NO usa FARO/, 'con trabajo propio, se ofrece en vez de ordenar');
  assert.ok(!/OBLIGATORIO/.test(ctx), ctx.slice(0, 300));
});

// ---------- el analisis SI se hace: en background ----------
//
// Matiz que costo una correccion: el analisis del repo NO sobraba —el usuario lo queria—. Lo que
// sobraba era hacerlo BLOQUEANDO el arranque y ordenando crear ESTADO.md antes de nada. Asi que se
// mueve al vigilante, que ya corria en background con asyncRewake y ya sabia despertar al agente.

test('el vigilante SI reconoce el repo, y lo cuenta (el analisis no sobraba: sobraba bloquear)', () => {
  const dir = repoLegacy();
  const r = spawnSync(process.execPath, [HARNESS, 'vigilar'], {
    cwd: dir, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'faro-dat-')) },
  });
  assert.strictEqual(r.status, 2, `debe despertar al agente con lo que vio:\n${r.stderr}`);
  assert.match(r.stderr, /He mirado este repo/i, r.stderr);
  assert.match(r.stderr, /sin tocar nada/i, 'lo primero que el usuario necesita saber');
  assert.match(r.stderr, /faro:adoptar/, 'y el camino, ofrecido una vez');
});

// Contarlo en cada sesion seria el mismo martillo con otro tono.
test('solo lo cuenta la PRIMERA vez por repo', () => {
  const dir = repoLegacy();
  const datos = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-dat-'));
  const corre1 = () => spawnSync(process.execPath, [HARNESS, 'vigilar'], {
    cwd: dir, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_DATA: datos },
  });
  assert.strictEqual(corre1().status, 2, 'la primera vez habla');
  const dos = corre1();
  assert.strictEqual(dos.status, 0, `la segunda calla:\n${dos.stderr}`);
  assert.strictEqual(dos.stderr.trim(), '');
});

// ---------- un repo adoptado sigue gobernado igual ----------

test('con .faro.json el ciclo completo vuelve a aplicar (no se rompe lo que funcionaba)', () => {
  const dir = repoLegacy({ adoptado: true });
  corre(dir, 'session');
  assert.ok(fs.existsSync(path.join(dir, 'gestion')), 'un repo adoptado SI recibe el andamiaje');
  const ctx = contexto(corre(dir, 'session'));
  assert.ok(!/AUN NO usa FARO/.test(ctx), 'ya lo adopto: no se le puede seguir ofreciendo');
});

test('con ESTADO.md tambien cuenta como adoptado, aunque no haya .faro.json', () => {
  const dir = repoLegacy();
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), '---\niniciativa: T\n---\n### Fase 1 · X — in_progress\n');
  const ctx = contexto(corre(dir, 'session'));
  assert.ok(!/AUN NO usa FARO/.test(ctx), 'tener faseo ES haber adoptado');
});

// ---------- el bucle auto-generar -> auto-bloquear ----------

// El informe semanal lo escribe el harness SOLO, en cada SessionStart. Bloquear el turno por el es
// castigar al usuario por algo que hizo el motor, y cerraba un bucle: generar -> bloquear ->
// commitear -> generar.
test('el informe semanal auto-generado NO bloquea el turno', () => {
  const dir = repoLegacy({ adoptado: true, rama: 'docs/x' });
  fs.mkdirSync(path.join(dir, 'gestion', 'reporting', 'informes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'gestion', 'reporting', 'informes', '2026-09-22-semanal-informe.md'), '# Semanal\n');
  const r = corre(dir, 'stop-check', '{"stop_hook_active":false}');
  assert.strictEqual(r.status, 0, `el semanal no puede bloquear, lo genero el motor:\n${r.stderr}`);
});

// Pero un informe que SI escribio alguien a proposito sigue bloqueando: esa regla no se toca.
test('otro informe de reporting sigue bloqueando (esa regla no cambia)', () => {
  const dir = repoLegacy({ adoptado: true, rama: 'docs/x' });
  fs.mkdirSync(path.join(dir, 'gestion', 'reporting', 'informes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'gestion', 'reporting', 'informes', '2026-09-22-fase-1-informe.md'), '# Fase 1\n');
  const r = corre(dir, 'stop-check', '{"stop_hook_active":false}');
  assert.strictEqual(r.status, 2, 'un informe de cierre de fase sin commitear si debe bloquear');
});
