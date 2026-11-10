// El almacen (~/.faro.json) es el UNICO estado global mutable del harness, y lo escriben varios
// sitios con el patron leer -> modificar -> escribir: tokens, cache de rol, resumen de la forja,
// identidad, agregado de ramas. Entre la lectura y la escritura pueden pasar SEGUNDOS — el refresco
// en background invoca 'ramas.js --json', medido en 6,6s.
//
// Si el usuario se autentica en esa ventana, el refresco termina y escribe SU copia del objeto,
// leida antes de que el token existiera. El token DESAPARECE. Reproducido, no teorico.
//
// El sintoma en produccion seria "me desconecta cada dos por tres" — y nadie lo relacionaria con el
// resumen de ramas del arranque de sesion.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);

// Cada test con su propio fichero: el almacen real es INALCANZABLE desde los tests (un test escribio
// una vez en el ~/.faro.json del desarrollador y le borro sus tokens reales).
function almacen(nombre) {
  // Directorio propio por test: os.tmpdir() lo comparte toda la suite, y el test que comprueba que
  // no quedan temporales necesita mirar un sitio donde solo escriba el.
  const ruta = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `faro-conc-${nombre}-`)), 'almacen.json');
  process.env.FARO_CONFIG_PATH = ruta;
  const cred = require(path.join(HOOKS, 'lib', 'credenciales.js'))();
  return { ruta, cred, leer: () => JSON.parse(fs.readFileSync(ruta, 'utf8')) };
}

// ---------- la carrera que perdia tokens ----------

test('un refresco con copia OBSOLETA no borra el token guardado mientras tanto', () => {
  const { cred, leer } = almacen('carrera');
  cred.escribirCfg({ tokens: {} });

  // 1) El refresco en background LEE (aqui empieza su ventana de segundos).
  const copiaObsoleta = cred.leerCfg();

  // 2) Mientras tanto, el usuario se autentica.
  cred.guardarToken('github.com', { token: 'TOKEN-RECIEN-AUTENTICADO', forja: 'github' });
  assert.ok(leer().tokens['github.com'], 'precondicion: el token se guardo');

  // 3) El refresco termina y escribe SU copia, que no sabe nada del token.
  copiaObsoleta.resumen_agregado = { ramas: 12, ts: Date.now() };
  cred.escribirCfg(copiaObsoleta);

  const fin = leer();
  assert.ok(fin.tokens && fin.tokens['github.com'], 'EL TOKEN SE PERDIO: la escritura obsoleta lo piso');
  assert.strictEqual(fin.tokens['github.com'].token, 'TOKEN-RECIEN-AUTENTICADO');
  assert.strictEqual(fin.resumen_agregado.ramas, 12, 'y el dato del refresco tambien se guarda');
});

test('dos escritores concurrentes conservan AMBAS aportaciones', () => {
  const { cred, leer } = almacen('dos');
  cred.escribirCfg({ tokens: {} });
  const a = cred.leerCfg();
  const b = cred.leerCfg();
  a.rol_cache = { 'x/y': { rol: 'admin' } };
  b.gh_resumen = { 'x/y': { mis_tareas: 3 } };
  cred.escribirCfg(a);
  cred.escribirCfg(b);
  const fin = leer();
  assert.ok(fin.rol_cache, 'lo que escribio el primero no puede desaparecer');
  assert.ok(fin.gh_resumen, 'ni lo del segundo');
});

// Los tokens son lo irreemplazable: un resumen se recalcula, una credencial hay que volver a pedirla
// al usuario. Ante la duda, el token gana.
test('borrar un token a proposito SI funciona (la fusion no impide eliminar)', () => {
  const { cred, leer } = almacen('borrar');
  cred.guardarToken('github.com', { token: 'T1', forja: 'github' });
  const j = cred.leerCfg();
  delete j.tokens['github.com'];
  cred.escribirCfg(j);
  assert.ok(!leer().tokens['github.com'], 'un borrado explicito debe respetarse');
});

// ---------- atomicidad ----------

test('el fichero nunca queda a medias: siempre es JSON valido', () => {
  const { cred, ruta } = almacen('atomico');
  cred.escribirCfg({ tokens: { 'github.com': { token: 'T' } }, relleno: 'x'.repeat(50000) });
  const txt = fs.readFileSync(ruta, 'utf8');
  assert.doesNotThrow(() => JSON.parse(txt), 'el contenido debe ser JSON completo, no truncado');
});

test('no deja ficheros temporales tirados tras escribir', () => {
  const { cred, ruta } = almacen('temporales');
  cred.escribirCfg({ tokens: {} });
  cred.escribirCfg({ tokens: {}, otra: 1 });
  const dir = path.dirname(ruta), base = path.basename(ruta);
  const sobras = fs.readdirSync(dir).filter((f) => f.startsWith(base) && f !== base);
  assert.deepStrictEqual(sobras, [], `quedaron temporales sin limpiar: ${sobras.join(', ')}`);
});

// ---------- lo que no debe romperse ----------

test('sigue guardando y leyendo tokens con normalidad', () => {
  const { cred } = almacen('normal');
  cred.guardarToken('github.com', { token: 'ABC', forja: 'github' });
  assert.strictEqual(cred.tokenPara('github.com'), 'ABC');
  cred.guardarToken('gitlab.com', { token: 'XYZ', forja: 'gitlab' });
  assert.strictEqual(cred.tokenPara('gitlab.com'), 'XYZ');
  assert.strictEqual(cred.tokenPara('github.com'), 'ABC', 'guardar uno no puede pisar el otro');
});
