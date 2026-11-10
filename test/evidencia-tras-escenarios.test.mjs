// La linea 'Evidencia:' se detecta este donde este dentro del requisito — tambien DESPUES de los
// escenarios, que es donde se escribe de forma natural (al final del bloque, cuando ya has contado
// que hay que probar).
//
// El bug: 'parseLivingSpec' construye dos vistas de cada requisito — 'text' (cortado en el primer
// '#### Escenario:') y 'body' (el bloque entero) — y 'contarEvidencia' leia 'text'. Resultado: el
// comando decia "NO declara evidencia" con la evidencia escrita tres lineas mas abajo.
//
// Lo que costaba: el propio repo motor daba 47/47 requisitos "sin demostrar" TENIENDO los tests
// escritos. Un indicador que dice 0% cuando la realidad no lo es no se corrige: se ignora — y con el
// se ignora la senal entera.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(RAIZ, 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { evidenciaDeclarada } = require(path.join(HOOKS, 'lib', 'ciclo.js'));

// El formato real de una spec viva, con la evidencia donde la gente la escribe.
const SPEC = `# capacidad-x

## Proposito

Spec de prueba.

## Requisitos

### Requisito: El endpoint rechaza sin token

El sistema DEBE responder 401 cuando la peticion no trae token.

#### Escenario: sin token

- CUANDO la peticion no incluye token
- ENTONCES el sistema responde 401

Evidencia: test/auth.test.mjs
`;

// ---------- la unidad ----------

test('la evidencia se lee vaya donde vaya dentro del requisito', () => {
  assert.deepStrictEqual(evidenciaDeclarada('Evidencia: test/a.mjs\n\n#### Escenario: x'), ['test/a.mjs'], 'antes de los escenarios');
  assert.deepStrictEqual(evidenciaDeclarada('#### Escenario: x\n- CUANDO y\n\nEvidencia: test/a.mjs'), ['test/a.mjs'], 'DESPUES de los escenarios');
});

// ---------- el comando, que es donde estaba el fallo ----------

test('specs evidencia CUENTA la evidencia escrita tras los escenarios', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-ev-'));
  const cap = path.join(dir, 'gestion', 'cambios', 'specs', 'capacidad-x');
  fs.mkdirSync(cap, { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(cap, 'spec.md'), SPEC);
  fs.writeFileSync(path.join(dir, 'test', 'auth.test.mjs'), '// prueba el 401\n');

  const r = spawnSync(process.execPath, [path.join(HOOKS, 'harness.js'), 'specs', 'evidencia'], {
    cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  const salida = r.stdout + r.stderr;
  assert.match(salida, /demostrados:\s*1/, `la evidencia estaba escrita y no se conto:\n${salida}`);
  assert.strictEqual(r.status, 0, `no deberia fallar: ${salida}`);
});

// El otro lado: que siga detectando lo que SI falta. Un arreglo que hace pasar todo no arregla nada.
test('un requisito realmente sin evidencia se sigue señalando', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-ev-'));
  const cap = path.join(dir, 'gestion', 'cambios', 'specs', 'capacidad-x');
  fs.mkdirSync(cap, { recursive: true });
  fs.writeFileSync(path.join(cap, 'spec.md'), SPEC.replace(/\nEvidencia: .*\n/, '\n'));

  const r = spawnSync(process.execPath, [path.join(HOOKS, 'harness.js'), 'specs', 'evidencia'], {
    cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  assert.match(r.stdout + r.stderr, /NO declara evidencia/i, 'sin evidencia debe seguir avisando');
});

test('una evidencia que apunta a un fichero inexistente se señala', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-ev-'));
  const cap = path.join(dir, 'gestion', 'cambios', 'specs', 'capacidad-x');
  fs.mkdirSync(cap, { recursive: true });
  fs.writeFileSync(path.join(cap, 'spec.md'), SPEC);   // sin crear test/auth.test.mjs

  const r = spawnSync(process.execPath, [path.join(HOOKS, 'harness.js'), 'specs', 'evidencia'], {
    cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  assert.match(r.stdout + r.stderr, /NO existe|no existe/i, 'declarar una ruta rota no es demostrar');
});
