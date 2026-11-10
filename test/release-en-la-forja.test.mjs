// El RELEASE de la forja se crea desde la entrada del CHANGELOG, al aprobar.
//
// Estado previo: el motor validaba version <-> CHANGELOG (gate duro) y creaba el TAG, pero NO el
// Release. Resultado real: 11 tags publicados y 0 releases — quien mira el repo desde la web no ve
// ninguna nota de version, aunque estuvieran escritas.
//
// La coherencia se mantiene POR CONSTRUCCION: las notas del Release se extraen de la MISMA entrada
// del CHANGELOG que el gate ya exigio. No hay dos fuentes, asi que no pueden divergir.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${n}-`));

const CHANGELOG = `# Changelog — plugin faro

## 0.5.0 — 2026-09-19

- Lo primero que trae esta version.
- Lo segundo, con **formato** y \`codigo\`.

## 0.4.0 — 2026-09-18

- Version anterior, NO debe colarse en las notas de la 0.5.0.
`;

async function cargar(root) {
  const mod = await import(`file://${path.join(HOOKS, 'lib', 'release.js').replace(/\\/g, '/')}`);
  return (mod.default || mod)({ ROOT: root, git: () => '' });
}
function repo(changelog = CHANGELOG, version = '0.5.0') {
  const root = tmp('release');
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), changelog);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version }));
  return root;
}

test('notasDeVersion: extrae SOLO el bloque de esa version, sin arrastrar la siguiente', async () => {
  const r = await cargar(repo());
  const notas = r.notasDeVersion('0.5.0');
  assert.match(notas, /Lo primero que trae esta version/, notas);
  assert.match(notas, /Lo segundo/, notas);
  assert.doesNotMatch(notas, /Version anterior/, 'no debe incluir la entrada de la 0.4.0');
});

test('notasDeVersion: quita la cabecera "## version — fecha" (el Release ya muestra version y fecha)', async () => {
  const r = await cargar(repo());
  const notas = r.notasDeVersion('0.5.0');
  assert.doesNotMatch(notas, /^##/, `la cabecera sobra en las notas:\n${notas.slice(0, 80)}`);
  assert.match(notas, /^- /, 'debe empezar directamente por el contenido');
});

test('notasDeVersion: tambien quita la cabecera con finales de linea CRLF (ficheros de Windows)', async () => {
  // El CHANGELOG de un repo en Windows suele venir con \r\n: una regex con '.*\\n' NO casa ahi, y la
  // cabecera se colaba en las notas del Release. Caso real, detectado al publicar la 0.34.0.
  const r = await cargar(repo(CHANGELOG.replace(/\n/g, '\r\n')));
  const notas = r.notasDeVersion('0.5.0');
  assert.doesNotMatch(notas, /^##/, `con CRLF tambien debe quitarse:\n${JSON.stringify(notas.slice(0, 60))}`);
  assert.match(notas, /Lo primero que trae esta version/);
});

test('notasDeVersion: conserva el formato markdown tal cual (negritas, codigo, viñetas)', async () => {
  const r = await cargar(repo());
  const notas = r.notasDeVersion('0.5.0');
  assert.match(notas, /\*\*formato\*\*/, 'las negritas se mantienen');
  assert.match(notas, /`codigo`/, 'el codigo en linea se mantiene');
  assert.match(notas, /^- /m, 'las viñetas se mantienen');
});

test('notasDeVersion: la ULTIMA version del fichero tambien se extrae entera (no hay siguiente que la corte)', async () => {
  const r = await cargar(repo(`# Changelog\n\n## 0.1.0 — 2026-01-01\n\n- Unica entrada del fichero.\n`, '0.1.0'));
  const notas = r.notasDeVersion('0.1.0');
  assert.match(notas, /Unica entrada del fichero/, notas);
});

test('notasDeVersion: una version que NO esta en el CHANGELOG devuelve null (no inventa notas)', async () => {
  const r = await cargar(repo());
  assert.strictEqual(r.notasDeVersion('9.9.9'), null);
});

test('notasDeVersion: sin CHANGELOG.md devuelve null, no revienta', async () => {
  const root = tmp('sin-changelog');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.5.0' }));
  const r = await cargar(root);
  assert.strictEqual(r.notasDeVersion('0.5.0'), null);
});

// --- Publicacion en la forja (github-gestion.js) ---

function apiFalsa(rutas) {
  const llamadas = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url).replace('https://api.github.com/', ''); const metodo = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : null;
    llamadas.push({ metodo, ruta: u, body });
    for (const [re, fn] of rutas) { const m = u.match(re); if (m && (!fn.metodo || fn.metodo === metodo)) { const r = fn.resp(m, body); return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body), json: async () => r.body }; } }
    return { ok: false, status: 404, text: async () => '{}', json: async () => ({ message: 'Not Found' }) };
  };
  return llamadas;
}
const R = (re, resp, metodo) => [re, { resp, metodo }];

