// Cambio 'cableado-y-salud-de-codigo': grafo de dependencias (ciclos/huerfanos) y cableado de los
// subcomandos con las skills y agentes que deben citarlos. Un test por escenario de los deltas.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(RAIZ, 'plugins', 'faro', 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');

const run = (args, cwd, env = {}) =>
  spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60000 });

// Repo con los ficheros que se le indiquen ({ 'a.js': 'contenido' }).
function repoCon(ficheros) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-grafo-'));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  // La firma de commits heredada de la config global (gpg/1Password/ssh-sign) puede fallar o
  // pedir interaccion y dejar el repo de prueba SIN COMMITS: entonces el harness no tiene nada
  // que gobernar y el test falla por el entorno. Se apaga solo aqui, no en la config del usuario.
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  git('remote', 'add', 'origin', 'git@github.com:x/y.git');
  for (const [rel, txt] of Object.entries(ficheros)) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), txt);
  }
  fs.writeFileSync(path.join(dir, 'README.md'), '# t\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}
const codigo = (dir) => run([HARNESS, 'codigo'], dir, { CLAUDE_PROJECT_DIR: dir });

// ---------- spec: salud-codigo ----------

test('grafo: dos modulos que se importan mutuamente forman un ciclo', () => {
  const dir = repoCon({
    'a.js': "const b = require('./b.js');\nmodule.exports = { b };\n",
    'b.js': "const a = require('./a.js');\nmodule.exports = { a };\n",
  });
  const r = codigo(dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 ciclo\(s\)/);
  assert.ok(/a\.js/.test(r.stdout) && /b\.js/.test(r.stdout), 'el ciclo debe nombrar ambos modulos');
});

test('grafo: cadena de tres modulos que se cierra tambien es ciclo', () => {
  const dir = repoCon({
    'a.js': "require('./b.js');\n",
    'b.js': "require('./c.js');\n",
    'c.js': "require('./a.js');\n",
  });
  const r = codigo(dir);
  assert.match(r.stdout, /1 ciclo\(s\)/);
  for (const f of ['a.js', 'b.js', 'c.js']) assert.ok(r.stdout.includes(f), `falta ${f} en el ciclo`);
});

test('grafo: sin ciclos lo declara explicitamente', () => {
  const dir = repoCon({
    'index.js': "require('./util.js');\n",
    'util.js': "module.exports = 1;\n",
  });
  const r = codigo(dir);
  assert.match(r.stdout, /Sin ciclos/);
});

test('grafo: un modulo que nadie importa sale como posible huerfano', () => {
  const dir = repoCon({
    'index.js': "require('./usado.js');\n",
    'usado.js': "module.exports = 1;\n",
    'olvidado.js': "module.exports = 2;\n",
  });
  const r = codigo(dir);
  assert.match(r.stdout, /olvidado\.js/);
  assert.ok(!/^\s+usado\.js$/m.test(r.stdout), 'usado.js si esta importado, no es huerfano');
});

test('grafo: tests y puntos de entrada NO cuentan como huerfanos', () => {
  const dir = repoCon({
    'index.js': "require('./lib.js');\n",          // entrada declarada en el contrato
    'lib.js': "module.exports = 1;\n",
    'test/algo.test.mjs': "import assert from 'node:assert';\n",
  });
  const r = codigo(dir);
  assert.match(r.stdout, /MODULOS QUE NADIE IMPORTA[\s\S]*?Ninguno/,
    `esperaba cero huerfanos, salio:\n${r.stdout}`);
});

test('grafo: resuelve las rutas CALCULADAS path.join(__dirname, ...) del propio motor', () => {
  // Sin esto, todo lib/ del harness salia como huerfano (16 falsos positivos reales).
  const dir = repoCon({
    'index.js': "const path=require('path');\nconst mod = path.join(__dirname, 'lib', 'nucleo.js');\nrequire(mod);\n",
    'lib/nucleo.js': "module.exports = 1;\n",
  });
  const r = codigo(dir);
  assert.ok(!/nucleo\.js/.test(r.stdout.split('MODULOS QUE NADIE IMPORTA')[1] || ''),
    `nucleo.js esta importado por ruta calculada y no deberia salir como huerfano:\n${r.stdout}`);
});

test('codigo: compone las tres senales y SALE EN 0 aunque haya deuda', () => {
  const dir = repoCon({
    'a.js': "require('./b.js');\n" + 'const x = 1;\n'.repeat(500),
    'b.js': "require('./a.js');\n",
  });
  const r = codigo(dir);
  assert.strictEqual(r.status, 0, 'un informe nunca devuelve error');
  assert.match(r.stdout, /ATOMICIDAD/);
  assert.match(r.stdout, /CICLOS DE DEPENDENCIA/);
  assert.match(r.stdout, /MODULOS QUE NADIE IMPORTA/);
});

test('sesion: un ciclo se anuncia; los huerfanos NO inundan el contexto', () => {
  const dir = repoCon({
    'a.js': "require('./b.js');\n",
    'b.js': "require('./a.js');\n",
    'suelto.js': "module.exports = 1;\n",
  });
  const r = run([HARNESS, 'session'], dir, { CLAUDE_PROJECT_DIR: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /CICLOS DE DEPENDENCIA/, 'la sesion deberia avisar del ciclo');
  assert.ok(!/suelto\.js/.test(r.stdout), 'los huerfanos no van al contexto de sesion');
});

// ---------- spec: cableado-comandos ----------

const leerTodo = (dirs) => dirs.flatMap((d) => {
  const out = [];
  (function rec(x) {
    for (const e of fs.readdirSync(x, { withFileTypes: true })) {
      const p = path.join(x, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.name.endsWith('.md')) out.push(fs.readFileSync(p, 'utf8'));
    }
  })(d);
  return out;
});

test('cableado: cada subcomando nuevo esta citado por alguna skill, agente o el README', () => {
  const textos = [
    ...leerTodo([path.join(RAIZ, 'plugins', 'faro', 'skills'), path.join(RAIZ, 'plugins', 'faro', 'agents')]),
    fs.readFileSync(path.join(RAIZ, 'README.md'), 'utf8'),
  ].join('\n');
  for (const cmd of ['forge', 'atomico', 'codigo']) {
    assert.ok(new RegExp(`\\b${cmd}\\b`).test(textos),
      `el subcomando '${cmd}' no lo cita nadie: el agente no lo usara nunca`);
  }
});

test('cableado: el agente gestor de plataforma comprueba la forja antes de operar', () => {
  const t = fs.readFileSync(path.join(RAIZ, 'plugins', 'faro', 'agents', 'gestor-forja.md'), 'utf8');
  assert.match(t, /harness\.js" forge/, 'no consulta la forja');
  assert.match(t, /PARA AQU/i, 'no ordena parar cuando la forja no es GitHub');
});

test('cableado: el revisor de codigo ejecuta el informe de salud del harness', () => {
  const t = fs.readFileSync(path.join(RAIZ, 'plugins', 'faro', 'agents', 'revisor-code.md'), 'utf8');
  assert.match(t, /harness\.js" codigo/, 'el revisor no pide el informe al harness');
});
