// Un ESTADO.md MIGRADO por /faro:migrar-tareas tiene que pasar validate — y la skill y el gate
// tienen que pedir el MISMO formato.
//
// Historia: la 0.32.0 hizo que la skill sustituyera los checkboxes de cada fase por un puntero al
// hito ('Tareas: ver hito...'), y estado.js lo acepto. Pero el formato rigido de fases abiertas
// (huecosDeFase, lib/ciclo.js) exige una linea por issue para contabilizar y cruzar con la forja,
// asi que seguir la skill dejaba toda fase abierta en 'no declara ninguna tarea'. Probado en una
// instancia real el 2026-09-23 y revertido a mano.
//
// Regla vigente (0.52.1): cada fase lleva una linea '- [ ] #N · titulo — @quien' por issue de su
// hito ('[x]' si esta cerrado). 'Tareas: ver hito...' solo se tolera en fases CERRADAS (historico).
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${n}-`));

function repoCon(fases, nombre) {
  const dir = tmp(nombre);
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'documentos', 'funcional'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'documentos', 'funcional', 'x.md'), '# funcional\n');
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), `---
nombre: proyecto
clave: PRU
objetivo: Prueba
estado: in_progress
fases_total: ${fases.split('### Fase').length - 1}
fase_actual: 1
owner: tester
funcional: documentos/funcional/x.md
---
${fases}`);
  return dir;
}
const validar = (dir) => spawnSync(process.execPath, [HARNESS, 'validate'], { cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
const salida = (dir) => (({ stdout, stderr }) => `${stdout}${stderr}`)(validar(dir));

test('fase ABIERTA con la plantilla de /faro:migrar-tareas (una linea #N · titulo — @quien por issue): valida sin huecos de faseo', () => {
  const todo = salida(repoCon(`### Fase 1 · Fundamentos — in_progress
Fijar el modelo de datos y la persistencia.
Objetivo: 2026-10-30

- [x] #12 · Identidad y marca — @ana
- [ ] #13 · Pantallas del informe — @luis

### Fase 2 · Resto — pending
Montar el resto del sistema.
Objetivo: 2026-12-01

- [ ] #14 · Integracion con el origen de datos — @ana
`, 'migrado-plantilla'));
  assert.doesNotMatch(todo, /\[faseo\] Fase [12]/, `seguir la skill al pie de la letra no puede dejar huecos de faseo:\n${todo}`);
  assert.doesNotMatch(todo, /Fase [12] sin tareas/, todo);
});

test("fase ABIERTA que sustituye sus tareas por 'Tareas: ver hito': SIGUE siendo un error (formato retirado en 0.52.1)", () => {
  const todo = salida(repoCon(`### Fase 1 · Fundamentos — in_progress
Fijar el modelo de datos.
Objetivo: 2026-10-30
Tareas: ver hito de esta fase en la forja (\`harness.js hito\`).
`, 'migrado-puntero-abierta'));
  assert.match(todo, /Fase 1: no declara ninguna tarea/, `sin lineas por issue la fase no se contabiliza:\n${todo}`);
  assert.match(todo, /Fase 1 sin tareas/, 'estado.js y ciclo.js aplican la MISMA regla');
});

test('el mensaje de fase sin tareas ensena el formato bueno, no el puntero al hito', () => {
  const todo = salida(repoCon(`### Fase 1 · Fundamentos — in_progress
Fijar el modelo de datos.
Objetivo: 2026-10-30
`, 'vacia-error'));
  assert.match(todo, /Fase 1 sin tareas/, todo);
  assert.match(todo, /#N · titulo — @quien/, 'debe decir como se escribe la linea');
  assert.doesNotMatch(todo, /Tareas: ver hito de esta fase/, 'no puede recomendar el formato que el propio gate rechaza');
});

test('ESTADO.md CLASICO (checkboxes a mano): sigue sin error de fase sin tareas', () => {
  const todo = salida(repoCon(`### Fase 1 · Fundamentos — in_progress
- [ ] una tarea escrita a mano
`, 'clasico-ok'));
  assert.doesNotMatch(todo, /Fase 1 sin tareas/, todo);
});

test("fase CERRADA migrada con el formato antiguo ('Tareas: ver hito'): se tolera, es historico", () => {
  const todo = salida(repoCon(`### Fase 1 · Fundamentos — done
Objetivo: 2026-08-01
Tareas: ver hito de esta fase en la forja (\`harness.js hito\`).

### Fase 2 · Resto — in_progress
Montar el resto.
Objetivo: 2026-12-01

- [ ] #14 · Integracion — @ana
`, 'migrado-done'));
  assert.doesNotMatch(todo, /Fase 1 sin tareas/, todo);
  assert.doesNotMatch(todo, /tarea\(s\) abiertas/, 'sin checkboxes no se puede afirmar que queden abiertas: eso lo sabe el hito');
});

test('fase ABIERTA con lineas por issue SIGUE exigiendo descripcion y objetivo', () => {
  const todo = salida(repoCon(`### Fase 1 · Fundamentos — in_progress
- [ ] #12 · Identidad y marca — @ana
`, 'migrado-sin-desc'));
  assert.match(todo, /Fase 1: falta la descripcion/);
  assert.match(todo, /Fase 1: falta 'Objetivo/);
});
