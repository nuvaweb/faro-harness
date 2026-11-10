import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { parseListaPluginsTodas, refrescosProject, settingsPluginOk, escribirSettingsPlugin, PLANTILLAS_MARCA, FARO_AGENT_FILES, migrarCopiaLegada, fuenteMarketplaceUser, necesitaShellWin, limpiarCacheAntigua, asegurarCredencialesPlugins } from '../bin/lib/plugin.mjs';
import { diagnosticarEstructura, FARO_ROOTS } from '../bin/lib/repo.mjs';
import { PERFILES, ORIGEN_PLUGIN } from '../bin/lib/perfil.mjs';

const salida = `
  ❯ faro@faro-marketplace
    Version: 0.8.5
    Scope: project
    Status: ✔ enabled

  ❯ faro@faro-marketplace
    Version: 0.14.0
    Scope: user
    Status: ✔ enabled

  ❯ faro@faro-marketplace
    Version: 0.9.7
    Scope: project
    Status: ✔ enabled

  ❯ superpowers@claude-plugins-official
    Version: 6.3.0
    Scope: user
    Status: ✔ enabled
`;

test('parseListaPluginsTodas conserva todas las entradas; refrescosProject devuelve las project < user', () => {
  const todas = parseListaPluginsTodas(salida);
  assert.equal(todas.get('faro@faro-marketplace').length, 3);
  assert.deepEqual(refrescosProject(todas, 'faro@faro-marketplace').map((e) => e.version).sort(), ['0.8.5', '0.9.7']);
  assert.deepEqual(refrescosProject(todas, 'superpowers@claude-plugins-official'), []);
  assert.deepEqual(refrescosProject(todas, 'no-existe'), []);
});

test('settingsPluginOk acepta source git, github y url (repos ya creados); exige autoUpdate y superpowers', () => {
  const base = { enabledPlugins: { 'faro@faro-marketplace': true, 'superpowers@claude-plugins-official': true }, extraKnownMarketplaces: { 'claude-plugins-official': { source: { source: 'github', repo: 'anthropics/claude-plugins-official' } } } };
  assert.equal(settingsPluginOk({ ...base, extraKnownMarketplaces: { ...base.extraKnownMarketplaces, 'faro-marketplace': { source: { source: 'git', url: ORIGEN_PLUGIN }, autoUpdate: true } } }), true);
  assert.equal(settingsPluginOk({ ...base, extraKnownMarketplaces: { ...base.extraKnownMarketplaces, 'faro-marketplace': { source: { source: 'url', url: 'https://gitlab.com/x/y.git' }, autoUpdate: true } } }), true);
  assert.equal(settingsPluginOk({ ...base, extraKnownMarketplaces: { ...base.extraKnownMarketplaces, 'faro-marketplace': { source: { source: 'github', repo: 'Acme/faro-espejo' }, autoUpdate: true } } }), true);
  assert.equal(settingsPluginOk({ ...base, extraKnownMarketplaces: { ...base.extraKnownMarketplaces, 'faro-marketplace': { source: { source: 'github', repo: 'Acme/faro-espejo' } } } }), false, 'sin autoUpdate');
  assert.equal(settingsPluginOk(null), false);
});

test('escribirSettingsPlugin declara el repo público de GitHub en las dos forjas, sustituye una fuente previa y es idempotente', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-set-'));
  const fuente = () => JSON.parse(fs.readFileSync(path.join(d, '.claude', 'settings.json'), 'utf8')).extraKnownMarketplaces['faro-marketplace'].source;
  fs.mkdirSync(path.join(d, '.claude'));
  fs.writeFileSync(path.join(d, '.claude', 'settings.json'), JSON.stringify({ extraKnownMarketplaces: { 'faro-marketplace': { source: { source: 'github', repo: 'viejo/repo' }, autoUpdate: true } } }));
  assert.equal(escribirSettingsPlugin(d, PERFILES.github), true);
  assert.deepEqual(fuente(), { source: 'github', repo: 'nuvaweb/faro-harness' });
  assert.equal(escribirSettingsPlugin(d, PERFILES.gitlab), false, 'la fuente no depende de la forja');
  assert.deepEqual(fuente(), { source: 'github', repo: 'nuvaweb/faro-harness' });
  assert.equal(escribirSettingsPlugin(d, PERFILES.gitlab, { override: 'https://gitlab.cliente.com/espejo.git' }), true);
  assert.deepEqual(fuente(), { source: 'git', url: 'https://gitlab.cliente.com/espejo.git' });
});

