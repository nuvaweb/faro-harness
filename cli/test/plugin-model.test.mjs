// Tests del MODELO PLUGIN en el CLI: distribución del plugin en settings del repo
// (escribirSettingsPlugin) y migración de la copia legada del harness (migrarCopiaLegada).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { escribirSettingsPlugin, migrarCopiaLegada, FARO_ROOTS, leerMetaRepo, escribirMetaRepo } from '../bin/lib/repo.mjs';

const leer = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));

test('escribirSettingsPlugin: crea el bloque completo en un repo sin settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-set-'));
  const cambio = escribirSettingsPlugin(dir);
  assert.equal(cambio, true);
  const s = leer(dir);
  assert.equal(s.enabledPlugins['faro@faro-marketplace'], true);
  const mk = s.extraKnownMarketplaces['faro-marketplace'];
  assert.equal(mk.autoUpdate, true);
  assert.deepEqual(mk.source, { source: 'github', repo: 'nuvaweb/faro-harness' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('escribirSettingsPlugin: MERGE conserva claves existentes (permissions) y es idempotente', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-set2-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }, null, 2) + '\n');
  assert.equal(escribirSettingsPlugin(dir), true);
  const s = leer(dir);
  assert.deepEqual(s.permissions, { allow: ['Bash(npm test)'] });   // conservado
  assert.equal(s.enabledPlugins['faro@faro-marketplace'], true);
  assert.equal(escribirSettingsPlugin(dir), false);                 // 2ª pasada: sin cambios
  fs.rmSync(dir, { recursive: true, force: true });
});

// superpowers se declara desde el marketplace OFICIAL (decision 2026-08-03): el ID
// 'superpowers@claude-plugins-official' solo resuelve si ESE marketplace esta declarado — si no,
// el clon da "enabled in project settings but isn't installed here".
test('escribirSettingsPlugin: declara superpowers CON su marketplace oficial', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-sp-'));
  escribirSettingsPlugin(dir);
  const s = leer(dir);
  assert.equal(s.enabledPlugins['superpowers@claude-plugins-official'], true);
  assert.equal(s.extraKnownMarketplaces['claude-plugins-official'].source.repo, 'anthropics/claude-plugins-official');
  // invariante: TODO plugin habilitado tiene su marketplace resoluble (ninguno huerfano)
  const mks = new Set(Object.keys(s.extraKnownMarketplaces));
  for (const k of Object.keys(s.enabledPlugins)) assert.ok(mks.has(k.split('@')[1]), `huérfano: ${k}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('escribirSettingsPlugin: respeta plugins ajenos ya habilitados (no los borra)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-sp2-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'),
    JSON.stringify({ enabledPlugins: { 'cloudflare@claude-plugins-official': true } }, null, 2) + '\n');
  escribirSettingsPlugin(dir);
  const s = leer(dir);
  assert.equal(s.enabledPlugins['cloudflare@claude-plugins-official'], true);   // conservado
  assert.ok(s.extraKnownMarketplaces['claude-plugins-official']);               // y ahora SI resoluble
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migrarCopiaLegada: retira SOLO lo FARO, descablea hooks y conserva permisos y hooks propios', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-mig-'));
  const hooks = path.join(dir, '.claude', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude', 'commands', 'faro'), { recursive: true });
  for (const f of ['harness.js', 'github.js', 'specs.js']) fs.writeFileSync(path.join(hooks, f), '// faro');
  fs.writeFileSync(path.join(hooks, 'mi-hook-propio.js'), '// del usuario');
  fs.writeFileSync(path.join(dir, '.claude', 'commands', 'faro', 'pr.md'), 'x');
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({
    permissions: { allow: ['Bash(ls)'] },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node .claude/hooks/harness.js session' }] }] },
  }, null, 2) + '\n');
  assert.equal(migrarCopiaLegada(dir), true);
  assert.ok(!fs.existsSync(path.join(hooks, 'harness.js')));                        // FARO fuera
  assert.ok(fs.existsSync(path.join(hooks, 'mi-hook-propio.js')));                  // lo ajeno se respeta
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'commands', 'faro')));         // comandos legados fuera
  const s = leer(dir);
  assert.deepEqual(s.permissions, { allow: ['Bash(ls)'] });                         // permisos conservados
  assert.equal(s.hooks, undefined);                                                 // cableado retirado
  assert.equal(migrarCopiaLegada(dir), false);                                      // idempotente
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migrarCopiaLegada: migracion A MEDIAS (hooks ya fuera, agentes dentro) → limpia agentes y motor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-mig3-'));
  fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true });
  for (const f of ['adoptador-faro.md', 'gestor-directus.md', 'auditor-iniciativa.md']) fs.writeFileSync(path.join(dir, '.claude', 'agents', f), '# faro');
  fs.writeFileSync(path.join(dir, '.claude', 'agents', 'mi-agente-propio.md'), '# del usuario');
  fs.writeFileSync(path.join(dir, '.claude', 'harness-manifest.json'), '{}');
  fs.writeFileSync(path.join(dir, '.claude', 'modelo-faro.md'), '# motor');
  assert.equal(migrarCopiaLegada(dir), true);
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'agents', 'adoptador-faro.md')));
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'agents', 'gestor-directus.md')));
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'agents', 'mi-agente-propio.md')));   // lo ajeno queda
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'harness-manifest.json')));
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'modelo-faro.md')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migrarCopiaLegada: borra la copia semilla .claude/faro-schema.json (el contrato vive SOLO en el plugin)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-mig4-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'faro-schema.json'), '{"version":"2.0"}');
  assert.equal(migrarCopiaLegada(dir), true);
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'faro-schema.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migrarCopiaLegada: sin copia legada no hace nada (repo plugin-nativo)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-mig2-'));
  assert.equal(migrarCopiaLegada(dir), false);
  assert.ok(!fs.existsSync(path.join(dir, '.claude')));   // no crea nada por el camino
  fs.rmSync(dir, { recursive: true, force: true });
});

test('metadato (#293): en un repo nuevo escribirMetaRepo y leerMetaRepo usan faro/config.json; sin él no hay metadato', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-meta-'));
  assert.equal(leerMetaRepo(dir), null);
  escribirMetaRepo(dir, { domain: 'sistemas', teams: ['ia'] });
  assert.ok(fs.existsSync(path.join(dir, 'faro', 'config.json')));
  assert.ok(!fs.existsSync(path.join(dir, '.faro.json')));
  assert.equal(leerMetaRepo(dir).domain, 'sistemas');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('metadato (#293): un repo sin migrar sigue leyendo y escribiendo su .faro.json (lectura dual), sin crear faro/', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-meta-leg-'));
  fs.writeFileSync(path.join(dir, '.faro.json'), JSON.stringify({ domain: 'viejo' }));
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), '# x\n');
  assert.equal(leerMetaRepo(dir).domain, 'viejo');
  escribirMetaRepo(dir, { domain: 'nuevo' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.faro.json'), 'utf8')).domain, 'nuevo');
  assert.ok(!fs.existsSync(path.join(dir, 'faro')), 'no debe abrir faro/ a medias en un repo legado');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('FARO_ROOTS: taxonomía vigente (espejo de paths.js del harness), sin nombres legados', () => {
  for (const r of ['documentos', 'gestion', 'fuentes', 'flujos', 'borrador']) assert.ok(FARO_ROOTS.includes(`faro/${r}`), `falta faro/${r}`);
  for (const viejo of ['superpowers', 'specdriven', 'resources', 'flow', 'playground']) assert.ok(!FARO_ROOTS.includes(viejo), `taxonomía vieja: ${viejo}`);
});
