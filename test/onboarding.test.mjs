// Tests del onboarding (0.9.3): la plantilla de ESTADO.md pide CLAVE y NO menciona 'tipo'
// (opcional, fuera de catalogo se IGNORA en silencio); 'funcional: null' no es un funcional.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');
const run = (args, cwd) =>
  spawnSync(process.execPath, [HARNESS, ...args], {
    cwd, encoding: 'utf8', timeout: 120000, env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${name}-`));

test('onboarding: la plantilla de ESTADO.md pide CLAVE y NO prescribe tipo', () => {
  const dir = tmp('onboarding-clave');
  const r = run(['session'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/frontmatter \(nombre, clave/.test(r.stdout), `la plantilla no pide la clave: ${r.stdout.slice(0, 600)}`);
  assert.ok(!/frontmatter \(nombre, tipo/.test(r.stdout), `la plantilla sigue prescribiendo 'tipo': ${r.stdout.slice(0, 600)}`);
});

test('tipo fuera de catalogo (core-serv retirado): se IGNORA en silencio, ni se menciona', () => {
  const dir = tmp('tipo-retirado');
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), `---
nombre: identity-ui
tipo: core-serv
clave: IDUI
objetivo: Centro de aplicaciones
estado: in_progress
fases_total: 1
fase_actual: 1
owner: tester
---
### Fase 1 · Piloto — in_progress
- [ ] tarea
`);
  const r = run(['session'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!/core-serv/.test(r.stdout), `la sesion menciona el tipo retirado: ${r.stdout}`);
  const v = run(['validate'], dir);
  assert.ok(!/core-serv/.test(v.stdout), `validate menciona el tipo retirado: ${v.stdout}`);
});

test("'funcional: null' NO es un funcional declarado (se trata como ausente)", () => {
  const dir = tmp('funcional-null');
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), `---
nombre: identity-ui
clave: IDUI
objetivo: Centro de aplicaciones
estado: in_progress
fases_total: 1
fase_actual: 1
owner: tester
funcional: null
---
### Fase 1 · Piloto — in_progress
- [ ] tarea
`);
  const r = run(['session'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!/Funcional presente: null/.test(r.stdout), `trata 'null' como ruta real: ${r.stdout.slice(0, 400)}`);
  assert.ok(/falta el funcional|Funcional: no declarado/.test(r.stdout), `no avisa de funcional ausente: ${r.stdout.slice(0, 600)}`);
});
