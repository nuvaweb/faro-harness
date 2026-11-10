// Tests del ciclo de DIGESTION (0.9.1): fuentes sin digerir (señal en session/validate),
// registro de requisitos (gestion/requisitos.md, formato validable) y trazabilidad requisito<->cambio/tarea.
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
// git con fecha FIJA en el pasado: garantiza que un fichero recien escrito (mtime ahora) es SIEMPRE posterior.
const git = (cwd, ...args) =>
  spawnSync('git', args, {
    cwd, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' },
  });

// El faseo tiene que ser VALIDO, porque estos tests miden si validate pasa o falla POR LOS
// REQUISITOS. Con un ESTADO.md incompleto, validate falla por el faseo y el test mide otra cosa —
// que es lo que pasaba: tres tests en rojo cronico por reglas de faseo endurecidas despues de
// escribirlos (descripcion de fase, '#N' de la tarea y '@owner'), no por el ciclo de digestion.
const ESTADO = (tarea = '#1 · Tarea de prueba — @tester') => `---
iniciativa: Test
clave: DEMO
tipo: proyecto
fases_total: 1
fase_actual: 1
owner: tester
funcional: documentos/funcional/FUN.md
---
# Estado

### Fase 1 · Piloto — in_progress
Lo que trae esta fase.
Objetivo: 2027-12-31
- [ ] ${tarea}
`;

function repoBase(name, tarea) {
  const dir = tmp(name);
  fs.mkdirSync(path.join(dir, 'documentos', 'funcional'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'gestion'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), ESTADO(tarea));
  fs.writeFileSync(path.join(dir, 'documentos', 'funcional', 'FUN.md'), '# Funcional\n');
  return dir;
}

const REQ = (id, nombre, estado, origen = 'fuentes/2026-01-01-kickoff.md') =>
  `## ${id} · ${nombre}\n- estado: ${estado}\n- origen: ${origen}\n\n`;

test('requisitos: formato invalido bloquea validate con [req]', () => {
  const dir = repoBase('req-invalido');
  fs.writeFileSync(
    path.join(dir, 'gestion', 'requisitos.md'),
    '# Requisitos\n\n## REQ-01 · Login unico\n- origen: fuentes/kickoff.md\n\n## REQ-02 · Exportar CSV\n- estado: inventado\n- origen: fuentes/kickoff.md\n',
  );
  const r = run(['validate'], dir);
  assert.notStrictEqual(r.status, 0, `validate debio fallar: ${r.stdout}`);
  assert.ok(/\[req\] REQ-01/.test(r.stdout), `falta el error de REQ-01 (sin estado): ${r.stdout}`);
  assert.ok(/\[req\] REQ-02/.test(r.stdout), `falta el error de REQ-02 (estado no reconocido): ${r.stdout}`);
});

test('requisitos: id duplicado bloquea validate', () => {
  const dir = repoBase('req-duplicado');
  fs.writeFileSync(
    path.join(dir, 'gestion', 'requisitos.md'),
    `# Requisitos\n\n${REQ('REQ-01', 'Login unico', 'propuesto')}${REQ('REQ-01', 'Otro', 'propuesto')}`,
  );
  const r = run(['validate'], dir);
  assert.notStrictEqual(r.status, 0, `validate debio fallar: ${r.stdout}`);
  assert.ok(/\[req\].*duplicado/i.test(r.stdout), `falta el error de duplicado: ${r.stdout}`);
});

test('requisitos: registro valido pasa validate', () => {
  const dir = repoBase('req-valido');
  fs.writeFileSync(
    path.join(dir, 'gestion', 'requisitos.md'),
    `# Requisitos\n\n${REQ('REQ-01', 'Login unico', 'propuesto')}`,
  );
  const r = run(['validate'], dir);
  assert.strictEqual(r.status, 0, `validate fallo con registro valido: ${r.stdout}`);
});

test('trazabilidad: requisito aceptado sin cambio/tarea AVISA sin bloquear', () => {
  const dir = repoBase('req-sin-cobertura');
  fs.writeFileSync(
    path.join(dir, 'gestion', 'requisitos.md'),
    `# Requisitos\n\n${REQ('REQ-01', 'Login unico', 'aceptado')}`,
  );
  const r = run(['validate'], dir);
  assert.strictEqual(r.status, 0, `la trazabilidad NO debe bloquear: ${r.stdout}`);
  assert.ok(/\[requisitos\].*REQ-01/.test(r.stdout), `falta el aviso de REQ-01 sin cobertura: ${r.stdout}`);
});

test('trazabilidad: requisito aceptado citado en una tarea de ESTADO.md NO avisa', () => {
  // La tarea tiene que ser valida como tarea (con #N y @owner) Y citar el REQ: lo que se mide es la
  // cobertura del requisito, no el formato del faseo.
  const dir = repoBase('req-cubierto', '#1 · REQ-01 implementar login unico — @tester');
  fs.writeFileSync(
    path.join(dir, 'gestion', 'requisitos.md'),
    `# Requisitos\n\n${REQ('REQ-01', 'Login unico', 'aceptado')}`,
  );
  const r = run(['validate'], dir);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.ok(!/\[requisitos\].*REQ-01.*sin cambio/i.test(r.stdout), `aviso indebido (REQ-01 esta cubierto): ${r.stdout}`);
});

