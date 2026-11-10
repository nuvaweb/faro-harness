import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERFILES, ORIGEN_PLUGIN, perfilesConocidos, perfilDeForja, resolverPerfil, marketplaceDe, bloqueSettings } from '../bin/lib/perfil.mjs';
import { detectarForja } from '../bin/lib/forja.mjs';

const noPreguntes = async () => { throw new Error('no debe preguntar'); };

test('perfiles base: github y gitlab sin organización ni app OAuth embebida (token personal)', () => {
  assert.deepEqual(Object.keys(PERFILES), ['github', 'gitlab']);
  assert.equal(PERFILES.github.org, null);
  assert.equal(PERFILES.gitlab.org, null);
  assert.equal(PERFILES.github.host, 'github.com');
  assert.equal(PERFILES.gitlab.host, 'gitlab.com');
  assert.equal(PERFILES.github.client_id, null);
  assert.equal(PERFILES.gitlab.client_id, null);
  assert.deepEqual(PERFILES.gitlab.scopes, ['api']);
});

test('perfilesConocidos: catálogo y cfg sobreescriben por id, en ese orden', () => {
  const lista = perfilesConocidos({ perfiles: [{ id: 'gitlab', org: 'Otro/grupo' }, { id: 'cliente', forja: 'gitlab', host: 'gitlab.cliente.com', org: 'x' }] }, { perfiles: [{ id: 'gitlab', org: 'Del/catalogo' }] });
  assert.equal(lista.find((p) => p.id === 'gitlab').org, 'Otro/grupo');
  assert.equal(lista.find((p) => p.id === 'gitlab').host, 'gitlab.com', 'merge, no reemplazo');
  assert.ok(lista.find((p) => p.id === 'cliente'));
  assert.equal(perfilesConocidos({}, null).length, 2);
});

test('perfilesConocidos: un id que no es de los embebidos es un perfil propio, no un alias', () => {
  const lista = perfilesConocidos({ perfiles: [{ id: 'empresa-gitlab', forja: 'gitlab', host: 'gitlab.empresa.es' }] }, null);
  assert.equal(lista.length, 3);
  assert.equal(lista.find((p) => p.id === 'gitlab').host, 'gitlab.com');
});

test('perfilDeForja: sin organización en el perfil, todo remoto deriva con su propio owner', () => {
  const perfiles = Object.values(PERFILES);
  const gh = perfilDeForja(detectarForja('https://github.com/otra-org/repo.git'), perfiles);
  assert.equal(gh.derivado, true);
  assert.equal(gh.perfil.org, 'otra-org');
  assert.equal(gh.perfil.client_id, PERFILES.github.client_id);
  const gl = perfilDeForja(detectarForja('https://gitlab.com/OtroGrupo/sub/proy.git'), perfiles);
  assert.equal(gl.derivado, true);
  assert.equal(gl.perfil.org, 'OtroGrupo', 'en gitlab la org derivada es el grupo raíz');
});

test('perfilDeForja: exacto solo si el perfil declara organización y el remoto cuelga de ella', () => {
  const perfiles = [...Object.values(PERFILES), { id: 'cliente', forja: 'gitlab', host: 'gitlab.com', org: 'Empresa/equipo' }];
  const r = perfilDeForja(detectarForja('https://gitlab.com/Empresa/equipo/proy.git'), perfiles);
  assert.equal(r.perfil.id, 'cliente');
  assert.equal(r.derivado, false);
});

test('perfilDeForja: un servidor propio sin declarar no deriva perfil', () => {
  assert.equal(perfilDeForja(detectarForja('https://gitlab.cliente.com/grupo/proy.git'), Object.values(PERFILES)), null);
  assert.equal(perfilDeForja({ forja: 'gitlab', host: 'gitlab.cliente.com', selfHosted: true, owner: 'g', path: 'g/p' }, Object.values(PERFILES)), null, 'selfHosted sin declarada no basta');
});

test('perfilDeForja: un GitHub Enterprise declarado deriva con su host, sin app OAuth', () => {
  const r = perfilDeForja(detectarForja('https://git.empresa.com/org/repo.git', [], 'github'), Object.values(PERFILES));
  assert.equal(r.perfil.forja, 'github');
  assert.equal(r.perfil.host, 'git.empresa.com');
  assert.equal(r.perfil.client_id, null);
});

