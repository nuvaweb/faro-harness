// Alta de un repo: API de la forja + contenido por git. El remoto es un repo bare local y la forja un
// doble con el contrato `alta`: lo que se comprueba es qué queda de verdad en el remoto y en qué orden.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sembrarRepo, superponerPlantilla, altaDesdeEsqueleto, identidadDe, urlGitDe, asegurarMantenedor } from '../bin/lib/alta.mjs';
import { clonadorPublico, conPlantillasPublicas } from '../bin/lib/monorepo.mjs';
import { NATURALEZAS } from '../bin/lib/model.mjs';

const tmp = (pre = 'faro-alta-') => fs.mkdtempSync(path.join(os.tmpdir(), pre));
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const IDENTIDAD = { nombre: 'Ana', email: 'ana@ejemplo.test' };

function remotoVacio() {
  const d = tmp('faro-bare-');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', d], { stdio: 'ignore' });
  return { dir: d, url: pathToFileURL(d).href };
}

function plantillaPublica() {
  const d = tmp('faro-plantilla-');
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 'p@p'); git(d, 'config', 'user.name', 'p');
  fs.writeFileSync(path.join(d, 'package.json'), '{"name":"stack"}\n');
  fs.writeFileSync(path.join(d, 'README.md'), '# Stack\n');
  fs.writeFileSync(path.join(d, '.gitignore'), 'dist/\n');
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'stack');
  return pathToFileURL(d).href;
}

function forjaDoble({ crear = { ok: true, status: 201, ruta: 'ana/x', web: 'https://forja/ana/x', mensaje: null } } = {}) {
  const orden = [];
  const paso = (n, r = { ok: true, status: 200 }) => async (...a) => { orden.push({ n, a }); return r; };
  return { orden, alta: {
    crearRepo: paso('crearRepo', crear), ramaPorDefecto: paso('ramaPorDefecto'), estamparTopics: paso('estamparTopics'),
    proteger: paso('proteger'), configurar: paso('configurar'),
  } };
}

test('sembrarRepo: el remoto vacío queda con main y develop en el mismo commit, y con el esqueleto', () => {
  const r = remotoVacio();
  sembrarRepo({ url: r.url, identidad: IDENTIDAD });
  assert.equal(git(r.dir, 'rev-parse', 'main'), git(r.dir, 'rev-parse', 'develop'));
  const ficheros = git(r.dir, 'ls-tree', '-r', '--name-only', 'main').split('\n');
  for (const f of ['.gitignore', 'CLAUDE.md', 'faro/gestion/risks.md', 'faro/borrador/data/.gitkeep']) assert.ok(ficheros.includes(f), f);
  assert.equal(ficheros.includes('gitignore'), false);
  assert.equal(git(r.dir, 'log', '-1', '--format=%ae', 'main'), 'ana@ejemplo.test');
});

test('sembrarRepo: si git falla, el error no lleva la URL ni el token', () => {
  const url = `${pathToFileURL(path.join(tmp(), 'no-existe')).href}?token=SECRETO`;
  assert.throws(() => sembrarRepo({ url, identidad: IDENTIDAD }), (e) => {
    assert.equal(e.message.includes('SECRETO'), false, e.message);
    assert.match(e.message, /contenido inicial/);
    return true;
  });
});

