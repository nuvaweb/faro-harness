// #110 — validate avisaba en falso de ADR 'sustituida' "SIN superseded-by" aunque lo declararan.
// El lector de cabeceras solo aceptaba claves con \w (sin guion): 'superseded-by' se descartaba en
// silencio, y con ella el linaje cruzado supersedes <-> superseded-by.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'harness.js');

const cuerpo = '\n# X\n\n## Contexto y problema\nP.\n\n## Alternativas consideradas\n- Y: descartada\n\n## Decision\nX.\n\n## Consecuencias\nC.\n';
const adr = (fm) => `---\n${fm}\ndeciders: "@t"\n---\n${cuerpo}`;

function repo(adrs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-adr-sup-'));
  fs.mkdirSync(path.join(dir, 'gestion', 'decisions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'documentos', 'funcional'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'documentos', 'funcional', 'f.md'), '# F\n## Fuera de alcance\n- Nada mas\n');
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), `---
iniciativa: T
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
  for (const [n, t] of Object.entries(adrs)) fs.writeFileSync(path.join(dir, 'gestion', 'decisions', n), t);
  return dir;
}
const validate = (dir) => {
  const r = spawnSync(process.execPath, [HARNESS, 'validate'], { cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  return r.stdout + r.stderr;
};

test('un ADR sustituida CON superseded-by no genera aviso, y el linaje cruzado se reconoce', () => {
  const out = validate(repo({
    '2026-10-01-vieja.md': adr('status: sustituida\nsuperseded-by: 2026-10-02-nueva'),
    '2026-10-02-nueva.md': adr('status: aceptada\nsupersedes: 2026-10-01-vieja'),
  }));
  assert.doesNotMatch(out, /SIN 'superseded-by'/, out);
  assert.doesNotMatch(out, /no tiene superseded-by/, out);
});

test('sin superseded-by sigue avisando (la regla no se ha apagado)', () => {
  const out = validate(repo({ '2026-10-01-vieja.md': adr('status: sustituida') }));
  assert.match(out, /SIN 'superseded-by'/, out);
});
