// El motor (IS_ENGINE) esta exento del gobierno de INSTANCIA (ESTADO.md/onboarding: no gestiona un
// trabajo propio, no tiene fases que exigir), pero eso NO lo exime de la convencion git UNIVERSAL de
// develop/main sin editar a mano -- el motor mismo declara seguirla (rama -> PR -> develop -> main,
// NUNCA commit directo, ver sus propias instrucciones de sesion). Bug real: ambas exenciones vivian
// fusionadas en un solo 'esInstancia', asi que editar con Edit/Write en develop/main del propio motor
// pasaba SIN NINGUN AVISO -- el gate solo actuaba en 'git commit' (mas tarde, con cambios ya
// acumulados en la rama equivocada), nunca en la edicion (mas temprano, mas barato de corregir).
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { umbral, plazo, conReintento } from './lib-tiempo.mjs';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'harness.js');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${name}-`));

const conStdin = (sub, payload, dir) =>
  spawnSync(process.execPath, [HARNESS, sub], {
    cwd: dir, encoding: 'utf8', timeout: plazo(60000),
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
const decision = (sub, payload, dir) => {
  const r = conStdin(sub, payload, dir);
  try { return JSON.parse(r.stdout).hookSpecificOutput || {}; } catch { return {}; }
};
const escribir = (fp, dir) => decision('pre-doc', { tool_input: { file_path: fp, content: 'x' } }, dir);

// Repo MOTOR real y minimo, en la rama que se indique.
function repoMotor(rama) {
  const dir = tmp('motor');
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', rama);
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  // IS_ENGINE exige AMBAS marcas: el manifiesto de marketplace Y el motor en plugins/faro/hooks/.
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'faro-marketplace', plugins: [] }));
  fs.mkdirSync(path.join(dir, 'plugins', 'faro', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins', 'faro', 'hooks', 'harness.js'), '// motor\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

test('motor: editar en develop es BLOQUEADO (deny) igual que en un repo de trabajo', () => {
  const dir = repoMotor('develop');
  const d = escribir('plugins/faro/hooks/harness.js', dir);
  assert.strictEqual(d.permissionDecision, 'deny', JSON.stringify(d));
  assert.match(d.permissionDecisionReason || '', /develop.*integracion|CREA TU la rama/i, JSON.stringify(d));
});

test('motor: editar en main es BLOQUEADO (deny) igual que en un repo de trabajo', () => {
  const dir = repoMotor('main');
  const d = escribir('plugins/faro/hooks/harness.js', dir);
  assert.strictEqual(d.permissionDecision, 'deny', JSON.stringify(d));
  assert.match(d.permissionDecisionReason || '', /aprobado|CREA TU la rama/i, JSON.stringify(d));
});

test('motor: editar en una rama de trabajo (feat/x) NO se bloquea', () => {
  const dir = repoMotor('feat/x');
  const d = escribir('plugins/faro/hooks/harness.js', dir);
  assert.notStrictEqual(d.permissionDecision, 'deny', JSON.stringify(d));
});