test('listas legadas completas y migracion retira .claude/hooks/lib', () => {
  assert.ok(PLANTILLAS_MARCA.includes('render-doc.mjs'));
  assert.ok(FARO_AGENT_FILES.includes('gestor-requisitos.md'));
  assert.ok(FARO_AGENT_FILES.includes('gestor-forja.md'), 'renombrado en el plugin 0.18 (antes gestor-github)');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-mig-'));
  fs.mkdirSync(path.join(d, '.claude', 'hooks', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(d, '.claude', 'hooks', 'harness.js'), '');
  fs.writeFileSync(path.join(d, '.claude', 'hooks', 'lib', 'forge.js'), '');
  assert.equal(migrarCopiaLegada(d), true);
  assert.equal(fs.existsSync(path.join(d, '.claude', 'hooks')), false);
});

test('el MCP lo provee el plugin: .mcp.json ya no es requisito ni raiz FARO', () => {
  assert.ok(!FARO_ROOTS.includes('.mcp.json'));
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-mcp-'));
  fs.mkdirSync(path.join(d, '.git'));
  const mcp = diagnosticarEstructura(d).find((c) => c.id === 'mcp');
  assert.equal(mcp.estado, 'ok');
});

test('fuenteMarketplaceUser: override > origen público, sin mirar sesiones ni forja', () => {
  assert.deepEqual(fuenteMarketplaceUser(PERFILES.github, 'https://gitlab.cliente.com/e.git'), { fuente: 'https://gitlab.cliente.com/e.git', url: 'https://gitlab.cliente.com/e.git', origen: 'override' });
  for (const pf of [PERFILES.github, PERFILES.gitlab]) assert.deepEqual(fuenteMarketplaceUser(pf), { fuente: ORIGEN_PLUGIN, url: ORIGEN_PLUGIN, origen: 'publico' });
});

test('migrarCopiaLegada: el bloque de CLAUDE.md cita el origen del marketplace', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-cm-'));
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), '# x\n');
  fs.mkdirSync(path.join(d, '.claude', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(d, '.claude', 'hooks', 'harness.js'), '');
  migrarCopiaLegada(d, { perfil: PERFILES.gitlab, override: 'https://espejo.es/p.git' });
  assert.match(fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8'), /marketplace add https:\/\/espejo\.es\/p\.git/);
});

test('asegurarCredencialesPlugins: marketplace legible, nada más que hacer', async () => {
  assert.equal((await asegurarCredencialesPlugins({ perfil: PERFILES.gitlab, leer: () => true })).estado, 'ok');
});

test('asegurarCredencialesPlugins: si no se lee, avisa sin tocar credenciales de git ni preguntar a la forja', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-cred-'));
  const gitGlobal = path.join(dir, 'gitconfig'); fs.writeFileSync(gitGlobal, '');
  const previoGit = process.env.GIT_CONFIG_GLOBAL; const previoFetch = globalThis.fetch;
  process.env.GIT_CONFIG_GLOBAL = gitGlobal;
  let llamadasApi = 0;
  globalThis.fetch = async () => { llamadasApi++; return new Response('{}', { status: 404 }); };
  try {
    const r = await asegurarCredencialesPlugins({ perfil: PERFILES.gitlab, leer: () => false });
    assert.equal(r.estado, 'sin-acceso');
    assert.equal(fs.readFileSync(gitGlobal, 'utf8'), '', 'el plugin es público: sin helpers que cablear');
    assert.equal(llamadasApi, 0, 'sin consulta de membresía');
  } finally {
    globalThis.fetch = previoFetch;
    if (previoGit === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previoGit;
  }
});