test('superponerPlantilla: el stack manda, sin su historial, y el .gitignore conserva lo del esqueleto', () => {
  const raiz = tmp();
  fs.writeFileSync(path.join(raiz, 'README.md'), '# Esqueleto\n');
  fs.writeFileSync(path.join(raiz, 'CLAUDE.md'), 'guía\n');
  const r = superponerPlantilla({ url: plantillaPublica(), repo: 'stack' }, raiz);
  assert.deepEqual(r, { ok: true, motivo: null });
  assert.match(fs.readFileSync(path.join(raiz, 'README.md'), 'utf8'), /^# Stack/);   // autocrlf puede cambiar el fin de línea
  assert.ok(fs.existsSync(path.join(raiz, 'package.json')));
  assert.ok(fs.existsSync(path.join(raiz, 'CLAUDE.md')), 'lo que el stack no trae sigue');
  assert.equal(fs.existsSync(path.join(raiz, '.git')), false);
  const ignore = fs.readFileSync(path.join(raiz, '.gitignore'), 'utf8');
  assert.match(ignore, /dist\//); assert.match(ignore, /^\.env$/m);
});

test('superponerPlantilla: si no se puede clonar, deja la raíz intacta y dice por qué', () => {
  const raiz = tmp();
  fs.writeFileSync(path.join(raiz, 'README.md'), '# Esqueleto\n');
  const r = superponerPlantilla({ repo: 'stack', url: pathToFileURL(path.join(tmp(), 'nada')).href }, raiz);
  assert.equal(r.ok, false); assert.match(r.motivo, /stack/);
  assert.deepEqual(fs.readdirSync(raiz), ['README.md']);
});

test('clonadorPublico: una plantilla sin URL pública no intenta nada y falla nombrándola', () => {
  assert.throws(() => clonadorPublico({ repo: 'interna' }, tmp()), /interna/);
});

test('conPlantillasPublicas: solo ofrece las plantillas con URL, sin alterar el catálogo original', () => {
  const nat = { worker: { etiqueta: 'w', plantillas: { pub: { url: 'https://x/y.git' }, sinUrl: { repo: 'z' } } }, doc: { etiqueta: 'd' } };
  const r = conPlantillasPublicas(nat);
  assert.deepEqual(Object.keys(r.worker.plantillas), ['pub']);
  assert.equal(r.doc.etiqueta, 'd');
  assert.ok(nat.worker.plantillas.sinUrl, 'el original no cambia');
});

test('el catálogo del paquete solo declara plantillas sin origen o con URL pública por https', () => {
  for (const n of Object.values(NATURALEZAS)) for (const pl of Object.values(n.plantillas || {})) {
    if (pl.url) assert.match(pl.url, /^https:\/\//);
  }
});

test('altaDesdeEsqueleto: crea en la forja, siembra, y solo entonces fija develop, topics y protección', async () => {
  const r = remotoVacio(); const f = forjaDoble();
  const res = await altaDesdeEsqueleto({
    alta: f.alta, sesion: { host: 'h', token: 't' }, destino: { org: 'ana', personal: true },
    nombre: 'x', descripcion: 'd', topics: ['faro'], urlGit: (ruta) => { assert.equal(ruta, 'ana/x'); return r.url; }, identidad: IDENTIDAD,
  });
  assert.equal(res.ok, true); assert.equal(res.ruta, 'ana/x'); assert.equal(res.plantillaError, null);
  assert.equal(res.develop, true); assert.equal(res.protegida, true);
  assert.deepEqual(f.orden.map((o) => o.n), ['crearRepo', 'ramaPorDefecto', 'estamparTopics', 'configurar', 'proteger']);
  assert.deepEqual(f.orden[1].a.slice(1), ['ana/x', 'develop'], 'develop por defecto');
  assert.deepEqual(f.orden[4].a.slice(1), ['ana/x', 'main'], 'se protege main');
  assert.ok(git(r.dir, 'rev-parse', 'develop'));
});

test('altaDesdeEsqueleto: si la forja rechaza el repo, no toca git', async () => {
  const f = forjaDoble({ crear: { ok: false, status: 403, ruta: null, web: null, mensaje: 'sin permiso' } });
  const res = await altaDesdeEsqueleto({
    alta: f.alta, sesion: {}, destino: { org: 'acme', personal: false }, nombre: 'x', topics: [],
    urlGit: () => { throw new Error('no debe pedir la URL'); }, identidad: IDENTIDAD,
  });
  assert.deepEqual({ ok: res.ok, fase: res.fase, mensaje: res.mensaje }, { ok: false, fase: 'crear', mensaje: 'sin permiso' });
  assert.equal(f.orden.length, 1);
});

test('altaDesdeEsqueleto: plantilla no disponible = repo con esqueleto y motivo para avisar', async () => {
  const r = remotoVacio(); const f = forjaDoble();
  const res = await altaDesdeEsqueleto({
    alta: f.alta, sesion: {}, destino: { org: 'ana', personal: true }, nombre: 'x', topics: [], urlGit: () => r.url, identidad: IDENTIDAD,
    plantilla: { repo: 'stack', url: pathToFileURL(path.join(tmp(), 'nada')).href },
  });
  assert.equal(res.ok, true); assert.match(res.plantillaError, /stack/);
  assert.ok(git(r.dir, 'ls-tree', '-r', '--name-only', 'main').split('\n').includes('CLAUDE.md'));
});

test('altaDesdeEsqueleto: con plantilla disponible el stack entra en el primer commit', async () => {
  const r = remotoVacio(); const f = forjaDoble();
  const res = await altaDesdeEsqueleto({
    alta: f.alta, sesion: {}, destino: { org: 'ana', personal: true }, nombre: 'x', topics: [], urlGit: () => r.url, identidad: IDENTIDAD,
    plantilla: { repo: 'stack', url: plantillaPublica() },
  });
  assert.equal(res.plantillaError, null);
  assert.ok(git(r.dir, 'ls-tree', '-r', '--name-only', 'main').split('\n').includes('package.json'));
  assert.equal(git(r.dir, 'rev-list', '--count', 'main'), '1');
});

test('altaDesdeEsqueleto: si el contenido no llega, informa del repo ya creado, sin seguir con develop', async () => {
  const f = forjaDoble();
  const res = await altaDesdeEsqueleto({
    alta: f.alta, sesion: {}, destino: { org: 'ana', personal: true }, nombre: 'x', topics: [],
    urlGit: () => pathToFileURL(path.join(tmp(), 'nada')).href, identidad: IDENTIDAD,
  });
  assert.equal(res.ok, false); assert.equal(res.fase, 'contenido'); assert.equal(res.ruta, 'ana/x');
  assert.deepEqual(f.orden.map((o) => o.n), ['crearRepo']);
});

test('identidadDe: usa el correo de la cuenta y, si es privado, el noreply con el formato de su forja', () => {
  const propio = { forja: 'gitlab', host: 'code.empresa.com' };
  assert.deepEqual(identidadDe({ name: 'Ana', login: 'ana', id: 7, email: 'a@b.c' }, propio), { nombre: 'Ana', email: 'a@b.c' });
  assert.deepEqual(identidadDe({ login: 'ana', id: 7 }, propio), { nombre: 'ana', email: '7-ana@users.noreply.code.empresa.com' });
  assert.equal(identidadDe({ login: 'ana', id: 7 }, { forja: 'github', host: 'github.com' }).email, '7+ana@users.noreply.github.com');
});

test('urlGitDe: la URL autenticada usa el usuario de cada forja', () => {
  assert.equal(urlGitDe({ forja: 'gitlab', host: 'git.acme.es' }, 'T', 'a/b'), 'https://oauth2:T@git.acme.es/a/b.git');
  assert.equal(urlGitDe({ forja: 'github', host: 'github.com' }, 'T', 'a/b'), 'https://x-access-token:T@github.com/a/b.git');
});

test('asegurarMantenedor: en un grupo de GitLab fija al creador como Maintainer; 409 es que ya lo era', async () => {
  const llamadas = [];
  const forja = (status) => ({ id: 'gitlab', anadirMiembro: async (...a) => { llamadas.push(a); return { ok: status < 300, status }; } });
  const s = { host: 'h', token: 't' };
  assert.deepEqual(await asegurarMantenedor(forja(201), s, { org: 'g', personal: false }, 'g/x', 7), { aplicado: true, ok: true, status: 201 });
  assert.deepEqual(llamadas[0], ['h', 't', 'g/x', 7, 40]);
  assert.equal((await asegurarMantenedor(forja(409), s, { org: 'g', personal: false }, 'g/x', 7)).ok, true);
  assert.equal((await asegurarMantenedor(forja(500), s, { org: 'g', personal: false }, 'g/x', 7)).ok, false);
});

test('asegurarMantenedor: en cuenta personal o en GitHub no hay nada que fijar', async () => {
  const forja = { id: 'github', anadirMiembro: async () => { throw new Error('no debe llamarse'); } };
  assert.equal((await asegurarMantenedor(forja, {}, { org: 'acme', personal: false }, 'acme/x', 7)).aplicado, false);
  const gl = { id: 'gitlab', anadirMiembro: forja.anadirMiembro };
  assert.equal((await asegurarMantenedor(gl, {}, { org: 'ana', personal: true }, 'ana/x', 7)).aplicado, false);
});
