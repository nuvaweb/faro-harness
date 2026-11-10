// LIGAR el cambio spec-driven con su ejecucion en la forja. Hoy son dos mundos sueltos:
//
//   gestion/cambios/changes/<slug>/        |   issue #N (hito, asignado)
//     proposal.md (fase, tareas)           |        v
//     tasks.md, specs/                     |   rama feat/N-slug -> PR
//     archive/   <-- ¿quien lo liga? -->   |   fusionado
//
// El frontmatter del change lleva fase y tareas de ESTADO.md, pero NO sabe que issue lo ejecuta. Asi
// se puede archivar un cambio con su issue todavia abierto (declararlo terminado cuando no lo esta),
// o darlo por 'implementada' con solo los checkboxes marcados y ninguna evidencia real.
//
// Regla: 'issue:' en el frontmatter es el eslabon que faltaba, y el estado del cambio no puede ir por
// delante del estado de su issue.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { coherenciaCambioIssue } = require(path.join(HOOKS, 'lib', 'ciclo.js'));

// issueEstado: 'open' | 'closed' | null (no se pudo consultar / no declara issue)

test('archivar un cambio con su issue ABIERTO es incoherente', () => {
  const r = coherenciaCambioIssue({ slug: 'mockup-ui', estado: 'implementada', issue: '4', issueEstado: 'open', archivando: true });
  assert.ok(r, 'debe protestar');
  assert.match(r, /#4/, r);
  assert.match(r, /abiert/i, r);
});

test('archivar con el issue CERRADO es lo correcto: no protesta', () => {
  assert.strictEqual(
    coherenciaCambioIssue({ slug: 'mockup-ui', estado: 'implementada', issue: '4', issueEstado: 'closed', archivando: true }),
    null,
  );
});

test("'implementada' con el issue todavia abierto se senala aunque NO se este archivando", () => {
  // Marcar los checkboxes no es evidencia: el trabajo no ha salido si su issue sigue vivo.
  const r = coherenciaCambioIssue({ slug: 'mockup-ui', estado: 'implementada', issue: '4', issueEstado: 'open', archivando: false });
  assert.ok(r, 'debe avisar');
  assert.match(r, /implementada/i, r);
});

test("'borrador' y 'aprobada' con el issue abierto son NORMALES (el trabajo esta en curso)", () => {
  for (const estado of ['borrador', 'aprobada']) {
    assert.strictEqual(
      coherenciaCambioIssue({ slug: 'x', estado, issue: '4', issueEstado: 'open', archivando: false }),
      null,
      `'${estado}' con issue abierto no es un problema`,
    );
  }
});

test('un cambio SIN issue declarado no inventa incoherencias (el campo es opcional)', () => {
  assert.strictEqual(
    coherenciaCambioIssue({ slug: 'x', estado: 'implementada', issue: null, issueEstado: null, archivando: true }),
    null,
  );
});

test('si el issue NO se pudo consultar (sin red/sin token), no se bloquea nada', () => {
  // Nunca convertir "no pude mirar" en "esta mal": dejaria el trabajo parado por estar sin conexion.
  assert.strictEqual(
    coherenciaCambioIssue({ slug: 'x', estado: 'implementada', issue: '4', issueEstado: null, archivando: true }),
    null,
  );
});

test('el mensaje dice COMO resolverlo, no solo que esta mal', () => {
  const r = coherenciaCambioIssue({ slug: 'mockup-ui', estado: 'implementada', issue: '4', issueEstado: 'open', archivando: true });
  assert.match(r, /cerrar-tarea|terminar/i, `debe decir la salida:\n${r}`);
});