test('necesitaShellWin: SOLO en Windows y SOLO para .cmd/.bat (donde Node exige shell:true para poder lanzarlos)', () => {
  const winOriginal = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    assert.equal(necesitaShellWin('claude.cmd'), true);
    assert.equal(necesitaShellWin('claude.bat'), true);
    assert.equal(necesitaShellWin('claude.exe'), false, '.exe SI lo lanza CreateProcess sin shell');
    assert.equal(necesitaShellWin('claude'), false, 'bare: en Windows tampoco lo arregla shell:true (sin shebang)');
    assert.equal(necesitaShellWin('C:/Users/x/.local/bin/claude.CMD'), true, 'insensible a mayusculas');
  } finally { Object.defineProperty(process, 'platform', { value: winOriginal }); }
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try { assert.equal(necesitaShellWin('claude.cmd'), false, 'fuera de Windows nunca hace falta'); }
  finally { Object.defineProperty(process, 'platform', { value: winOriginal }); }
});

test('limpiarCacheAntigua: borra SOLO versiones sin referencia en installed_plugins.json, en ningun scope', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-cache-'));
  const claudeDir = path.join(d, '.claude', 'plugins');
  fs.mkdirSync(path.join(claudeDir, 'cache', 'faro-marketplace', 'faro', '0.8.5'), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'cache', 'faro-marketplace', 'faro', '0.14.0'), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'cache', 'faro-marketplace', 'faro', '0.21.0'), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'cache', 'claude-plugins-official', 'superpowers', '6.2.0'), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'cache', 'claude-plugins-official', 'superpowers', '6.3.0'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'installed_plugins.json'), JSON.stringify({
    version: 1,
    plugins: {
      'faro@faro-marketplace': [{ scope: 'user', version: '0.21.0' }],
      'superpowers@claude-plugins-official': [
        { scope: 'user', version: '6.3.0' },
        { scope: 'project', version: '6.2.0', path: 'C:/otro/repo' },   // un repo AJENO a proposito en 6.2.0: NO se borra
      ],
    },
  }));
  const r = limpiarCacheAntigua({ homeDir: d });
  assert.equal(r.estado, 'ok');
  assert.deepEqual(r.borrados.map((b) => `${b.plugin} ${b.version}`).sort(), ['faro 0.14.0', 'faro 0.8.5']);
  assert.ok(!fs.existsSync(path.join(claudeDir, 'cache', 'faro-marketplace', 'faro', '0.8.5')));
  assert.ok(!fs.existsSync(path.join(claudeDir, 'cache', 'faro-marketplace', 'faro', '0.14.0')));
  assert.ok(fs.existsSync(path.join(claudeDir, 'cache', 'faro-marketplace', 'faro', '0.21.0')), 'la version activa NUNCA se toca');
  assert.ok(fs.existsSync(path.join(claudeDir, 'cache', 'claude-plugins-official', 'superpowers', '6.2.0')), 'referenciada por otro repo: se respeta');
  assert.ok(fs.existsSync(path.join(claudeDir, 'cache', 'claude-plugins-official', 'superpowers', '6.3.0')));
});

test('limpiarCacheAntigua: sin registro legible no toca nada; sin carpeta de cache no falla', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-cache-vacio-'));
  assert.deepEqual(limpiarCacheAntigua({ homeDir: d }), { estado: 'sin-registro', borrados: [] });
  fs.mkdirSync(path.join(d, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(d, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: {} }));
  const r = limpiarCacheAntigua({ homeDir: d });
  assert.equal(r.estado, 'ok'); assert.deepEqual(r.borrados, []);
});

test('limpiarCacheAntigua: aplicar:false solo REPORTA, no borra (modo dry)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-cache-dry-'));
  const dir = path.join(d, '.claude', 'plugins', 'cache', 'faro-marketplace', 'faro', '0.8.5');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(d, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(d, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: {} }));
  const r = limpiarCacheAntigua({ homeDir: d, aplicar: false });
  assert.equal(r.borrados.length, 1);
  assert.ok(fs.existsSync(dir), 'aplicar:false no borra de verdad');
});
