// #127 (revision de seguridad del PR #144) — la SALIDA TEMPRANA de pre-bash no puede saltarse guardas.
//
// La primera version decidia con una lista negra propia (NOMBRA_SENSIBLE), distinta de la de las
// guardas: 'type apps\dashboard\.dev.vars' (type LEE ficheros en cmd/PowerShell), comodines como
// 'type .dev.*' o 'dir *.pem' y 'ls ~/.ssh' salian por la via temprana sin pasar por las guardas.
// Ahora la via temprana solo acepta ordenes SIN operandos de una lista cerrada; todo lo demas va por
// el camino completo.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const { esOrdenInocua } = createRequire(import.meta.url)(path.join(HOOKS, 'lib', 'orden-inocua.js'));

const NO_TEMPRANAS = [
  'type apps\\dashboard\\.dev.vars', 'type .dev.vars', 'type .dev.*', 'type .env',
  'dir *.pem', 'dir apps\\*.key', 'ls ~/.ssh', 'ls ~', 'ls .ssh', 'ls *.pem', 'ls [a-z]*', 'ls {a,b}',
  'echo $(cat .env)', 'echo `cat .env`', 'echo ${HOME}', 'echo %USERPROFILE%', 'echo @(gc .env)',
  'echo hola', 'printf %s x', 'cat .env', 'cd ~', 'which node', 'ls; cat .env', 'ls && cat .env',
  'ls | xargs cat', 'ls > fichero', 'pwd\ncat .env', 'ls -la apps', 'dir "C:\\x"',
];
const TEMPRANAS = ['ls', 'ls -la', 'pwd', 'dir', 'dir /w', 'date', 'whoami', 'true', '  ls --all  '];

test('la via temprana NO acepta lecturas, comodines, expansiones, encadenados ni operandos', () => {
  for (const c of NO_TEMPRANAS) assert.strictEqual(esOrdenInocua(c), false, `se colaria por la via temprana: ${c}`);
});

test('la via temprana SI acepta las ordenes inocuas sin operandos', () => {
  for (const c of TEMPRANAS) assert.strictEqual(esOrdenInocua(c), true, `deberia ser inocua: ${c}`);
});

// Equivalencia: si la via temprana sale con 0, la guarda COMPLETA tambien permite (nada que decir).
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-prebash-'));
  const sh = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  sh('init', '-q'); sh('config', 'user.email', 't@t'); sh('config', 'user.name', 'T'); sh('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), '---\niniciativa: X\n---\n');
  sh('add', '-A'); sh('commit', '-q', '-m', 'x');
  return dir;
}
const preBash = (dir, command, extraEnv = {}) => spawnSync(process.execPath, [path.join(HOOKS, 'harness.js'), 'pre-bash'], {
  cwd: dir, encoding: 'utf8', timeout: 60000, input: JSON.stringify({ tool_input: { command } }),
  env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...extraEnv },
});

test('equivalencia: lo que la via temprana deja pasar, la guarda completa tambien lo permite', () => {
  const dir = repo();
  for (const c of [...TEMPRANAS, ...NO_TEMPRANAS]) {
    if (!esOrdenInocua(c)) continue;
    const completa = preBash(dir, c, { FARO_SIN_SALIDA_TEMPRANA: '1' });
    assert.strictEqual(completa.status, 0, c);
    assert.ok(!/"permissionDecision"/.test(completa.stdout), `la guarda completa decide algo sobre '${c}':\n${completa.stdout}`);
  }
});

test('las lecturas de credenciales siguen bloqueadas de punta a punta', () => {
  const dir = repo();
  for (const c of ['type .env', 'cat .env']) {
    assert.match(preBash(dir, c).stdout, /"permissionDecision":"deny"/, c);
  }
  assert.strictEqual(preBash(dir, 'ls -la').stdout.trim(), '', 'una orden inocua sale en silencio');
  assert.strictEqual(preBash(dir, 'git status').status, 0, 'git status pasa (por el camino completo)');
});