async function gestion() {
  const mod = await import(`file://${path.join(HOOKS, 'lib', 'github-gestion.js').replace(/\\/g, '/')}`);
  return mod.default({
    ghApi: async (p, opts) => { const r = await fetch(`https://api.github.com/${p}`, opts || {}); return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) }; },
    ghRepo: () => ({ org: 'org', repo: 'repo' }), sinToken: () => 'SIN_TOKEN', git: () => '',
    fases: () => [], isDone: (e) => e === 'done',
  });
}

test('publicarRelease: crea el release con el tag y las notas recibidas', async () => {
  const llamadas = apiFalsa([
    R(/^repos\/org\/repo\/releases\/tags\/v0\.5\.0$/, () => ({ status: 404, body: {} })),
    R(/^repos\/org\/repo\/releases$/, (_m, b) => ({ status: 201, body: { id: 1, html_url: 'u', ...b } }), 'POST'),
  ]);
  const g = await gestion();
  const res = await g.publicarRelease('v0.5.0', '- Lo primero.\n- Lo segundo.');
  assert.ok(res.ok, JSON.stringify(res));
  const post = llamadas.find((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/releases');
  assert.strictEqual(post.body.tag_name, 'v0.5.0');
  assert.match(post.body.body, /Lo primero/);
});

test('publicarRelease: si el release de ese tag YA existe, no lo duplica', async () => {
  const llamadas = apiFalsa([
    R(/^repos\/org\/repo\/releases\/tags\/v0\.5\.0$/, () => ({ status: 200, body: { id: 7, html_url: 'ya' } })),
    R(/^repos\/org\/repo\/releases$/, () => ({ status: 201, body: {} }), 'POST'),
  ]);
  const g = await gestion();
  const res = await g.publicarRelease('v0.5.0', '- notas');
  assert.ok(res.yaExistia, 'debe detectar que ya estaba publicado');
  assert.ok(!llamadas.some((c) => c.metodo === 'POST'), 'no debe crear uno nuevo');
});

test('publicarRelease: un fallo de la forja se informa pero NO lanza (el tag ya esta, que es lo que importa)', async () => {
  apiFalsa([
    R(/^repos\/org\/repo\/releases\/tags\/v0\.5\.0$/, () => ({ status: 404, body: {} })),
    R(/^repos\/org\/repo\/releases$/, () => ({ status: 403, body: { message: 'Forbidden' } }), 'POST'),
  ]);
  const g = await gestion();
  const res = await g.publicarRelease('v0.5.0', '- notas');
  assert.strictEqual(res.ok, false);
  assert.match(String(res.msg), /403|Forbidden/, JSON.stringify(res));
});

// --- Agrupacion por tipo: los commits del rango dicen QUE clase de cambio entro ---
// El CHANGELOG cuenta el POR QUE (lo escribe una persona); los commits dan la clasificacion dura
// (feat/fix/docs...). Juntos, las notas quedan ordenadas sin que nadie las ordene a mano.

async function cargarConCommits(root, commits) {
  const mod = await import(`file://${path.join(HOOKS, 'lib', 'release.js').replace(/\\/g, '/')}`);
  return (mod.default || mod)({
    ROOT: root,
    // git('log', ...) devuelve los asuntos de commit del rango, uno por linea.
    git: (...a) => (a[0] === 'log' ? commits.join('\n') : (a[0] === 'describe' ? 'v0.4.0' : '')),
  });
}

test('agruparCambios: separa features, correcciones y el resto, con el prefijo ya quitado', async () => {
  const r = await cargarConCommits(repo(), [
    'feat(tareas): anclar al ciclo',
    'fix(root): el harness gobierna el repo',
    'feat(hitos): fecha objetivo',
    'docs: aclarar la skill',
    'chore(release): 0.5.0',
  ]);
  const g = r.agruparCambios('v0.4.0');
  assert.strictEqual(g.features.length, 2, JSON.stringify(g));
  assert.strictEqual(g.correcciones.length, 1, JSON.stringify(g));
  assert.match(g.features[0], /anclar al ciclo/);
  assert.doesNotMatch(g.features[0], /^feat/, 'el prefijo sobra en las notas: ya lo dice el grupo');
});

test('agruparCambios: el commit de release no se lista (es ruido de proceso, no un cambio)', async () => {
  const r = await cargarConCommits(repo(), ['feat: algo', 'chore(release): 0.5.0', 'merge develop -> main: x']);
  const g = r.agruparCambios('v0.4.0');
  const todo = JSON.stringify(g);
  assert.doesNotMatch(todo, /chore\(release\)/, todo);
  assert.doesNotMatch(todo, /merge develop/, 'los merges de integracion tampoco son cambios');
});

test('agruparCambios: sin commits clasificables devuelve grupos vacios, no revienta', async () => {
  const r = await cargarConCommits(repo(), []);
  const g = r.agruparCambios('v0.4.0');
  assert.deepStrictEqual(g.features, []);
  assert.deepStrictEqual(g.correcciones, []);
});

// El release tiene que CONVIVIR con el estado del proyecto: no basta con listar commits, hay que
// saber QUE TAREAS cerro y de que FASE eran. Ese enlace ya existe en los commits/PRs ('Closes #42'),
// solo hay que leerlo — el mismo dato que cierra el issue alimenta las notas.
test('tareasCerradas: extrae los numeros de issue referenciados en los commits del rango', async () => {
  const r = await cargarConCommits(repo(), [
    'feat(tareas): anclar al ciclo (#42)',
    'fix: algo sin referencia',
    'feat: otra cosa\n\nCloses #51',
  ]);
  const nums = r.tareasCerradas('v0.4.0');
  assert.deepStrictEqual(nums.sort((a, b) => a - b), [42, 51], JSON.stringify(nums));
});

test('tareasCerradas: no confunde un numero cualquiera con una referencia a issue', async () => {
  const r = await cargarConCommits(repo(), ['chore: subir a node 22', 'fix: timeout de 30 segundos']);
  assert.deepStrictEqual(r.tareasCerradas('v0.4.0'), [], 'ni "22" ni "30" son issues');
});

test('tareasCerradas: no repite un issue citado en varios commits', async () => {
  const r = await cargarConCommits(repo(), ['feat: parte 1 (#42)', 'fix: parte 2 de lo mismo (#42)']);
  assert.deepStrictEqual(r.tareasCerradas('v0.4.0'), [42]);
});

// REPO CON HISTORIA PREVIA: solo hacia adelante. Recrear los releases de tags viejos publicaria
// fechas falsas (todas de hoy) y notas reconstruidas a posteriori — un release es un HECHO publicado
// en un momento, no un registro que se rellena despues. Los tags antiguos siguen ahi y el CHANGELOG
// ya guarda esa historia, que es su sitio.
test('publicarRelease: no se recrean releases de tags anteriores — solo se publica el del tag que se acaba de crear', async () => {
  const llamadas = apiFalsa([
    R(/^repos\/org\/repo\/releases\/tags\/v0\.5\.0$/, () => ({ status: 404, body: {} })),
    R(/^repos\/org\/repo\/releases$/, (_m, b) => ({ status: 201, body: { id: 1, html_url: 'u', ...b } }), 'POST'),
    // Si alguien intentara publicar los viejos, estas rutas se tocarian. No deben tocarse.
    R(/^repos\/org\/repo\/releases\/tags\/v0\.4\.0$/, () => ({ status: 404, body: {} })),
  ]);
  const g = await gestion();
  await g.publicarRelease('v0.5.0', '- solo esta version');
  const tocaViejos = llamadas.filter((c) => /v0\.4\.0/.test(c.ruta));
  assert.deepStrictEqual(tocaViejos, [], 'publicar la 0.5.0 no debe mirar ni crear releases anteriores');
  const posts = llamadas.filter((c) => c.metodo === 'POST' && c.ruta === 'repos/org/repo/releases');
  assert.strictEqual(posts.length, 1, 'exactamente un release: el del tag recien creado');
});
