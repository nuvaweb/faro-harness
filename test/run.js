// Lanzador de la suite. Fija FARO_CONFIG_PATH a un temporal ANTES de arrancar node --test, asi
// TODOS los procesos (tests, harness lanzados por tests, hijos de esos) heredan una ruta que no es el
// ~/.faro.json real. Cinturon ademas de los tirantes de credenciales.rutaCfg() (NODE_TEST_CONTEXT).
// Incidente 11 sep 2026: un test escribio fixtures en el almacen real del desarrollador.
//
// HIGIENE DE PROCESOS Y RECURSOS (#177). Un script de 11 lineas quedo 4,5 h al 100 % de un nucleo y una
// bateria tardo 90 min en vez de 15 por falta de memoria. Por eso este lanzador:
//   · ejecuta CADA fichero en su propio `node --test` con TIMEOUT por fichero (FARO_TEST_TIMEOUT_FICHERO_S,
//     900 s) y por bateria (FARO_TEST_TIMEOUT_BATERIA_S, 3600 s); al expirar, o al terminar, o al recibir
//     SIGINT/SIGTERM/SIGHUP, cierra el ARBOL de procesos hijo (Windows: taskkill /T /F; POSIX: grupo de procesos);
//   · registra a sus hijos (FARO_PROC) para que `harness.js procesos` vea y limpie los restos si el lanzador
//     muere de golpe (un kill -9 / taskkill /F del padre no se puede interceptar); la siguiente ejecucion cierra
//     por si sola los hijos de test huerfanos de una bateria anterior;
//   · avisa y espera (FARO_TEST_MEM_ESPERA_S, 120 s) si la memoria libre baja de FARO_TEST_MEM_MIN_MB (768);
//   · CANDADO de bateria completa (sin ficheros como argumento): la segunda ejecucion avisa y no arranca;
//     un candado obsoleto (dueño muerto o > 4 h) se recupera. FARO_BATERIA_FORZAR=1 lo ignora.
// Con ficheros como argumento (node test/run.js test/x.test.mjs) no hay candado: es el uso normal de un agente.
// Salida: 0 todo verde · 1 fallos o timeout · 3 ya hay otra bateria completa.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const P = require('../plugins/faro/hooks/lib/procesos.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-suite-'));
process.env.FARO_CONFIG_PATH = process.env.FARO_CONFIG_PATH || path.join(dir, 'faro.json');
// Estado de deltas de los hooks (#127): siempre a un temporal de la suite, nunca al del plugin real.
process.env.CLAUDE_PLUGIN_DATA = path.join(dir, 'plugin-data');
// Cache de gates (#182): los tests nunca escriben en la cache real del usuario.
process.env.FARO_CACHE_DIR = process.env.FARO_CACHE_DIR || path.join(dir, 'cache-gates');
// Git aislado (#169): sin firma ni identidad del usuario en ningun repo temporal de la suite.
require('./aislar-git.cjs').aislarGit();
// Marca de proceso (#177): los hijos heredan quien los lanzo; dentro de la bateria no se avisa de la bateria.
process.env.FARO_PROC = process.env.FARO_PROC || `bateria-${process.pid}`;
process.env.FARO_EN_BATERIA = '1';

const num = (v, def) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && v !== undefined && v !== '' ? n : def; };
const T_FICHERO = num(process.env.FARO_TEST_TIMEOUT_FICHERO_S, 900);
const T_BATERIA = num(process.env.FARO_TEST_TIMEOUT_BATERIA_S, 3600);
const MEM_MIN = num(process.env.FARO_TEST_MEM_MIN_MB, 768);
const MEM_ESPERA = num(process.env.FARO_TEST_MEM_ESPERA_S, 120);

const args = process.argv.slice(2);
// --trozo=i/n (#178): solo la parte i de n de la suite completa, repartida por tamaño de fichero (CI en paralelo).
const argTrozo = args.find((a) => a.startsWith('--trozo='));
const flags = args.filter((a) => a.startsWith('-') && a !== argTrozo);
const posicionales = args.filter((a) => !a.startsWith('-'));
const completa = posicionales.length === 0;
const testDir = process.env.FARO_TEST_DIR ? path.resolve(process.env.FARO_TEST_DIR) : __dirname;
let ficheros = completa
  ? fs.readdirSync(testDir).filter((f) => /\.test\.(mjs|cjs|js)$/.test(f)).sort().map((f) => path.join(testDir, f))
  : posicionales.map((f) => path.resolve(f));
// Un trozo sigue tomando el candado de bateria completa: en CI cada trozo va en su runner; en local, los trozos
// se lanzan uno tras otro (en paralelo, el segundo sale con 3, como cualquier otra bateria completa).
if (argTrozo || args.includes('--trozo')) {
  const dom = require('../plugins/faro/hooks/lib/dominios.js');
  const t = argTrozo ? dom.trozoDe(argTrozo.slice('--trozo='.length)) : null;
  if (!t || !completa) { console.error('[suite] --trozo invalido: usa --trozo=i/n (1 <= i <= n, con «=») y sin ficheros sueltos.'); process.exit(2); }
  const total = ficheros.length;
  ficheros = dom.trozo(ficheros, t.i, t.n, (f) => fs.statSync(f).size);
  if (!ficheros.length) { console.error(`[suite] trozo ${t.i}/${t.n} vacío: hay ${total} fichero(s) para ${t.n} trozos. Usa menos trozos.`); process.exit(2); }
  console.log(`[suite] trozo ${t.i}/${t.n}: ${ficheros.length} de ${total} ficheros.`);
}

