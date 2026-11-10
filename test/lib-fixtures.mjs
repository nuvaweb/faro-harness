// Fixtures de procesos para los tests de higiene (#177). Los tests que prueban la limpieza de procesos
// tienen que limpiar LOS SUYOS siempre, aunque fallen: un fixture vivo mantiene colgado a `node --test`
// (espera a sus hijos) y deja huerfanos tras la bateria. Tres garantias:
//   1. `inactivo()` lanza un node que SE AUTOEXPIRA (5 min) en vez de un intervalo infinito, con stdio:'ignore'
//      y unref(): no retiene al runner aunque nadie lo mate.
//   2. todo lo lanzado (`rastrear`) se cierra con su arbol en `limpiarFixtures()` / en el `after` del fichero.
//   3. `guardaHuerfanos()` registra un `after` que FALLA si, antes de la limpieza de seguridad, queda vivo algun
//      proceso rastreado: el test debe haberlo cerrado el mismo.
import { spawn } from 'node:child_process';
import { after } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const P = createRequire(import.meta.url)(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks', 'lib', 'procesos.js'));
export const CODIGO_INACTIVO = 'setTimeout(() => process.exit(0), 300000)';
const pids = new Set();

/** Registra un hijo (objeto ChildProcess) o un PID suelto para la limpieza y la comprobacion de huerfanos. */
export function rastrear(x) {
  const pid = typeof x === 'number' ? x : x && x.pid;
  if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  if (x && typeof x.unref === 'function') x.unref();
  return x;
}
/** node ocioso que se autoexpira a los 5 min. opts: las de spawn (env…); stdio siempre 'ignore'. */
export function inactivo(opts = {}) {
  return rastrear(spawn(process.execPath, ['-e', CODIGO_INACTIVO], { ...opts, stdio: 'ignore', windowsHide: true }));
}
/** PIDs rastreados que siguen vivos. */
export function vivos() { return [...pids].filter((p) => P.vivo(p)); }
/** Cierra el arbol de cada fixture rastreado (taskkill /T /F o grupo POSIX) y los olvida. */
export function limpiarFixtures() {
  for (const p of pids) { if (P.vivo(p)) P.matarArbol(p); }
  pids.clear();
}
/** `after` del fichero: falla si quedaba algun fixture vivo (y lo cierra de todos modos). */
export function guardaHuerfanos() {
  after(async () => {
    // SIGKILL/taskkill no es instantaneo: el proceso tarda unos ms en morir (y en Linux queda zombi hasta que su padre lo
    // recoge). Se le da un plazo corto para morir; uno que SIGUE vivo pasado el plazo es un huerfano de verdad y falla.
    for (let i = 0; i < 40 && vivos().length; i++) await new Promise((r) => setTimeout(r, 50));
    const restos = vivos();
    limpiarFixtures();
    assert.deepStrictEqual(restos, [], `el test dejo procesos vivos (huerfanos): ${restos.join(', ')}`);
  });
}
