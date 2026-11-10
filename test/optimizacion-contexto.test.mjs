// Cambio 'optimizacion-contexto-y-gates': gate determinista de plataforma y reparto del contexto
// entre el arranque de sesion y el hook de prompt. Un test por escenario de los deltas.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks', 'harness.js');

const hook = (sub, payload, dir) =>
  spawnSync(process.execPath, [HARNESS, sub], {
    cwd: dir, encoding: 'utf8', timeout: 60000,
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
const bash = (cmd, dir) => {
  const r = hook('pre-bash', { tool_input: { command: cmd } }, dir);
  try { return JSON.parse(r.stdout).hookSpecificOutput || {}; } catch { return {}; }
};
const ctx = (sub, dir) => {
  const r = spawnSync(process.execPath, [HARNESS, sub], {
    cwd: dir, encoding: 'utf8', timeout: 60000, input: '{}',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext || ''; } catch { return ''; }
};

// Instancia FARO realista: con faseo valido, funcional, un cambio abierto y RAID.
function instancia(remote = 'git@github.com:acme-org/demo.git') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-opt-'));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  const w = (rel, txt) => {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), txt);
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test User');
  // La firma de commits heredada de la config global (gpg/1Password/ssh-sign) puede fallar o
  // pedir interaccion y dejar el repo de prueba SIN COMMITS: entonces el harness no tiene nada
  // que gobernar y el test falla por el entorno. Se apaga solo aqui, no en la config del usuario.
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  git('remote', 'add', 'origin', remote);
  w('ESTADO.md', `---
iniciativa: Demo
clave: DEMO
fases_total: 2
fase_actual: 2
owner: Test User
funcional: documentos/funcional/DEMO-BRF-001-brief.md
---
### Fase 1 · Uno — done
- [x] Algo [resp: test@example.com]
### Fase 2 · Dos — in_progress
- [ ] Pendiente [resp: test@example.com]
`);
  w('documentos/funcional/DEMO-BRF-001-brief.md', `---
doc_id: DEMO-BRF-001
type: BRF
domain: negocio
status: approved
version: 1.0.0
date: 2026-09-01
classification: interna
author: Test User
---
# Brief
`);
  w('gestion/reporting/informes/2026-09-01-fase-1-informe.md', '---\nfase: 1\n---\n# Informe\n');
  w('gestion/risks.md', '| ID | Tipo | Desc | Impacto | Dueno | Estado |\n|---|---|---|---|---|---|\n| R1 | Riesgo | x | Alto | @t | abierto |\n');
  w('gestion/cambios/changes/mi-cambio/proposal.md', `---
titulo: Un cambio
descripcion: algo
estado: aprobada
fase: 2
owner: Test User
responsable: test@example.com
tareas: []
aprobada_por: Test User
---
## Por qué
Motivo suficientemente largo para el gate del harness.
## Qué cambia
- Algo
`);
  w('gestion/cambios/changes/mi-cambio/specs/cap/spec.md',
    '## Requisitos AÑADIDOS\n\n### Requisito: Algo\nEl sistema DEBE hacer algo.\n\n#### Escenario: caso\n- CUANDO pasa\n- ENTONCES ocurre\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

// ---------- spec: gate-plataforma ----------

test('gate: invocar el binario `gh` se DENIEGA y el motivo da la forma correcta', () => {
  const dir = instancia();
  const d = bash('gh pr create --fill', dir);
  assert.strictEqual(d.permissionDecision, 'deny', 'deberia bloquear el CLI de GitHub');
  assert.match(d.permissionDecisionReason, /harness\.js gh/, 'el motivo debe dar la via correcta');
});

test('gate: `git push` y una URL de github NO se confunden con el binario', () => {
  const dir = instancia();
  for (const cmd of ['git push origin main', 'echo https://github.com/acme-org/demo', 'git log --oneline']) {
    const d = bash(cmd, dir);
    assert.notStrictEqual(d.permissionDecision, 'deny', `falso positivo con: ${cmd}`);
  }
});

test('gate: el PROPIO harness (node .../harness.js gh ...) NUNCA se bloquea — regresion real de 0.14.0', () => {
  const dir = instancia();
  for (const cmd of [
    'node "C:/Users/x/.claude/plugins/cache/faro-marketplace/faro/0.14.0/hooks/harness.js" gh repos/acme-org/faro-demo-api/issues/91 GET 2>&1',
    'node C:/x/hooks/harness.js gh repos/a/b/pulls',
    'cd C:/repo && node "C:/x/hooks/harness.js" gh repos/a/b',
  ]) {
    const d = bash(cmd, dir);
    assert.notStrictEqual(d.permissionDecision, 'deny', `bloqueo el comando del propio harness:
${cmd}
${d.permissionDecisionReason || ''}`);
  }
});

test('gate: curl directo a api.github.com se DENIEGA (esquiva el token del harness)', () => {
  const dir = instancia();
  const d = bash('curl -s https://api.github.com/user', dir);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /harness\.js gh/);
});

test('gate: fuera de GitHub el motivo explica que no hay adaptador, sin reconducir', () => {
  const dir = instancia('git@gitlab.com:grupo/sub/demo.git');
  const d = bash('gh pr list', dir);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /GITLAB/);
  assert.match(d.permissionDecisionReason, /NO tiene adaptador/i);
});

test('reparto: la regla de plataforma esta en la sesion y NO en cada prompt', () => {
  const dir = instancia();
  assert.match(ctx('session', dir), /GITHUB \/ API \(REGLA DURA/, 'la sesion debe conservarla');
  assert.ok(!/GITHUB \/ API \(REGLA DURA/.test(ctx('prompt-context', dir)),
    'el hook de prompt no debe repetirla: en el turno la hace cumplir el gate');
});

// ---------- spec: reparto-contexto ----------

test('reparto: los bloques estaticos salen del turno y siguen en la sesion', () => {
  const dir = instancia();
  const p = ctx('prompt-context', dir);
  const s = ctx('session', dir);
  for (const bloque of ['Identidad:', 'Tareas asignadas:', 'PROTECCION']) {
    assert.ok(s.includes(bloque), `la sesion perdio '${bloque}'`);
    assert.ok(!p.includes(bloque), `'${bloque}' sigue repitiendose en cada prompt`);
  }
});

test('reparto: el aviso de seguridad de rama NO se toca — sigue en cada prompt', () => {
  const dir = instancia();
  const p = ctx('prompt-context', dir);
  assert.match(p, /RAMA '(main|master)'/, 'se ha perdido el radar de rama, que protege de escribir');
  assert.match(p, /rama <tipo>/, 'el radar debe seguir diciendo como abrir una rama de trabajo');
});

test('reparto: lo dinamico se conserva en el turno', () => {
  const dir = instancia();
  const p = ctx('prompt-context', dir);
  assert.match(p, /Git: rama/, 'el estado git cambia entre turnos y debe quedarse');
  assert.match(p, /Cambios abiertos/, 'el inventario cambia al abrir/cerrar un cambio');
  assert.match(p, /Iterando · fase 2/, 'la fase en curso debe seguir');
});

test('reparto: el protocolo spec se recuerda breve en el turno y completo en la sesion', () => {
  const dir = instancia();
  const p = ctx('prompt-context', dir);
  const s = ctx('session', dir);
  assert.match(s, /PROTOCOLO SPEC \(obligatorio/, 'la sesion debe llevar el protocolo completo');
  assert.match(p, /PROTOCOLO SPEC \(ya detallado/, 'el turno debe llevar el recordatorio breve');
  assert.ok(!p.includes('(f) ejecutar un plan con varias tareas'),
    'el desarrollo completo no debe repetirse por turno');
});

test('reparto: en una rama protegida NO aparece el aviso de "rama fuera de convencion"', () => {
  // Regresion: al condicionar cada rama del if/else-if por separado, la cadena caia a una rama
  // posterior y en 'main' salia el aviso de rama fuera del ciclo, que es falso.
  const dir = instancia();
  const p = ctx('prompt-context', dir);
  assert.ok(!/NO sigue la convencion del flujo FARO/.test(p),
    `una rama protegida no esta "fuera de convencion":\n${p}`);
});

test('reparto: el coste por turno baja de la mitad (< 3.000 chars, partiamos de 6.511)', () => {
  const dir = instancia();
  const p = ctx('prompt-context', dir);
  assert.ok(p.length > 0, 'no puede quedarse vacio: el gobierno del turno debe seguir');
  assert.ok(p.length < 3000, `esperaba menos de 3.000 chars, son ${p.length}`);
});
