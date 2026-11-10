// La directiva que el motor se inyecta A SI MISMO tiene que describir el ciclo que de verdad se
// aplica aqui: feat/<tema> -> PR a develop -> consolidar -> aprobar.
//
// Por que importa mas de lo que parece: ese texto entra en el contexto del modelo como instruccion
// de sistema. Si dijera "PR directo a main" —como decia antes de que existiera develop— el agente
// intentaria exactamente eso, chocaria con el gate que bloquea main, y se quedaria dando vueltas
// entre una orden y una prohibicion que se contradicen. Un documento desactualizado aqui no es deuda
// documental: es una instruccion que el agente obedece.
//
// Este test existe ademas por un motivo concreto: era el unico de los 47 requisitos del motor cuyo
// escenario era verificable de forma barata y determinista, y no tenia test. Los otros dos que
// quedan sin evidencia son hechos sobre el repo o sobre pipelines externos, no comportamiento.
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

test('la directiva del motor nombra develop como destino del PR', () => {
  const ctx = contextoDeSesion();
  assert.match(ctx, /develop/, ctx.slice(0, 400));
  // Lo que NO puede decir: que el trabajo va por PR directo a main.
  assert.ok(!/PR\s+(directo\s+)?a\s+main/i.test(ctx), `sigue mandando el PR a main:\n${ctx.slice(0, 600)}`);
});

test('nombra el paso que SI toca main, y no lo confunde con el trabajo diario', () => {
  const ctx = contextoDeSesion();
  assert.match(ctx, /faro:publicar|faro:aprobar/, 'debe nombrar el comando que promociona a main');
});

// Las dos mitades de la regla: ni main ni develop se commitean directo. Decir solo lo de main
// dejaria develop como zona de trabajo, que es justo lo que se quiso cerrar.
test('dice que NI main NI develop reciben commit directo', () => {
  const ctx = contextoDeSesion();
  assert.match(ctx, /main/, ctx.slice(0, 300));
  assert.match(ctx, /develop/, ctx.slice(0, 300));
  assert.match(ctx, /no se edita|NO se edita|nunca se commitean|bloquea/i,
    `el texto debe dejar claro que no se escribe a mano en las ramas de integracion:\n${ctx.slice(0, 800)}`);
});

test('nombra la rama de trabajo como el sitio donde se trabaja', () => {
  const ctx = contextoDeSesion();
  assert.match(ctx, /feat\/|<tipo>\/<slug>|rama de cambio/i,
    `debe decir DONDE se trabaja, no solo donde no:\n${ctx.slice(0, 600)}`);
});