let actual = null;            // { child, nombre } del fichero en curso
let candado = null;
let terminando = false;

function limpiarTodo() {
  if (actual && actual.child.pid) { P.matarArbol(actual.child.pid); P.olvidar(actual.child.pid); }
  if (candado) { P.soltarCandado(candado, process.pid); candado = null; }
}
process.on('exit', limpiarTodo);
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => { if (terminando) return; terminando = true; console.error(`\n[suite] ${s}: cierro los procesos hijo.`); limpiarTodo(); process.exit(130); });

function correr(fichero, tFichero, tBateria) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', ...flags, fichero], {
      stdio: 'inherit', env: process.env, windowsHide: true, detached: process.platform !== 'win32',
    });
    actual = { child, nombre: path.basename(fichero) };
    P.registrar(child.pid, { dueno: process.pid, rol: 'test', sesion: process.env.FARO_PROC });
    let motivo = null;
    const cortar = (m) => { if (motivo) return; motivo = m; P.matarArbol(child.pid); };
    const tf = tFichero > 0 ? setTimeout(() => cortar('fichero'), tFichero * 1000) : null;
    const tb = tBateria > 0 ? setTimeout(() => cortar('bateria'), Math.max(0, tBateria * 1000)) : null;
    const fin = (codigo) => {
      clearTimeout(tf); clearTimeout(tb);
      P.matarArbol(child.pid);                                   // huerfanos que dejara el fichero al terminar
      P.olvidar(child.pid); actual = null;
      resolve({ codigo, motivo });
    };
    child.on('error', () => fin(1));
    child.on('exit', (c) => setTimeout(() => fin(c == null ? 1 : c), 50));
  });
}

(async () => {
  if (completa && process.env.FARO_BATERIA_FORZAR !== '1') {
    const ruta = P.rutaCandado(path.join(__dirname, '..'), process.env);
    const t = P.tomarCandado(ruta, { pid: process.pid });
    if (!t.ok) {
      console.error(`[suite] Ya hay una batería completa en curso (PID ${t.pid}, desde ${new Date(t.desde).toLocaleTimeString()}). No arranco otra: espera a que termine, o lanza solo los ficheros que necesites (node test/run.js test/<x>.test.mjs).`);
      process.exit(3);
    }
    if (!t.sinCandado) candado = ruta;
  }
  // Restos de una bateria anterior que murio de golpe (kill -9 / taskkill /F del lanzador): hijos de test registrados
  // cuyo dueño ya no existe. Son nuestros (los registro este mismo lanzador), asi que se cierran sin pedir confirmacion.
  for (const e of P.leerRegistro(process.env)) {
    if (e.rol === 'test' && e.pid !== e.dueno && !P.vivo(e.dueno)) { P.matarArbol(e.pid); P.olvidar(e.pid); console.error(`[suite] Cerrado un proceso de test huérfano de una batería anterior (PID ${e.pid}).`); }
  }
  const huerfanos = P.avisoCorto({ ...process.env, FARO_EN_BATERIA: '' }, path.join(__dirname, '..'));
  if (huerfanos) console.error(`[suite] ${huerfanos.replace(/Hay una batería[^.]*\./, '').trim()}`);
  await P.esperarMemoria({ minMB: MEM_MIN, esperaS: MEM_ESPERA, aviso: (m) => console.error(`[suite] ${m}`) });

  const t0 = Date.now();
  const res = { ok: [], fallidos: [], timeouts: [], abortada: false };
  for (let i = 0; i < ficheros.length; i++) {
    const f = ficheros[i]; const nombre = path.basename(f);
    const restante = T_BATERIA > 0 ? T_BATERIA - (Date.now() - t0) / 1000 : 0;
    if (T_BATERIA > 0 && restante <= 0) { res.abortada = true; break; }
    console.log(`\n[suite ${i + 1}/${ficheros.length}] ${nombre}`);
    const r = await correr(f, T_FICHERO, T_BATERIA > 0 ? restante : 0);
    if (r.motivo === 'bateria') {
      res.timeouts.push(nombre); res.abortada = true;
      console.error(`[suite] TIMEOUT de la batería (${T_BATERIA} s) durante ${nombre}: proceso y descendientes cerrados; no se ejecuta el resto.`);
      break;
    }
    if (r.motivo === 'fichero') { res.timeouts.push(nombre); console.error(`[suite] TIMEOUT (${T_FICHERO} s) en ${nombre}: proceso y descendientes cerrados.`); }
    else if (r.codigo !== 0) res.fallidos.push(nombre);
    else res.ok.push(nombre);
  }
  const salto = ficheros.length - res.ok.length - res.fallidos.length - res.timeouts.length;
  console.log(`\n[suite] Resumen: ${ficheros.length} fichero(s) · ${res.ok.length} ok · ${res.fallidos.length} con fallos · ${res.timeouts.length} con timeout${salto ? ` · ${salto} sin ejecutar` : ''} · ${Math.round((Date.now() - t0) / 1000)} s`);
  for (const n of res.fallidos) console.log(`[suite]   FALLA ${n}`);
  for (const n of res.timeouts) console.log(`[suite]   TIMEOUT ${n}`);
  limpiarTodo();
  process.exit(res.fallidos.length || res.timeouts.length || res.abortada ? 1 : 0);
})();
