// GATE DE PLANES (0.27.0): un plan de implementacion es el tasks.md de un cambio, no un artefacto
// paralelo. Otros plugins (superpowers) lo escriben en 'docs/superpowers/plans/AAAA-MM-DD-<x>.md'
// siguiendo SU convencion; el hook de FARO lo intercepta y dice donde va en ESTE repo. No se crea una
// carpeta plans/ dentro de gestion: seria un TERCER artefacto diciendo lo mismo que tasks.md.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');
// #188: el hook se prueba sobre un CLON del repo en una rama de trabajo, no sobre el checkout real. Si la
// suite corria en develop/main (CI al integrar), el guardarrail de ramas protegidas respondia antes que el
// gate de planes y los tests fallaban segun la rama. El clon trae lo commiteado (cambios declarados incluidos).
const ORIGEN = path.join(HOOKS, '..', '..', '..');
const REPO = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-gate-planes-'));
  for (const a of [['clone', '-q', '--shared', ORIGEN, d], ['-C', d, 'switch', '-q', '-c', 'feat/gate-planes-prueba']]) {
    const r = spawnSync('git', a, { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  }
  process.on('exit', () => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });
  return d;
})();

// El hook lee el payload por stdin y responde por stdout. cwd = el clon (tiene cambios declarados)
// salvo que se pase otro ROOT.
function preDoc(filePath, root) {
  const r = spawnSync(process.execPath, [HARNESS, 'pre-doc'], {
    cwd: root || REPO,
    input: JSON.stringify({ tool_input: { file_path: filePath } }),
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root || REPO },
  });
  if (!r.stdout || !r.stdout.trim()) return null;   // sin salida = la escritura pasa
  try { return JSON.parse(r.stdout).hookSpecificOutput || null; } catch { return null; }
}

test('un plan de superpowers en su ruta por defecto se BLOQUEA y se dice donde va', () => {
  const h = preDoc(path.join(REPO, 'docs/superpowers/plans/2026-09-14-lo-que-sea.md'));
  assert.ok(h, 'el hook no respondio nada: el gate no salto');
  assert.strictEqual(h.permissionDecision, 'deny');
  assert.match(h.permissionDecisionReason, /tasks\.md de un cambio/);
  assert.match(h.permissionDecisionReason, /gestion\/cambios\/changes\/<cambio>\/tasks\.md/);
});

test('una carpeta plans/ en la raiz tambien se bloquea (no solo la ruta de superpowers)', () => {
  const h = preDoc(path.join(REPO, 'plans/2026-09-14-x.md'));
  assert.ok(h, 'el gate no salto');
  assert.strictEqual(h.permissionDecision, 'deny');
});

test('SIN cambios declarados, lo que se exige es la PROPUESTA, no el plan', (t) => {
  const tmp = path.join(REPO, '..', '_tmp-gate-planes');
  fs.mkdirSync(tmp, { recursive: true });
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
  const h = preDoc(path.join(tmp, 'plans/x.md'), tmp);
  assert.ok(h, 'el gate no salto');
  assert.strictEqual(h.permissionDecision, 'deny');
  assert.match(h.permissionDecisionReason, /NO hay ningun cambio declarado/);
  assert.match(h.permissionDecisionReason, /PROPUESTA/);
});

// Sin salida (null) = la escritura pasa. Tambien vale una salida que no sea un 'deny' (otros avisos
// del hook, como la rama fuera de convencion, no bloquean).
const noBloquea = (h) => !h || h.permissionDecision !== 'deny';

test('escribir el plan DENTRO del cambio no se bloquea: es su sitio', () => {
  const h = preDoc(path.join(REPO, 'gestion/cambios/changes/plugin-en-gitlab/tasks.md'));
  assert.ok(noBloquea(h), `no deberia bloquear: ${JSON.stringify(h)}`);
});

test('un documento controlado normal no se ve afectado por el gate', () => {
  const h = preDoc(path.join(REPO, 'documentos/arquitectura/FARO-ARQ-001-algo.md'));
  assert.ok(noBloquea(h), `no deberia bloquear: ${JSON.stringify(h)}`);
});
