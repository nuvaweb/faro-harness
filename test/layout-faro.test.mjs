// #293 — Todo lo de FARO en una carpeta faro/. El mapa unico (lib/paths.js) detecta el layout del repo
// y resuelve TODAS las rutas de gestion desde ahi: bajo faro/ si el repo la tiene (o si es nuevo),
// en la raiz si conserva el layout antiguo (lectura dual mientras no se migre).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const paths = require(path.join(HOOKS, 'lib', 'paths.js'));
const configRepo = require(path.join(HOOKS, 'lib', 'config-repo.js'));

function repo(ficheros) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-layout-'));
  for (const [rel, txt] of Object.entries(ficheros)) {
    const abs = path.join(d, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (txt !== null) fs.writeFileSync(abs, txt);
    else fs.mkdirSync(abs, { recursive: true });
  }
  return d;
}

test('repo migrado: todo cuelga de faro/', () => {
  const r = repo({ 'faro/ESTADO.md': '# x\n', 'faro/config.json': '{}' });
  const P = paths(r);
  assert.strictEqual(P.layout, 'faro');
  assert.strictEqual(P.legado, false);
  assert.strictEqual(P.ESTADO, 'faro/ESTADO.md');
  assert.strictEqual(P.CONFIG, 'faro/config.json');
  assert.strictEqual(P.dir('gestion'), 'faro/gestion');
  assert.strictEqual(P.dir('cambios'), 'faro/gestion/cambios');
  assert.strictEqual(P.specBase, 'faro/gestion/cambios');
  assert.strictEqual(P.dir('informes'), 'faro/gestion/reporting/informes');
  assert.strictEqual(P.dir('documentos'), 'faro/documentos');
  assert.strictEqual(P.dir('scripts'), 'scripts', 'scripts/ es del producto: sigue en la raiz');
});

test('repo sin migrar: lectura dual del layout antiguo', () => {
  const r = repo({ 'ESTADO.md': '# x\n', '.faro.json': '{}', 'gestion/decisions': null });
  const P = paths(r);
  assert.strictEqual(P.layout, 'legado');
  assert.strictEqual(P.legado, true);
  assert.strictEqual(P.ESTADO, 'ESTADO.md');
  assert.strictEqual(P.CONFIG, '.faro.json');
  assert.strictEqual(P.dir('gestion'), 'gestion');
  assert.strictEqual(P.specBase, 'gestion/cambios');
});

test('repo legado solo con INICIATIVA.md: se sigue leyendo ese', () => {
  const r = repo({ 'INICIATIVA.md': '# x\n' });
  assert.strictEqual(paths(r).ESTADO, 'INICIATIVA.md');
});

test('repo nuevo, sin marcas de FARO: nace con faro/', () => {
  const r = repo({ 'src/index.js': '' });
  const P = paths(r);
  assert.strictEqual(P.layout, 'faro');
  assert.strictEqual(P.legado, false);
  assert.strictEqual(P.ESTADO, 'faro/ESTADO.md');
});

test('una carpeta faro/ ajena (sin nada de FARO dentro) no cambia un repo legado', () => {
  const r = repo({ 'ESTADO.md': '# x\n', 'faro/README.md': 'otra cosa' });
  assert.strictEqual(paths(r).layout, 'legado');
});

test('config-repo lee y escribe donde manda el layout', () => {
  const nuevo = repo({ 'faro/ESTADO.md': '# x\n' });
  assert.deepStrictEqual(configRepo.leer(nuevo), {});
  configRepo.escribir(nuevo, { tipo: 'proyecto' });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(nuevo, 'faro', 'config.json'), 'utf8')), { tipo: 'proyecto' });
  assert.ok(!fs.existsSync(path.join(nuevo, '.faro.json')));

  const viejo = repo({ 'ESTADO.md': '# x\n', '.faro.json': '{"tests":{"comando":"node --test"}}' });
  assert.strictEqual(configRepo.leer(viejo).tests.comando, 'node --test');
  configRepo.fusionar(viejo, { validacion: 'ci' });
  const j = JSON.parse(fs.readFileSync(path.join(viejo, '.faro.json'), 'utf8'));
  assert.strictEqual(j.validacion, 'ci');
  assert.strictEqual(j.tests.comando, 'node --test', 'fusionar conserva lo que habia');
});

test('ninguna lib arma a mano la ruta de la configuracion ni del ESTADO: pasan por el mapa unico', () => {
  const LIB = path.join(HOOKS, 'lib');
  const permitidas = new Set(['paths.js', 'config-repo.js', 'credenciales.js']);
  const re = /path\.join\(\s*(String\()?(root|ROOT)\)?\s*,\s*'(\.faro\.json|ESTADO\.md|INICIATIVA\.md)'/;
  const culpables = fs.readdirSync(LIB).filter((f) => f.endsWith('.js') && !permitidas.has(f))
    .filter((f) => re.test(fs.readFileSync(path.join(LIB, f), 'utf8')));
  assert.deepStrictEqual(culpables, [], `rutas fijas fuera de lib/paths.js: ${culpables.join(', ')}`);
});

test('ruta(): traduce las rutas logicas del schema (plantillas, carpetas) al layout del repo', () => {
  const nuevo = paths(repo({ 'faro/ESTADO.md': '# x\n' }));
  assert.strictEqual(nuevo.ruta('documentos/plantillas/FUN.md'), 'faro/documentos/plantillas/FUN.md');
  assert.strictEqual(nuevo.ruta('gestion/decisions/'), 'faro/gestion/decisions/');
  assert.strictEqual(nuevo.ruta('ESTADO.md'), 'faro/ESTADO.md');
  assert.strictEqual(nuevo.ruta('.faro.json'), 'faro/config.json');
  assert.strictEqual(nuevo.ruta('src/index.js'), 'src/index.js', 'lo del producto no se toca');
  assert.strictEqual(nuevo.ruta('scripts/x.js'), 'scripts/x.js');
  const viejo = paths(repo({ 'ESTADO.md': '# x\n' }));
  assert.strictEqual(viejo.ruta('documentos/plantillas/FUN.md'), 'documentos/plantillas/FUN.md');
});

test('config-repo: un JSON corrupto se lee como vacio y no se pisa al fusionar', () => {
  const r = repo({ 'faro/config.json': '{ roto' });
  assert.deepStrictEqual(configRepo.leer(r), {});
  assert.throws(() => configRepo.fusionar(r, { a: 1 }), /no es JSON/);
  assert.strictEqual(fs.readFileSync(path.join(r, 'faro', 'config.json'), 'utf8'), '{ roto');
});

test('migracion a medias (faro/ESTADO.md con la config aun en .faro.json): la config se sigue leyendo, no se ignora', () => {
  const d = repo({ 'faro/ESTADO.md': '# E\n', '.faro.json': '{"tipo":"proyecto"}\n' });
  const p = paths(d);
  assert.strictEqual(p.layout, 'faro');
  assert.strictEqual(p.CONFIG, '.faro.json');
  assert.strictEqual(configRepo.leer(d).tipo, 'proyecto');
  // en cuanto existe faro/config.json, manda ese
  fs.mkdirSync(path.join(d, 'faro'), { recursive: true });
  fs.writeFileSync(path.join(d, 'faro', 'config.json'), '{"tipo":"producto"}\n');
  assert.strictEqual(paths(d).CONFIG, 'faro/config.json');
});
