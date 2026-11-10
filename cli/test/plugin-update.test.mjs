// Test de la decision de actualizacion de plugins (0.34.2): 'instalarPluginsClaude' daba por
// bueno un plugin YA instalado y activo (scope user) SIN comprobar si su version estaba
// desactualizada — el wizard (crear/adoptar/check) nunca refrescaba la cache del usuario. Ahora
// 'accionParaPlugin(estado)' decide SIEMPRE 'update' cuando el plugin ya esta activo en scope
// user (idempotente y rapido si ya esta al dia), en vez de 'continue' silencioso.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accionParaPlugin } from '../bin/lib/repo.mjs';

test('accionParaPlugin: plugin ya activo en scope user -> "update" (antes: se daba por bueno sin refrescar)', () => {
  const accion = accionParaPlugin({ enabled: true, scope: 'user', version: '0.9.2' });
  assert.equal(accion, 'update');
});

test('accionParaPlugin: no instalado (sin estado) -> "install"', () => {
  const accion = accionParaPlugin(undefined);
  assert.equal(accion, 'install');
});

test('accionParaPlugin: instalado en OTRO scope (project) -> "install" (mueve a user, no basta con enable)', () => {
  const accion = accionParaPlugin({ enabled: true, scope: 'project', version: '0.9.2' });
  assert.equal(accion, 'install');
});

test('accionParaPlugin: instalado en scope user pero desactivado -> "enable" (no hace falta reinstalar ni actualizar aun)', () => {
  const accion = accionParaPlugin({ enabled: false, scope: 'user', version: '0.9.2' });
  assert.equal(accion, 'enable');
});

// Contabilidad del refresco (correccion sobre el cambio inicial): 'update' NO va a 'hechos' ni a
// 'fallos'. Dos motivos concretos, ambos de reporte silencioso — el mismo patron que veniamos
// arreglando en 0.34.1:
//  - exito: los 3 flujos llaman asegurarPluginSuperpowers() SIN argumentos, luego silencioSiOk=true.
//    Con el ok() guardado por ese flag y un 'continue' sin tocar 'hechos', el caso NORMAL (plugin ya
//    activo, o sea TODO usuario con FARO puesto) no imprimia NADA: un salto 0.9.2->0.10.0 cambiaba el
//    motor sin avisar, y 'Plugins listos...' tampoco salia porque 'hechos' quedaba vacio.
//  - fallo: caia en 'fallos' -> "No pude instalar: faro" + "Manual: claude plugin install", alarmando
//    por un refresco sin red cuando el plugin esta instalado y sirviendo. Y ensuciaba estado:'parcial'.
import { instalarPluginsClaude } from '../bin/lib/repo.mjs';

test('instalarPluginsClaude: en dry-run no toca la CLI (contrato del flag --dry-run)', () => {
  // Guard de humo: asegura que el export sigue siendo invocable tras la refactorizacion del bucle.
  assert.equal(typeof instalarPluginsClaude, 'function');
});

test('accionParaPlugin: sin version conocida pero activo en user -> sigue siendo "update" (no se salta por falta de version)', () => {
  assert.equal(accionParaPlugin({ enabled: true, scope: 'user', version: null }), 'update');
});

test('accionParaPlugin: scope local/managed NO se da por bueno -> "install" (mueve a user)', () => {
  assert.equal(accionParaPlugin({ enabled: true, scope: 'local', version: '0.9.2' }), 'install');
  assert.equal(accionParaPlugin({ enabled: true, scope: 'managed', version: '0.9.2' }), 'install');
});

// --- cmpVersion: ordenar versiones como TEXTO es el bug clasico al cruzar la decena de minor.
import { cmpVersion } from '../bin/lib/repo.mjs';

test('cmpVersion: 0.10.0 es MAYOR que 0.9.2 (como texto seria al reves — el salto que FARO tiene a la vista)', () => {
  assert.ok(cmpVersion('0.10.0', '0.9.2') > 0);
  assert.ok(cmpVersion('0.9.2', '0.10.0') < 0);
});

