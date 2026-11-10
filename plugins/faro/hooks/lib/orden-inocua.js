// lib/orden-inocua.js — ¿puede pre-bash despachar esta orden SIN cargar el motor? (#127)
//
// Criterio deliberadamente estrecho: la via temprana NO decide sobre rutas ni ficheros. Solo dice
// "inocua" cuando la orden es UN comando de una lista cerrada que no lee contenido de ficheros
// (ls, pwd, dir, date, whoami, true) y TODOS sus argumentos son opciones simples (-l, -la, /w).
// Cualquier operando (una ruta, un patron, un nombre), cualquier comodin o expansion
// (* ? [ ] { } ~ % @ $ `), encadenado o redireccion manda la orden por el camino completo, que es
// donde viven las guardas (lib/guardas.js: ficheros sensibles, volcados, commits). Asi las rutas
// sensibles tienen UNA sola fuente de verdad y la via temprana nunca la contradice.
//
// Las restricciones de alcance (lib/alcance.js, #150) dependen de esto: como la via temprana no acepta
// operandos, redirecciones ni 'git', nunca decide sobre rutas y las escrituras en repos ajenos siempre
// pasan por el analisis completo de pre-bash.
//
// Fuera a proposito: 'type' (en cmd/PowerShell LEE ficheros), 'cat', 'echo'/'printf' (en PowerShell
// expanden variables y subexpresiones), 'cd'/'which'/'where' (llevan operando).
'use strict';

const COMANDOS = new Set(['ls', 'pwd', 'dir', 'date', 'whoami', 'true']);
// Opcion simple: -l, -la, --all, /w (dir). Nada mas: ni '=', ni rutas, ni comodines.
const OPCION = /^(?:-{1,2}[A-Za-z][A-Za-z-]*|\/[A-Za-z])$/;

function esOrdenInocua(cmd) {
  const c = String(cmd || '').trim();
  if (!c || /[\r\n;&|<>`$(){}\[\]*?~%@!^"'\\]/.test(c)) return false;
  const [orden, ...args] = c.split(/\s+/);
  if (!COMANDOS.has(orden.toLowerCase())) return false;
  return args.every((a) => OPCION.test(a));
}

module.exports = { esOrdenInocua };
