// doc-check sobre ESTADO.md: la INVALIDACION de la cache de faseo.
//
// Mismo patron de fallo que 'asignar-tarea' (labelsCatalogo): al mover parseEstado() a lib/estado.js,
// su cache `_ini` se volvio privada del modulo, pero la linea que la invalidaba se quedo en
// harness.js (`_ini = undefined;` dentro de cmdDocCheck). Bajo 'use strict' eso NO crea un global:
// lanza `ReferenceError: _ini is not defined` y MATA el hook PostToolUse justo despues de editar
// ESTADO.md — se pierden en silencio la validacion de faseo y el aviso de replanificacion.
//
// Dos exigencias, no una:
//  1) el hook NO puede reventar al escribir ESTADO.md;
//  2) la cache TIENE que invalidarse de verdad — si no, se valida el ESTADO.md ANTERIOR a la edicion
//     y un faseo recien roto pasaria por bueno (el fallo silencioso de verdad).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${n}-`));

// ESTADO.md con faseo INVALIDO: dos fases 'in_progress' a la vez (solo puede haber una activa).
const ESTADO_ROTO = `---
iniciativa: Prueba
clave: PRU
---

# Prueba

### Fase 1 · Arranque — in_progress
- [ ] algo

### Fase 2 · Segunda — in_progress
- [ ] otra cosa
`;
const ESTADO_OK = `---
iniciativa: Prueba
clave: PRU
---

# Prueba

### Fase 1 · Arranque — in_progress
- [ ] algo
`;

function repo(contenidoEstado) {
  const root = tmp('root');
  fs.writeFileSync(path.join(root, 'ESTADO.md'), contenidoEstado);
  return root;
}
function docCheck(root, filePath) {
  const payload = JSON.stringify({ tool_input: { file_path: filePath } });
  return spawnSync(process.execPath, [HARNESS, 'doc-check'], {
    cwd: root, input: payload, encoding: 'utf8',
    env: { ...process.env, FARO_CONFIG_PATH: path.join(tmp('cfg'), 'faro.json') },
  });
}

test('doc-check al editar ESTADO.md NO revienta con ReferenceError (la invalidacion de cache existe)', () => {
  const root = repo(ESTADO_OK);
  const r = docCheck(root, path.join(root, 'ESTADO.md'));
  const todo = `${r.stdout || ''}${r.stderr || ''}`;
  assert.doesNotMatch(todo, /ReferenceError/, `el hook no puede lanzar:\n${todo}`);
  assert.doesNotMatch(todo, /_ini is not defined/);
  assert.strictEqual(r.status, 0, `doc-check debe salir 0, salio ${r.status}:\n${todo}`);
});

test('doc-check detecta el faseo invalido de ESTADO.md (el hook llega a validar, no muere antes)', () => {
  const root = repo(ESTADO_ROTO);
  const r = docCheck(root, path.join(root, 'ESTADO.md'));
  const todo = `${r.stdout || ''}${r.stderr || ''}`;
  assert.doesNotMatch(todo, /ReferenceError/, todo);
  assert.match(todo, /VALIDACION FASEO/, `debe avisar del faseo invalido:\n${todo}`);
});

test('parseEstado: invalidar() releE de disco — sin ello se validaria el ESTADO.md ANTERIOR a la edicion', async () => {
  const mod = await import(`file://${path.join(HOOKS, 'lib', 'estado.js').replace(/\\/g, '/')}`);
  const root = repo(ESTADO_OK);
  // estado.js recibe TODO por ctx (fs/path incluidos): es una factory, no importa nada por su cuenta.
  const nodeFs = (await import('node:fs')).default;
  const nodePath = (await import('node:path')).default;
  const e = mod.default({
    fs: nodeFs, path: nodePath, ROOT: root, ESTADO_FILE: 'ESTADO.md',
    DOCS: 'documentos', REPORTING: 'gestion/reporting', TIPOS: {},
    VALID_STATES: ['todo', 'in_progress', 'done'], ACTIVE_STATES: ['in_progress'],
    isDone: (x) => x === 'done', isActive: (x) => x === 'in_progress',
    normEstado: (x) => String(x || '').toLowerCase(),
    listFiles: () => [], docsControlados: () => [], git: () => '',
  });
  assert.strictEqual(typeof e.invalidarEstado, 'function', 'estado.js debe EXPONER la invalidacion de su cache privada');

  assert.strictEqual(e.parseEstado().fases.length, 1, 'lectura inicial');
  fs.writeFileSync(path.join(root, 'ESTADO.md'), ESTADO_ROTO);   // el archivo cambia en disco
  assert.strictEqual(e.parseEstado().fases.length, 1, 'sin invalidar, sirve la cache (comportamiento esperado)');
  e.invalidarEstado();
  assert.strictEqual(e.parseEstado().fases.length, 2, 'tras invalidar DEBE releer el archivo nuevo');
});
