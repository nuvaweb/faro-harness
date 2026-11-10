// Cambio 'guardas-y-recontexto': guardas de seguridad deterministas y reancla tras compactar.
// Un test por escenario de los deltas.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'harness.js');

const conStdin = (sub, payload, dir) =>
  spawnSync(process.execPath, [HARNESS, sub], {
    cwd: dir, encoding: 'utf8', timeout: 60000,
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
const decision = (sub, payload, dir) => {
  const r = conStdin(sub, payload, dir);
  try { return JSON.parse(r.stdout).hookSpecificOutput || {}; } catch { return {}; }
};
const bash = (cmd, dir) => decision('pre-bash', { tool_input: { command: cmd } }, dir);
const escribir = (fp, dir) => decision('pre-doc', { tool_input: { file_path: fp, content: 'x' } }, dir);
const contexto = (payload, dir) => {
  const r = conStdin('session', payload, dir);
  try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext || ''; } catch { return ''; }
};

// Repo con faseo válido y los ficheros que se le indiquen.
function repo(ficheros = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-guard-'));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  const w = (rel, txt) => {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), txt);
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test User');
  // La firma de commits del entorno (gpg, 1Password, ssh-sign) puede pedir interaccion y COLGAR el
  // test. Un repo de prueba no la necesita: se apaga en el repo, sin tocar la config del usuario.
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  git('remote', 'add', 'origin', 'git@github.com:acme-org/demo.git');
  w('ESTADO.md', `---
iniciativa: Demo
clave: DEMO
fases_total: 1
fase_actual: 1
owner: Test User
funcional: documentos/funcional/DEMO-BRF-001-b.md
---
### Fase 1 · Uno — in_progress
- [ ] Algo [resp: test@example.com]
`);
  w('documentos/funcional/DEMO-BRF-001-b.md',
    '---\ndoc_id: DEMO-BRF-001\ntype: BRF\ndomain: negocio\nstatus: approved\nversion: 1.0.0\ndate: 2026-09-01\nclassification: interna\nauthor: Test User\n---\n# B\n');
  w('gestion/risks.md', '| ID | Tipo | D | I | Dueno | Estado |\n|---|---|---|---|---|---|\n| R1 | Riesgo | x | Alto | @t | abierto |\n');
  w('README.md', '# demo\n');
  for (const [rel, txt] of Object.entries(ficheros)) w(rel, txt);
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  // RAMA DE TRABAJO, no 'master'. En una rama protegida el harness deniega por el ciclo git ANTES de
  // llegar a las guardas, y el test mediria lo que no queria medir (paso real: '.env.example' salia
  // bloqueado por estar en master, no por la guarda de credenciales).
  git('switch', '-q', '-c', 'feat/pruebas');
  return { dir, git, w };
}

// ---------- spec: guardas-seguridad ----------

test('guarda: un commit con una clave privada preparada se BLOQUEA y no repite el secreto', () => {
  const { dir, git, w } = repo();
  const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEabcdefghijklmnop\n-----END RSA PRIVATE KEY-----\n';
  w('deploy/clave.txt', PEM);
  git('add', '-A');
  const d = bash('git commit -m "añade deploy"', dir);
  assert.strictEqual(d.permissionDecision, 'deny', 'deberia bloquear el commit');
  assert.match(d.permissionDecisionReason, /deploy\/clave\.txt/, 'debe nombrar el fichero');
  assert.ok(!d.permissionDecisionReason.includes('MIIEabcdefghijklmnop'),
    'el motivo NO debe reproducir el secreto: seria filtrarlo otra vez');
});

test('guarda: un commit limpio no se molesta', () => {
  const { dir, git, w } = repo();
  w('docs.md', '# solo texto\n');
  git('add', '-A');
  const d = bash('git commit -m "docs"', dir);
  assert.notStrictEqual(d.permissionDecision, 'deny', `falso positivo: ${d.permissionDecisionReason || ''}`);
});

test('guarda: la palabra "password" en prosa NO es una credencial', () => {
  const { dir, git, w } = repo();
  w('guia.md', 'El campo password es obligatorio. El usuario introduce su password al entrar.\n');
  git('add', '-A');
  const d = bash('git commit -m "guia"', dir);
  assert.notStrictEqual(d.permissionDecision, 'deny',
    'un detector que salta con una palabra suelta se acaba desactivando');
});

test('guarda: un fichero por encima del umbral se BLOQUEA e indica su tamaño', () => {
  const { dir, git, w } = repo();
  w('datos.bin', 'x'.repeat(600 * 1024));   // 600 KB > umbral 500
  git('add', '-A');
  const d = bash('git commit -m "datos"', dir);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /datos\.bin/);
  assert.match(d.permissionDecisionReason, /KB/, 'el motivo debe indicar el tamaño');
});

