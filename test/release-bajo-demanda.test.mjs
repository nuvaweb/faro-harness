// DESACOPLAR "cerrar el ciclo" de "publicar el release".
//
// Hoy 'aprobar' hace cinco cosas a la vez (valida, archiva, mergea a main, taguea, publica), asi que
// no se puede cerrar un ciclo sin publicar — y eso obliga a promover a main en CADA ciclo. Pero main
// no significa "trabajo terminado", significa RELEASE: puede agrupar varios ciclos, y cuando lo
// decida quien manda.
//
// El estandar que resuelve esto es Keep a Changelog: cada ciclo escribe en [Unreleased], y al
// publicar se mueve ese bloque bajo su version. Y un tag apunta a un COMMIT, no a una rama, asi que
// nada obliga a que el versionado espere a main.
//
//   develop:  ciclo -> ciclo -> ciclo        (cada uno cierra del todo, acumula en [Unreleased])
//   main:                      release       (bajo demanda, agrupa lo acumulado)
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { leerUnreleased, promoverUnreleased, analizarRelease } = require(path.join(HOOKS, 'lib', 'ciclo.js'));

const CHANGELOG = `# Changelog

## [Unreleased]

- Primer ciclo: el arranque abre su rama.
- Segundo ciclo: el PR cierra su tarea.

## 0.36.3 - 2026-09-19

- Algo anterior.
`;

// ---------- leer lo acumulado sin publicar ----------

test('leerUnreleased: devuelve lo acumulado por los ciclos', () => {
  const u = leerUnreleased(CHANGELOG);
  assert.match(u, /Primer ciclo/);
  assert.match(u, /Segundo ciclo/);
  assert.doesNotMatch(u, /Algo anterior/, 'no debe colarse lo ya publicado');
});

test('leerUnreleased: sin seccion [Unreleased] devuelve vacio, no revienta', () => {
  assert.strictEqual(leerUnreleased('# Changelog\n\n## 0.1.0\n\n- x\n'), '');
  assert.strictEqual(leerUnreleased(''), '');
});

test('leerUnreleased: seccion presente pero VACIA = nada que publicar', () => {
  assert.strictEqual(leerUnreleased('# Changelog\n\n## [Unreleased]\n\n## 0.1.0\n\n- x\n').trim(), '');
});

// ---------- promover: [Unreleased] pasa a ser una version ----------

test('promoverUnreleased: mueve lo acumulado bajo la version nueva, con su fecha', () => {
  const r = promoverUnreleased(CHANGELOG, '0.37.0', '2026-09-20');
  assert.match(r, /## 0\.37\.0 - 2026-09-20/, r.slice(0, 300));
  assert.match(r, /## 0\.37\.0[\s\S]*Primer ciclo/, 'lo acumulado debe quedar bajo la version');
  assert.match(r, /## 0\.36\.3/, 'y no se pierde lo anterior');
});

test('promoverUnreleased: deja [Unreleased] VACIA y lista para el siguiente ciclo', () => {
  const r = promoverUnreleased(CHANGELOG, '0.37.0', '2026-09-20');
  assert.match(r, /## \[Unreleased\]/, 'la seccion sigue existiendo');
  assert.strictEqual(leerUnreleased(r).trim(), '', 'pero vacia');
  // y el orden se mantiene: Unreleased arriba, luego la version nueva
  assert.ok(r.indexOf('[Unreleased]') < r.indexOf('0.37.0'), 'Unreleased va primero');
});

test('promoverUnreleased: sin nada acumulado NO inventa una version vacia', () => {
  const vacio = '# Changelog\n\n## [Unreleased]\n\n## 0.1.0\n\n- x\n';
  assert.strictEqual(promoverUnreleased(vacio, '0.2.0', '2026-09-20'), vacio, 'se deja igual');
});

test('promoverUnreleased: un CHANGELOG sin [Unreleased] se deja intacto', () => {
  const sin = '# Changelog\n\n## 0.1.0\n\n- x\n';
  assert.strictEqual(promoverUnreleased(sin, '0.2.0', '2026-09-20'), sin);
});

// ---------- TRAZABILIDAD: desde donde se publico el ultimo main ----------
//
// "Pasar a produccion no se automatiza, se invoca — pero tiene que haber REGISTRO de desde que punto
// se publico lo anterior." Sin eso, publicar es a ciegas: nadie sabe cuantos ciclos lleva acumulados
// ni desde cuando. El release deja de ser un merge y pasa a ser una decision informada.

test('analizarRelease: dice cuantos ciclos van desde el ultimo release y cuales', () => {
  const r = analizarRelease({
    ultimoTag: 'v0.36.3',
    commits: [
      'feat(ciclo): terminar y ligadura',
      'fix(rama): el issue no se leia',
      'chore: bump',
    ],
    unreleased: '- Algo nuevo.',
    versionActual: '0.36.3',
  });
  assert.strictEqual(r.desde, 'v0.36.3');
  assert.strictEqual(r.ciclos, 3);
});

test('analizarRelease: propone MINOR si hay feat, PATCH si solo hay fix', () => {
  const conFeat = analizarRelease({ ultimoTag: 'v1.2.3', commits: ['feat: algo', 'fix: otro'], unreleased: '- x', versionActual: '1.2.3' });
  assert.strictEqual(conFeat.sugerida, '1.3.0', 'un feat sube MINOR');

  const soloFix = analizarRelease({ ultimoTag: 'v1.2.3', commits: ['fix: algo', 'chore: otro'], unreleased: '- x', versionActual: '1.2.3' });
  assert.strictEqual(soloFix.sugerida, '1.2.4', 'sin feat, sube PATCH');
});

test('analizarRelease: un cambio BREAKING sube MAJOR', () => {
  const r = analizarRelease({ ultimoTag: 'v1.2.3', commits: ['feat!: rompe la API', 'fix: x'], unreleased: '- x', versionActual: '1.2.3' });
  assert.strictEqual(r.sugerida, '2.0.0');
});

test('analizarRelease: SIN nada acumulado dice que no hay release que hacer', () => {
  const r = analizarRelease({ ultimoTag: 'v1.2.3', commits: [], unreleased: '', versionActual: '1.2.3' });
  assert.strictEqual(r.hayQuePublicar, false);
  assert.match(r.motivo, /nada|sin cambios/i, r.motivo);
});

test('analizarRelease: sin ningun tag previo (primer release) no se rompe', () => {
  const r = analizarRelease({ ultimoTag: null, commits: ['feat: lo primero'], unreleased: '- x', versionActual: '0.1.0' });
  assert.strictEqual(r.hayQuePublicar, true);
  assert.match(String(r.desde), /inicio|primer/i, `debe decir que no hay release anterior: ${r.desde}`);
});
