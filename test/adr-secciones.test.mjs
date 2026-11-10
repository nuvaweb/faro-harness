// Los ADR se validan por CONTENIDO, no solo por la ficha. Hasta 0.43.0 se comprobaba el frontmatter
// (status, deciders, linaje) y nada mas, asi que un ADR de dos lineas pasaba — y un ADR sin
// 'Alternativas consideradas' deja al triaje sin nada que citar: no permite distinguir "se valoro y
// se descarto" de "nadie lo penso", que son opuestos.
//
// Lo que se protege aqui es el CABLEADO (que la regla llegue a validate con la fuerza correcta), no
// el criterio en si — eso vive en triaje.test.mjs. Y sobre todo, que lo LEGACY no se rompa: si al
// actualizar el motor un repo con historia viera validate en rojo por decisiones de hace meses, el
// reflejo seria desactivar la regla, y se perderia tambien para las nuevas.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'harness.js');

const COJO = '---\nstatus: aceptada\ndeciders: "@t"\n---\n\n# X\n\n## Contexto y problema\nHabia un problema.\n\n## Decision\nSe eligio X.\n';
const COMPLETO = COJO.replace('## Decision', '## Alternativas consideradas\n- Y: descartada por coste\n\n## Decision') + '\n## Consecuencias\nSe asume latencia extra.\n';

function repo(adrs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-adr-'));
  fs.mkdirSync(path.join(dir, 'gestion', 'decisions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'documentos', 'funcional'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'documentos', 'funcional', 'f.md'), '# F\n## Fuera de alcance\n- Nada mas\n');
  // ESTADO.md valido: sin el, validate falla por el faseo y no se podria distinguir si el exit != 0
  // viene de los ADR o de otra cosa — que es justo lo que estos tests miden.
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
  for (const [nombre, texto] of Object.entries(adrs)) fs.writeFileSync(path.join(dir, 'gestion', 'decisions', nombre), texto);
  return dir;
}
// validate separa errores (bloquean) de 'Avisos (NO bloquean CI)'. Lo que se mide aqui es EN CUAL de
// las dos cae cada ADR, no si el texto aparece en algun sitio.
const bloqueantes = (salida) => String(salida).split(/Avisos \(NO bloquean/)[0];
const validate = (dir) => spawnSync(process.execPath, [HARNESS, 'validate'], {
  cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
});

// El corte es la fecha del NOMBRE del fichero: ya la lleva, asi que no hay estado que mantener.
test('un ADR ANTERIOR al corte avisa pero NO tumba validate', () => {
  const r = validate(repo({ '2026-01-14-vieja.md': COJO }));
  const todo = r.stdout + r.stderr;
  assert.match(todo, /2026-01-14-vieja\.md/, 'tiene que avisar de el');
  assert.match(todo, /no bloquea/i, `el aviso debe decir que no bloquea:\n${todo}`);
  assert.ok(!bloqueantes(todo).includes('2026-01-14-vieja.md'),
    `un ADR legacy no puede salir entre los errores:\n${todo}`);
  assert.strictEqual(r.status, 0, `y no puede tumbar validate el solo:\n${todo}`);
});

test('un ADR POSTERIOR al corte incompleto SI tumba validate', () => {
  const r = validate(repo({ '2026-12-01-nueva.md': COJO }));
  assert.notStrictEqual(r.status, 0, `un ADR nuevo incompleto tiene que bloquear:\n${r.stdout}`);
  assert.ok(bloqueantes(r.stdout + r.stderr).includes('2026-12-01-nueva.md'),
    `y tiene que salir entre los ERRORES, no entre los avisos:\n${r.stdout}`);
  assert.match(r.stdout + r.stderr, /Alternativas consideradas/);
});

test('un ADR completo no dice nada: el silencio es lo normal', () => {
  const r = validate(repo({ '2026-12-01-nueva.md': COMPLETO }));
  const todo = r.stdout + r.stderr;
  assert.ok(!/faltan Alternativas|le faltan/.test(todo), `no deberia avisar:\n${todo}`);
});

// El motivo se publica en un issue y lo lee quien reporto: tiene que explicar POR QUE importa, no
// solo que falta una seccion.
test('el aviso explica la consecuencia, no solo el incumplimiento', () => {
  const todo = validate(repo({ '2026-12-01-nueva.md': COJO })).stdout;
  assert.match(todo, /se valoro y se descarto|nadie lo penso/i, todo.slice(0, 400));
});

// ---------- el fuera de alcance del funcional ----------

// El contrato del tipo FUN ya exigia la seccion; lo que faltaba era comprobar que tuviera algo
// debajo. Un encabezado vacio pasaba, y con el se perdia el unico criterio escrito para descartar.
test('el funcional con el fuera de alcance VACIO avisa (sin bloquear)', () => {
  const dir = repo({});
  fs.writeFileSync(path.join(dir, 'documentos', 'funcional', 'f.md'), '# F\n\n## Alcance\nHace cosas.\n\n## Fuera de alcance\n\n## Requisitos\n- RF-01\n');
  const r = validate(dir);
  const todo = r.stdout + r.stderr;
  assert.match(todo, /\[alcance\]/, `deberia avisar:\n${todo.slice(0, 600)}`);
  assert.match(todo, /VACIO|vac[ií]o/i, todo.slice(0, 600));
  // Avisa, no bloquea: el funcional se escribe CON el usuario, no se le exige de golpe.
  assert.ok(!bloqueantes(todo).includes('[alcance]'), `no puede bloquear:\n${todo.slice(0, 600)}`);
});

test('con el fuera de alcance relleno no avisa', () => {
  const todo = (() => { const r = validate(repo({})); return r.stdout + r.stderr; })();
  assert.ok(!/\[alcance\]/.test(todo), `no deberia avisar:\n${todo.slice(0, 600)}`);
});
