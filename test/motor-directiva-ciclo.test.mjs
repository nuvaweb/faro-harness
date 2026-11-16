// La directiva que el motor se inyecta A SI MISMO tiene que describir el ciclo que de verdad se
// aplica aqui (FARO 3.0): <tipo>/<slug> -> PR a main con auto-merge -> el CI valida, integra y publica.
//
// Por que importa mas de lo que parece: ese texto entra en el contexto del modelo como instruccion
// de sistema. Si siguiera hablando de develop, consolidar o publicar —el flujo anterior— el agente
// intentaria exactamente eso y chocaria con comandos retirados. Un documento desactualizado aqui no
// es deuda documental: es una instruccion que el agente obedece.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'harness.js');

// El modo MOTOR se detecta por la forma del repo (marketplace.json + el propio harness), asi que
// basta con correr sobre ESTE repo: es el unico que lo cumple.
function contextoDeSesion() {
  const r = spawnSync(process.execPath, [HARNESS, 'session'], {
    cwd: RAIZ, encoding: 'utf8', timeout: 120000, env: { ...process.env, CLAUDE_PROJECT_DIR: RAIZ },
  });
  try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext || ''; } catch { return r.stdout; }
}

test('la directiva del motor nombra main como destino del PR, con auto-merge', () => {
  const ctx = contextoDeSesion();
  assert.match(ctx, /PR a main/, ctx.slice(0, 600));
  assert.match(ctx, /auto-merge/, ctx.slice(0, 600));
  // Lo que NO puede decir: que el trabajo pasa por develop o por los comandos retirados.
  assert.ok(!/PR a develop|faro:consolidar|faro:publicar/.test(ctx), `sigue describiendo el flujo anterior:\n${ctx.slice(0, 800)}`);
});

test('dice que publicar lo hace el CI, no un paso manual', () => {
  const ctx = contextoDeSesion();
  assert.match(ctx, /el CI [^.]{0,80}publica/i, 'debe decir quien publica');
});

// main no recibe commit directo: todo entra por PR.
test('dice que main no recibe commit directo', () => {
  const ctx = contextoDeSesion();
  assert.match(ctx, /main/, ctx.slice(0, 300));
  assert.match(ctx, /no se edita|NO se edita|nunca se commitean|bloquea/i,
    `el texto debe dejar claro que no se escribe a mano en las ramas de integracion:\n${ctx.slice(0, 800)}`);
});

test('nombra la rama de trabajo como el sitio donde se trabaja', () => {
  const ctx = contextoDeSesion();
  assert.match(ctx, /feat\/|<tipo>\/<slug>|rama de cambio/i,
    `debe decir DONDE se trabaja, no solo donde no:\n${ctx.slice(0, 600)}`);
});
