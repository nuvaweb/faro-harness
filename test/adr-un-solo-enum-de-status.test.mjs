// Un ADR con doc_id vivia bajo DOS validadores con enums distintos: el de documentos controlados
// (draft|in_review|approved|obsolete, BLOQUEA validate) y el de decisiones (propuesta|aceptada|...).
// Con 'propuesta' el primero rechazaba; con 'draft' el segundo avisaba. Ningun status valia para ambos
// y /faro:consolidar cancelaba por un validate en rojo que ningun cambio de ficha podia arreglar (#243).
//
// Lo que se protege: el status de un ADR se juzga SOLO contra el enum de ADR; los estados de documento
// que ya llevan los repos con historia siguen sin bloquear (solo avisan, como ya hacia el validador de
// decisiones).
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'harness.js');

const adr = (status) => `---
doc_id: ABC-DEC-001
title: Una decision
version: 1.0
date: 2026-12-01
status: ${status}
author: t
classification: internal
deciders: "@t"
---

# Una decision

## Contexto y problema
Habia un problema.

## Alternativas consideradas
- Y: descartada por coste

## Decision
Se eligio X.

## Consecuencias
Se asume latencia extra.
`;

function repo(status) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-adr-enum-'));
  fs.mkdirSync(path.join(dir, 'gestion', 'decisions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'documentos', 'funcional'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'documentos', 'funcional', 'f.md'), '# F\n## Fuera de alcance\n- Nada mas\n');
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), `---
iniciativa: T
clave: ABC
fases_total: 1
fase_actual: 1
owner: t
funcional: documentos/funcional/f.md
---

### Fase 1 · Una — in_progress
Lo que trae esta fase.
Objetivo: 2026-12-01
- [ ] #1 · Algo — @t
`);
  fs.writeFileSync(path.join(dir, 'gestion', 'decisions', '2026-12-01-una.md'), adr(status));
  return dir;
}
const validate = (dir) => spawnSync(process.execPath, [HARNESS, 'validate'], {
  cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
});
const bloqueantes = (salida) => String(salida).split(/Avisos \(NO bloquean/)[0];

for (const status of ['propuesta', 'aceptada', 'rechazada']) {
  test(`un ADR con doc_id y status '${status}' no tumba validate`, () => {
    const r = validate(repo(status));
    const todo = r.stdout + r.stderr;
    assert.ok(!/status '.*' invalido/.test(bloqueantes(todo)), `el validador de documentos no puede rechazar el enum de ADR:\n${todo}`);
    assert.strictEqual(r.status, 0, todo);
  });
}

test("un ADR con el status de documento 'draft' no tumba validate (legado): solo avisa", () => {
  const r = validate(repo('draft'));
  const todo = r.stdout + r.stderr;
  assert.strictEqual(r.status, 0, `un estado legado no puede bloquear:\n${todo}`);
  assert.match(todo, /\[decisiones\].*draft/, `y el validador de decisiones debe avisar:\n${todo}`);
});

test("un ADR con un status que no es de ninguno ('foo') SI se rechaza", () => {
  const r = validate(repo('foo'));
  assert.notStrictEqual(r.status, 0, r.stdout);
});