test('trazabilidad: requisito citado en un cambio spec-driven cuenta como cobertura', () => {
  const dir = repoBase('req-cubierto-cambio');
  fs.writeFileSync(
    path.join(dir, 'gestion', 'requisitos.md'),
    `# Requisitos\n\n${REQ('REQ-01', 'Login unico', 'aceptado')}`,
  );
  const chg = path.join(dir, 'gestion', 'cambios', 'changes', 'login-unico');
  fs.mkdirSync(chg, { recursive: true });
  fs.writeFileSync(
    path.join(chg, 'proposal.md'),
    '---\nestado: propuesta\n---\n# Cambio: login unico\nCubre REQ-01 (login unico).\n',
  );
  const r = run(['validate'], dir);
  assert.ok(!/\[requisitos\].*REQ-01.*sin cambio/i.test(r.stdout), `aviso indebido (REQ-01 citado en el cambio): ${r.stdout}`);
});

test('digestion: fuente posterior al funcional/ESTADO se señala en session con directiva', () => {
  const dir = repoBase('digestion-senal');
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'tester@test.local');
  git(dir, 'config', 'user.name', 'Tester');
  // La firma de commits heredada de la config global (gpg/1Password/ssh-sign) puede fallar o
  // pedir interaccion y dejar el repo de prueba SIN COMMITS: entonces el harness no tiene nada
  // que gobernar y el test falla por el entorno. Se apaga solo aqui, no en la config del usuario.
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'base');
  fs.mkdirSync(path.join(dir, 'fuentes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'fuentes', '2026-08-23-transcripcion-reunion.md'), '# Transcripcion\nEl cliente pide exportar CSV.\n');
  const r = run(['session'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/FUENTES SIN DIGERIR/.test(r.stdout), `falta la señal de fuentes sin digerir: ${r.stdout}`);
  assert.ok(/2026-08-23-transcripcion-reunion\.md/.test(r.stdout), `no lista la fuente concreta: ${r.stdout}`);
  assert.ok(/DIGESTION/i.test(r.stdout) && /requisitos/i.test(r.stdout), `falta la directiva de digestion: ${r.stdout}`);
});

test('requisitos: sin registro pero CON fuentes historicas sugiere digestion RETROSPECTIVA en session', () => {
  const dir = repoBase('req-retrospectiva');
  fs.mkdirSync(path.join(dir, 'fuentes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'fuentes', '2025-11-01-kickoff.md'), '# Kickoff historico\n');
  fs.writeFileSync(path.join(dir, 'fuentes', '2025-12-01-funcional-cliente.md'), '# Funcional del cliente\n');
  const r = run(['session'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/RETROSPECTIVA/i.test(r.stdout), `falta la sugerencia de digestion retrospectiva: ${r.stdout.slice(0, 400)}`);
  assert.ok(/2 fuente/.test(r.stdout), `no cuenta las fuentes existentes: ${r.stdout.slice(0, 400)}`);
});

test('digestion: fuente BINARIA (pdf) pide extracto .extracto.md; el extracto la representa', () => {
  const dir = repoBase('digestion-binaria');
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'tester@test.local');
  git(dir, 'config', 'user.name', 'Tester');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'base');
  fs.mkdirSync(path.join(dir, 'fuentes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'fuentes', 'informe-cliente.pdf'), 'PDF-FAKE');
  const r1 = run(['session'], dir);
  assert.ok(/informe-cliente\.pdf \(/.test(r1.stdout), `no señala el pdf: ${r1.stdout.slice(0, 300)}`);
  assert.ok(/extracto/i.test(r1.stdout), `no pide el extracto md del binario: ${r1.stdout.slice(0, 300)}`);
  // con el extracto presente, la señal apunta al MD (no re-procesar el binario cada vez)
  fs.writeFileSync(path.join(dir, 'fuentes', 'informe-cliente.pdf.extracto.md'), '# Extracto\nPide exportar CSV.\n');
  const r2 = run(['session'], dir);
  assert.ok(/informe-cliente\.pdf\.extracto\.md/.test(r2.stdout), `no lista el extracto: ${r2.stdout.slice(0, 300)}`);
  assert.ok(!/informe-cliente\.pdf \(/.test(r2.stdout), `sigue señalando el binario ya extractado: ${r2.stdout.slice(0, 600)}`);
});

test('estado-json: expone requisitos y señales recalculadas (canal JSON para integraciones)', () => {
  const dir = repoBase('estado-json-senales');
  fs.writeFileSync(
    path.join(dir, 'gestion', 'requisitos.md'),
    `# Requisitos\n\n${REQ('REQ-01', 'Login unico', 'aceptado')}`,
  );
  const r = run(['estado-json'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.requisitos.length, 1, `faltan requisitos en el JSON: ${r.stdout}`);
  assert.strictEqual(j.requisitos[0].id, 'REQ-01');
  assert.ok(j.senales, 'falta el bloque senales');
  assert.deepStrictEqual(j.senales.requisitos_sin_cobertura, ['REQ-01']);
  assert.ok(Array.isArray(j.senales.fuentes_sin_digerir));
});


test('digestion: fuente ya committeada junto al funcional NO señala', () => {
  const dir = repoBase('digestion-al-dia');
  fs.mkdirSync(path.join(dir, 'fuentes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'fuentes', '2026-01-01-kickoff.md'), '# Kickoff\n');
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'tester@test.local');
  git(dir, 'config', 'user.name', 'Tester');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'base con fuente ya digerida');
  const r = run(['session'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!/FUENTES SIN DIGERIR/.test(r.stdout), `señal indebida (todo esta digerido): ${r.stdout}`);
});
