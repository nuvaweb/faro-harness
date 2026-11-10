// Tests de robustez de consolidar/aprobar (0.9.7). Cuatro fallos reportados en produccion:
//
// FALLO 1 (critico): "conflicto" falso y repo corrupto. CAUSA RAIZ: git() usa timeout 5000ms para
//   TODA operacion git — un 'git merge' de 271 ficheros/+61k lineas tarda mas, execFileSync MATA el
//   proceso, el catch devuelve null y el merge queda A MEDIAS (index.lock huerfano, ficheros en
//   estado AD). Encima, detectar el exito comparando HEAD antes/despues no distingue "conflicto" de
//   "proceso muerto", y el 'git merge --abort' posterior no puede limpiar lo que quedo a medias.
//   Arreglo: exitCode real del merge (no comparar HEAD), timeout amplio para operaciones de
//   ESCRITURA, y verificar/limpiar index.lock antes de operar.
// FALLO 2: si el merge ya estaba hecho por una invocacion anterior, 'Nada que consolidar' y NUNCA
//   empuja -> develop se queda por delante en local, en silencio.
// FALLO 3: el gate 'lint' reporta FALLA con un stacktrace de pnpm cuando lo que fallo fue
//   'pnpm install' (ERR_PNPM_IGNORED_BUILDS), no el lint.
// FALLO 4: 'consolidar --help' ejecuta la validacion real en vez de mostrar ayuda.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { umbral, plazo, conReintento } from './lib-tiempo.mjs';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${name}-`));
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: plazo(60000) });
const run = (args, cwd) =>
  spawnSync(process.execPath, [HARNESS, ...args], {
    cwd, encoding: 'utf8', timeout: plazo(60000), env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });

// FALLO 4: --help debe ser AYUDA, no ejecucion.
test('consolidar --help: muestra ayuda y NO ejecuta la consolidacion', () => {
  const dir = tmp('help-consolidar');
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), '---\niniciativa: T\nfases_total: 1\nfase_actual: 1\nowner: t\n---\n### Fase 1 · P — in_progress\n- [ ] t\n');
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  // La firma de commits heredada de la config global (gpg/1Password/ssh-sign) puede fallar o
  // pedir interaccion y dejar el repo de prueba SIN COMMITS: entonces el harness no tiene nada
  // que gobernar y el test falla por el entorno. Se apaga solo aqui, no en la config del usuario.
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'base');
  const r = run(['consolidar', '--help'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/uso|USO|ayuda|Consolida/i.test(r.stdout), `no parece ayuda: ${r.stdout}`);
  assert.ok(!/CONSOLIDACION CANCELADA|VALIDACION/.test(r.stdout), `ejecuto la validacion real en vez de mostrar ayuda: ${r.stdout}`);
});

test('aprobar --help: muestra ayuda y NO ejecuta la aprobacion', () => {
  const dir = tmp('help-aprobar');
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), '---\niniciativa: T\nfases_total: 1\nfase_actual: 1\nowner: t\n---\n### Fase 1 · P — in_progress\n- [ ] t\n');
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'base');
  const r = run(['publicar', '--help'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/uso|USO|ayuda|Aprueba/i.test(r.stdout), `no parece ayuda: ${r.stdout}`);
  assert.ok(!/SIN_TOKEN|No detecto el repo remoto|APROBARIA/.test(r.stdout), `ejecuto la aprobacion real: ${r.stdout}`);
});

// FALLO 1: el resultado del merge se decide por EXIT CODE, no comparando HEAD (que no distingue
// "conflicto real" de "proceso git muerto por timeout").
test('fuente: cmdConsolidar decide el merge por exitCode, no comparando HEAD antes/despues', () => {
  const src = fs.readFileSync(HARNESS, 'utf8');
  const ini = src.indexOf('async function cmdConsolidar');
  assert.ok(ini > 0, 'no encuentro cmdConsolidar');
  const cuerpo = src.slice(ini, ini + 5000);
  assert.ok(!/const before = git\('rev-parse', 'HEAD'\)[\s\S]{0,400}after !== before/.test(cuerpo),
    'sigue decidiendo el exito del merge comparando HEAD antes/despues (no distingue conflicto de proceso muerto)');
  assert.ok(/status|exitCode|code/.test(cuerpo), 'no usa el codigo de salida del merge para decidir');
});

