// lib/guardas-modo.js — interruptor UNICO de las guardas del harness (#22).
// Por defecto APAGADAS: FARO no bloquea, no pregunta y no avisa al escribir ni al ejecutar; decide el
// desarrollador. Los permisos propios de Claude Code son aparte y siguen como esten configurados.
// Se encienden con FARO_GUARDAS=on (on|1|true|si|estricto): vuelven todos los bloqueos, preguntas y
// avisos de antes (alcance, borrados, comandos destructivos, ramas principales, TDD, Stop...).
'use strict';

const RE_ACTIVAS = /^(on|1|true|si|sí|estricto)$/i;
function guardasActivas(env = process.env) {
  return RE_ACTIVAS.test(String((env && env.FARO_GUARDAS) || '').trim());
}
// Hooks que SOLO existen para vigilar (bloquear, preguntar o avisar). Con las guardas apagadas salen
// al arrancar, sin leer el payload ni cargar el motor.
const HOOKS_DE_GUARDA = Object.freeze(['pre-doc', 'pre-bash', 'doc-check', 'stop-check', 'tdd-pre', 'tdd-post', 'tdd-stop']);
// ¿Este subcomando de harness.js debe salir sin hacer nada? 'vigilar' solo calla en el arranque de
// sesion; a peticion ('--ahora') responde siempre, porque lo pide un humano.
function hookSilenciado(cmd, argv = [], env = process.env) {
  if (guardasActivas(env)) return false;
  if (HOOKS_DE_GUARDA.includes(cmd)) return true;
  return cmd === 'vigilar' && !argv.includes('--ahora');
}

module.exports = { guardasActivas, hookSilenciado, HOOKS_DE_GUARDA };