test('guarda: volcar un fichero de credenciales por consola se BLOQUEA', () => {
  const { dir } = repo();
  assert.strictEqual(bash('cat .env', dir).permissionDecision, 'deny');
  assert.notStrictEqual(bash('cat README.md', dir).permissionDecision, 'deny', 'un fichero normal se puede leer');
});

test('guarda: no se escribe sobre un fichero de credenciales', () => {
  const { dir } = repo();
  assert.strictEqual(escribir('.env', dir).permissionDecision, 'deny');
  assert.strictEqual(escribir('certs/servidor.pem', dir).permissionDecision, 'deny');
  assert.strictEqual(escribir('id_ecdsa', dir).permissionDecision, 'deny', 'la lista anterior se dejaba id_ecdsa fuera');
});

test('guarda: el fichero de EJEMPLO sí se puede escribir (regresión real)', () => {
  // El detector anterior bloqueaba .env.example — justo el fichero que el propio harness
  // recomienda usar. El agente no podia crear lo que se le pedia crear.
  const { dir } = repo();
  for (const f of ['.env.example', '.env.sample', '.env.template']) {
    assert.notStrictEqual(escribir(f, dir).permissionDecision, 'deny',
      `'${f}' existe PARA versionarse y no debe bloquearse`);
  }
});

test('guarda: el force push lo sigue cubriendo el guardián de comandos destructivos', () => {
  // No se duplica en guardas.js: el patrón existente exime --force-with-lease a propósito.
  const { dir } = repo();
  const d = bash('git push --' + 'force origin main', dir);
  assert.strictEqual(d.permissionDecision, 'deny');
});

// El OTRO lado de la regla, y el que de verdad la define: lo que se protege no es la reescritura
// —legitima en la rama propia— sino el trabajo de TERCEROS. '--force-with-lease' reescribe igual,
// pero FALLA en vez de sobrescribir si el remoto cambio desde la ultima vez que se miro.
// Sin este test, endurecer el gate "por seguridad" pasaria desapercibido... y empujaria a la gente a
// usar '--force' a secas, que es exactamente el resultado contrario al que se busca.
test('guarda: --force-with-lease NO se bloquea (comprueba antes de sobrescribir)', () => {
  const { dir } = repo();
  const d = bash('git push --' + 'force-with-lease origin main', dir);
  assert.notStrictEqual(d.permissionDecision, 'deny',
    `bloquear la forma SEGURA empuja a usar la peligrosa: ${JSON.stringify(d)}`);
});

test('guarda: el umbral del repo manda sobre el del plugin', () => {
  const { dir, git, w } = repo();
  w('.claude/faro-schema.json', JSON.stringify({ enums: { guardas: { max_kb_fichero: 1 } } }));
  w('mediano.txt', 'x'.repeat(50 * 1024));   // 50 KB: por debajo de 500, por encima de 1
  git('add', '-A');
  const d = bash('git commit -m "x"', dir);
  assert.strictEqual(d.permissionDecision, 'deny', 'con umbral 1 KB deberia bloquear un fichero de 50 KB');
});

// ---------- spec: recontexto-compactacion ----------

test('reancla: volver de una compactación emite el bloque corto, no el completo', () => {
  const { dir } = repo();
  const comp = contexto({ start_reason: 'compact' }, dir);
  const full = contexto({ start_reason: 'startup' }, dir);
  assert.match(comp, /REANCLA TRAS COMPACTAR/);
  assert.ok(comp.length < full.length / 2,
    `el reancla deberia ser menos de la mitad: ${comp.length} vs ${full.length}`);
});

test('reancla: el arranque en frío sigue emitiendo el bloque completo', () => {
  const { dir } = repo();
  const full = contexto({ start_reason: 'startup' }, dir);
  assert.match(full, /HARNESS CHECK/, 'el arranque normal no debe cambiar');
  assert.ok(!/REANCLA TRAS COMPACTAR/.test(full));
});

test('reancla: sin motivo de arranque se emite el COMPLETO (perder gobierno es peor que repetirlo)', () => {
  const { dir } = repo();
  const sinMotivo = contexto({}, dir);
  assert.match(sinMotivo, /HARNESS CHECK/);
});

test('reancla: contiene rama, ciclo spec y regla de plataforma, y NO los catálogos', () => {
  const { dir } = repo();
  const c = contexto({ start_reason: 'compact' }, dir);
  assert.match(c, /Rama 'feat\/pruebas'/, 'debe recordar en qué rama está');
  assert.match(c, /rama de trabajo: OK para editar/, 'y si en ella se puede escribir');
  assert.match(c, /Cambios spec-driven abiertos/);
  assert.match(c, /GITHUB \/ API/, 'la regla de plataforma no se deduce de un resumen');
  assert.ok(!/CONTROL DOCUMENTAL/.test(c), 'los catálogos son consultables bajo demanda, no se reinyectan');
});