// FALLO 1 (raiz): las operaciones git de ESCRITURA no pueden usar el timeout corto de las lecturas.
test('fuente: existe una via git de ESCRITURA con timeout amplio (merge de repos grandes)', () => {
  const src = fs.readFileSync(path.join(HOOKS, 'lib', 'git.js'), 'utf8');
  // Cualquier numero de milisegundos >= 60000 (usado directo o via constante) cuenta como amplio.
  const numeros = [...src.matchAll(/(?:timeout(?:_MS|_ms)?\s*[:=]\s*|TIMEOUT_MS\s*=\s*)(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(numeros.some((n) => n >= 60000),
    `lib/git.js no declara ningun timeout amplio (>=60000ms) para escritura; encontrados: ${numeros.join(', ')}`);
  assert.ok(/function gitWrite/.test(src), 'no existe gitWrite (via de escritura con exit code y timeout amplio)');
});

// FALLO 2: si develop ya esta por delante del remoto, consolidar debe EMPUJAR aunque no haya
// mergeado nada en esta invocacion.
test('consolidar: con develop por delante del remoto y nada que integrar, AVISA de que hay que empujar', () => {
  const bare = tmp('cons-bare');
  git(bare, 'init', '--bare', '-b', 'main');
  const dir = tmp('cons-push-pendiente');
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), '---\niniciativa: T\nfases_total: 1\nfase_actual: 1\nowner: t\n---\n### Fase 1 · P — in_progress\n- [ ] t\n');
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'base');
  git(dir, 'push', '-u', 'origin', 'main');
  git(dir, 'switch', '-c', 'develop');
  git(dir, 'push', '-u', 'origin', 'develop');
  // develop avanza SOLO en local (simula un merge hecho en una invocacion anterior)
  fs.writeFileSync(path.join(dir, 'a.txt'), 'trabajo ya integrado en una invocacion previa\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'merge previo ya integrado');
  const r = run(['consolidar'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  // Sin ramas de trabajo pendientes, pero develop local va por delante del remoto: debe decirlo.
  assert.ok(/sin (subir|empujar|push)|por delante|push origin develop/i.test(r.stdout),
    `no avisa de que develop local va por delante del remoto y hay que empujarlo: ${r.stdout}`);
});

// El unico rastro de "develop esta listo para publicar" era una linea de texto en medio de mucho
// output ("Estados actualizados... /faro:publicar."), facil de perder en un loop autonomo o una
// consolidacion con mucho ruido. Ahora el comando declara el ESTADO en una linea propia e
// inequivoca -- NO pregunta ni ejecuta publicar (eso sigue siendo decision del usuario, bajo
// demanda), solo hace el aviso imposible de pasar por alto.
test("consolidar: tras integrar y con develop por delante de main, declara el ESTADO 'listo para publicar' en una linea propia", () => {
  const bare = tmp('cons-listo-bare');
  git(bare, 'init', '--bare', '-b', 'main');
  const dir = tmp('cons-listo');
  fs.mkdirSync(path.join(dir, 'documentos', 'funcional'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'documentos', 'funcional', 'x.md'), '# Funcional\n');
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), '---\niniciativa: T\nfases_total: 1\nfase_actual: 1\nowner: t\nfuncional: documentos/funcional/x.md\n---\n### Fase 1 · P — in_progress\nDescripcion.\nObjetivo: 2026-12-01\n- [ ] #1 t — @t\n');
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'base'); git(dir, 'push', '-u', 'origin', 'main');
  git(dir, 'switch', '-c', 'develop'); git(dir, 'push', '-u', 'origin', 'develop');
  git(dir, 'switch', '-c', 'feat/x');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'trabajo nuevo\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'feat: x'); git(dir, 'push', '-u', 'origin', 'feat/x');
  // Sin forja no hay PRs que consultar: se integra lo que se nombra (#226).
  const r = run(['consolidar', 'feat/x'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /ESTADO:\s*develop\s+LISTO para publicar/i, `falta la linea de estado inequivoca: ${r.stdout}`);
  assert.ok(!/AskUserQuestion|apruebo\?/i.test(r.stdout), 'no debe preguntar, solo declarar el estado');
});

test("consolidar: nada nuevo respecto a main (recien creado develop), NO declara 'listo para publicar'", () => {
  const bare = tmp('cons-vacio-bare');
  git(bare, 'init', '--bare', '-b', 'main');
  const dir = tmp('cons-vacio');
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), '---\niniciativa: T\nfases_total: 1\nfase_actual: 1\nowner: t\n---\n### Fase 1 · P — in_progress\nDescripcion.\nObjetivo: 2026-12-01\n- [ ] #1 t — @t\n');
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'base'); git(dir, 'push', '-u', 'origin', 'main');
  git(dir, 'switch', '-c', 'develop'); git(dir, 'push', '-u', 'origin', 'develop');
  const r = run(['consolidar'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!/ESTADO:\s*develop\s+LISTO/i.test(r.stdout), `no deberia haber nada que publicar: ${r.stdout}`);
});

test('consolidar sin forja ni argumentos NO integra las ramas locales a ciegas (#226)', () => {
  const bare = tmp('cons-ciegas-bare');
  git(bare, 'init', '--bare', '-b', 'main');
  const dir = tmp('cons-ciegas');
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), '---\niniciativa: T\nfases_total: 1\nfase_actual: 1\nowner: t\n---\n### Fase 1 · P — in_progress\nDescripcion.\nObjetivo: 2026-12-01\n- [ ] #1 t — @t\n');
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'base'); git(dir, 'push', '-u', 'origin', 'main');
  git(dir, 'switch', '-c', 'develop'); git(dir, 'push', '-u', 'origin', 'develop');
  git(dir, 'switch', '-c', 'feat/suelta');
  fs.writeFileSync(path.join(dir, 's.txt'), 'nadie pidio integrarlo\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'feat: suelta');
  const r = run(['consolidar'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /consolidar <PR\|issue\|rama>/, r.stdout);
  assert.strictEqual(git(dir, 'rev-list', '--count', 'develop').stdout.trim(), '1', 'develop no debe avanzar');
});
