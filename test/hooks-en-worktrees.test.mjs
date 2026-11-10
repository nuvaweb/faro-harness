// HOOKS EN WORKTREES (#136): pre-doc y doc-check deciden sobre UNA ruta concreta (el fichero que se
// escribe). Cuando esa ruta vive en un git worktree, las reglas spec-driven se evaluan contra el
// arbol de ESE worktree, no contra el checkout principal (que es el cwd / CLAUDE_PROJECT_DIR del
// proceso del hook). Bug real: un agente en .claude/worktrees/<x> no podia crear su tasks.md porque
// el hook buscaba la proposal en el checkout principal.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { umbral, plazo, conReintento } from './lib-tiempo.mjs';

const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks', 'harness.js');

let TMP, MAIN, WT_DENTRO, WT_FUERA;
const git = (cwd, ...a) => execFileSync('git', a, { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const PROPOSAL_OK = [
  '---',
  'titulo: Cambio de prueba',
  'descripcion: Prueba de worktree.',
  'estado: aprobada',
  'fase: transversal',
  'owner: Prueba',
  'responsable: prueba@example.com',
  'aprobada_por: Prueba',
  '---',
  '',
  '## Por qué',
  'Prueba.',
  '',
].join('\n');

before(() => {
  TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'faro-wt-')));
  MAIN = path.join(TMP, 'repo');
  fs.mkdirSync(MAIN);
  git(MAIN, 'init', '-q', '-b', 'feat/base');
  git(MAIN, 'config', 'user.email', 't@example.com');
  git(MAIN, 'config', 'user.name', 'Prueba');
  fs.writeFileSync(path.join(MAIN, 'README.md'), '# prueba\n');
  git(MAIN, 'add', '.');
  git(MAIN, 'commit', '-q', '-m', 'inicial');
  // Worktree DENTRO del checkout principal (como los de Claude Code: .claude/worktrees/<agente>)
  WT_DENTRO = path.join(MAIN, '.claude', 'worktrees', 'agente-a');
  git(MAIN, 'worktree', 'add', '-q', '-b', 'feat/wt-dentro', WT_DENTRO);
  // Worktree FUERA (carpeta hermana)
  WT_FUERA = path.join(TMP, 'repo-wt');
  git(MAIN, 'worktree', 'add', '-q', '-b', 'feat/wt-fuera', WT_FUERA);
  for (const wt of [WT_DENTRO, WT_FUERA]) {
    const d = path.join(wt, 'gestion', 'cambios', 'changes', 'cambio-wt');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'proposal.md'), PROPOSAL_OK);
  }
});
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

// El hook corre como lo lanza Claude Code: cwd y CLAUDE_PROJECT_DIR = el checkout PRINCIPAL.
function hook(cmd, filePath) {
  const r = spawnSync(process.execPath, [HARNESS, cmd], {
    cwd: MAIN,
    input: JSON.stringify({ tool_input: { file_path: filePath } }),
    encoding: 'utf8',
    timeout: plazo(60000),
    windowsHide: true,
    env: { ...process.env, CLAUDE_PROJECT_DIR: MAIN },
  });
  if (!r.stdout || !r.stdout.trim()) return null;
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return null; }
}
const decision = (o) => (o && o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision) || null;
const razon = (o) => (o && o.hookSpecificOutput && o.hookSpecificOutput.permissionDecisionReason) || '';

test('worktree dentro del repo: crear tasks.md con su proposal en el worktree NO se bloquea', () => {
  const o = hook('pre-doc', path.join(WT_DENTRO, 'gestion', 'cambios', 'changes', 'cambio-wt', 'tasks.md'));
  assert.notStrictEqual(decision(o), 'deny', `no deberia bloquear: ${razon(o)}`);
});

test('worktree fuera del repo: crear tasks.md con su proposal en el worktree NO se bloquea', () => {
  const o = hook('pre-doc', path.join(WT_FUERA, 'gestion', 'cambios', 'changes', 'cambio-wt', 'tasks.md'));
  assert.notStrictEqual(decision(o), 'deny', `no deberia bloquear: ${razon(o)}`);
});

test('worktree: tasks.md de un cambio SIN proposal (carpeta aun inexistente) se sigue bloqueando', () => {
  const o = hook('pre-doc', path.join(WT_DENTRO, 'gestion', 'cambios', 'changes', 'no-existe', 'tasks.md'));
  assert.strictEqual(decision(o), 'deny');
  assert.match(razon(o), /tasks\.md sin proposal/);
});

test('checkout principal sin proposal: tasks.md se sigue bloqueando como antes', () => {
  const o = hook('pre-doc', path.join(MAIN, 'gestion', 'cambios', 'changes', 'cambio-wt', 'tasks.md'));
  assert.strictEqual(decision(o), 'deny');
  assert.match(razon(o), /tasks\.md sin proposal/);
});

test('doc-check valida la proposal del WORKTREE (frontmatter incompleto se avisa)', () => {
  const d = path.join(WT_DENTRO, 'gestion', 'cambios', 'changes', 'cambio-roto');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'proposal.md'), '---\ntitulo: Roto\n---\n\nSin ciclo de vida.\n');
  const o = hook('doc-check', path.join(d, 'proposal.md'));
  const texto = JSON.stringify(o || {});
  assert.match(texto, /PROPOSAL cambio-roto/, `doc-check no vio la proposal del worktree: ${texto}`);
});

// #150: ya no basta con 'no gobernarlo': escribir en un repo ajeno se BLOQUEA (restricciones de alcance).
test('un repo AJENO (no worktree de este) no se adopta como raiz y su escritura se bloquea por alcance', () => {
  const ajeno = path.join(TMP, 'ajeno');
  fs.mkdirSync(ajeno);
  git(ajeno, 'init', '-q', '-b', 'main');
  const o = hook('pre-doc', path.join(ajeno, 'gestion', 'cambios', 'changes', 'x', 'tasks.md'));
  assert.strictEqual(decision(o), 'deny', `un repo ajeno no deberia escribirse: ${JSON.stringify(o)}`);
  assert.match(razon(o), /no de esta sesi/);
});