test('perfilDeForja: un GitLab propio declarado deriva con su host, sin app OAuth', () => {
  const r = perfilDeForja(detectarForja('https://gitlab.cliente.com/grupo/proy.git', [], 'gitlab'), Object.values(PERFILES));
  assert.equal(r.derivado, true);
  assert.equal(r.perfil.forja, 'gitlab');
  assert.equal(r.perfil.host, 'gitlab.cliente.com');
  assert.equal(r.perfil.org, 'grupo');
  assert.equal(r.perfil.client_id, null, 'una app OAuth de gitlab.com no sirve en otra instancia: login por token');
});

test('perfilDeForja: nada casa con una forja desconocida o sin remoto', () => {
  assert.equal(perfilDeForja(detectarForja('https://git.x.com/a/b'), Object.values(PERFILES)), null);
  assert.equal(perfilDeForja(null, Object.values(PERFILES)), null);
});

test('resolverPerfil: flag > forja > único > elegir (con el último usado primero)', async () => {
  const p1 = await resolverPerfil({ flag: 'gitlab', cfg: {}, catalogo: null, elegir: noPreguntes });
  assert.equal(p1.id, 'gitlab');
  await assert.rejects(() => resolverPerfil({ flag: 'no-existe', cfg: {}, catalogo: null }), /no-existe/);
  const p2 = await resolverPerfil({ forja: detectarForja('git@github.com:Acme/y.git'), cfg: {}, catalogo: null, elegir: noPreguntes });
  assert.equal(p2.forja, 'github');
  assert.equal(p2.org, 'Acme');
  let preguntado = null;
  const p3 = await resolverPerfil({ cfg: {}, catalogo: null, elegir: async (ops) => { preguntado = Object.keys(ops); return 'gitlab'; } });
  assert.deepEqual(preguntado, ['github', 'gitlab']);
  assert.equal(p3.id, 'gitlab');
  preguntado = null;
  await resolverPerfil({ cfg: { perfil_ultimo: 'gitlab' }, catalogo: null, elegir: async (ops) => { preguntado = Object.keys(ops); return 'github'; } });
  assert.deepEqual(preguntado, ['gitlab', 'github'], 'el último usado va primero');
  const unico = await resolverPerfil({ cfg: {}, catalogo: null, soloForja: 'gitlab', elegir: noPreguntes });
  assert.equal(unico.id, 'gitlab', 'soloForja deja un único candidato');
});

test('resolverPerfil: las opciones no enseñan una organización vacía', async () => {
  let explica = null;
  await resolverPerfil({ cfg: {}, catalogo: null, elegir: async (ops) => { explica = ops.github.explica; return 'github'; } });
  assert.ok(!/null|undefined/.test(explica), explica);
});

test('resolverPerfil: perfil_ultimo ordena las opciones', async () => {
  let preguntado = null;
  await resolverPerfil({ cfg: { perfil_ultimo: 'gitlab' }, catalogo: null, elegir: async (ops) => { preguntado = Object.keys(ops); return 'gitlab'; } });
  assert.deepEqual(preguntado, ['gitlab', 'github']);
});

test('bloqueSettings: las dos forjas declaran el mismo repo público de GitHub', () => {
  for (const perfil of [PERFILES.github, PERFILES.gitlab]) {
    const b = bloqueSettings(perfil, '');
    assert.deepEqual(b.extraKnownMarketplaces['faro-marketplace'], { source: { source: 'github', repo: 'nuvaweb/faro-harness' }, autoUpdate: true });
    assert.equal(b.enabledPlugins['faro@faro-marketplace'], true);
    assert.equal(b.enabledPlugins['superpowers@claude-plugins-official'], true);
    assert.ok(b.extraKnownMarketplaces['claude-plugins-official']);
  }
});

test('marketplaceDe: el override sustituye la URL pública, también con source git', () => {
  assert.equal(marketplaceDe(PERFILES.gitlab, '').url, ORIGEN_PLUGIN);
  const ov = marketplaceDe(PERFILES.gitlab, 'https://gitlab.cliente.com/espejo/plugin.git');
  assert.deepEqual(ov.source, { source: 'git', url: 'https://gitlab.cliente.com/espejo/plugin.git' });
  assert.equal(ov.url, 'https://gitlab.cliente.com/espejo/plugin.git');
});