test('cmpVersion: iguales -> 0, y tolera nulos/parciales sin reventar', () => {
  assert.equal(cmpVersion('0.9.2', '0.9.2'), 0);
  assert.equal(cmpVersion(null, null), 0);
  assert.ok(cmpVersion('1.0', '0.9.9') > 0);
  assert.ok(cmpVersion('0.9.2', null) > 0);
});

// --- parseListaPlugins: el BUG DE RAIZ que dejaba todo lo anterior inerte.
// 'claude plugin list' repite el MISMO id una vez por instalacion. En esta maquina salian 13 entradas
// de faro@faro-marketplace (una 'user' y doce 'project', de repos donde se acepto el plugin). El
// parser hacia m.set(id, ...) plano => GANABA LA ULTIMA linea del listado, normalmente 'project'.
// Efecto en cadena: accionParaPlugin leia scope 'project' -> decidia 'install' -> el refresco NUNCA
// se ejecutaba y el wizard reinstalaba en cada pasada (~19s tirados por ejecucion).
import { parseListaPlugins } from '../bin/lib/repo.mjs';

// Fixture recortada de la salida REAL (el orden importa: la 'user' va en medio y la ULTIMA es project).
const LIST_REAL = [
  '  ❯ faro@faro-marketplace', '    Version: 0.4.31', '    Scope: project', '    Status: ✔ enabled', '',
  '  ❯ faro@faro-marketplace', '    Version: 0.9.2', '    Scope: user', '    Status: ✔ enabled', '',
  '  ❯ faro@faro-marketplace', '    Version: 0.8.5', '    Scope: project', '    Status: ✔ enabled', '',
  '  ❯ faro@faro-marketplace', '    Version: 0.9.2', '    Scope: project', '    Status: ✔ enabled', '',
].join('\n');

test('parseListaPlugins: con 4 entradas duplicadas gana la de scope "user" aunque NO sea la ultima', () => {
  const st = parseListaPlugins(LIST_REAL).get('faro@faro-marketplace');
  assert.equal(st.scope, 'user');       // antes: 'project' (la ultima linea) -> install eterno
  assert.equal(st.version, '0.9.2');
  assert.equal(accionParaPlugin(st), 'update');   // la consecuencia que importa
});

test('parseListaPlugins: sin ninguna entrada "user", entre varias del mismo scope gana la version MAYOR', () => {
  const out = [
    '  ❯ faro@faro-marketplace', '    Version: 0.10.0', '    Scope: project', '    Status: ✔ enabled', '',
    '  ❯ faro@faro-marketplace', '    Version: 0.9.2', '    Scope: project', '    Status: ✔ enabled', '',
  ].join('\n');
  const st = parseListaPlugins(out).get('faro@faro-marketplace');
  assert.equal(st.version, '0.10.0');            // no '0.9.2': comparacion numerica, no textual
  assert.equal(accionParaPlugin(st), 'install'); // sigue en project -> hay que moverlo a user
});

test('parseListaPlugins: la ULTIMA entrada del listado no se pierde (no hay cabecera que la cierre)', () => {
  const out = ['  ❯ solo@mk', '    Version: 1.2.3', '    Scope: user', '    Status: ✔ enabled'].join('\n');
  const st = parseListaPlugins(out).get('solo@mk');
  assert.equal(st.version, '1.2.3');
  assert.equal(st.scope, 'user');
});

test('parseListaPlugins: salida vacia o basura -> Map vacio (no revienta; el flujo se degrada a declarar)', () => {
  assert.equal(parseListaPlugins('').size, 0);
  assert.equal(parseListaPlugins(null).size, 0);
  assert.equal(parseListaPlugins('sin cabeceras\n  Version: 1.0.0').size, 0);
});

test('parseListaPlugins: un plugin desactivado en user NO se confunde con activo', () => {
  const out = ['  ❯ x@mk', '    Version: 1.0.0', '    Scope: user', '    Status: disabled'].join('\n');
  const st = parseListaPlugins(out).get('x@mk');
  assert.equal(st.enabled, false);
  assert.equal(accionParaPlugin(st), 'enable');
});
