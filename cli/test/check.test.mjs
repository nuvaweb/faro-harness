import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diagnosticarEstructura, diagnosticarRamasLocal } from '../bin/lib/repo.mjs';

function get(list, id) { return list.find((c) => c.id === id); }

test('diagnosticarEstructura: carpeta vacía → git error y capa FARO en aviso', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-est-'));
  const r = diagnosticarEstructura(dir);
  assert.equal(get(r, 'git').estado, 'error');
  assert.equal(get(r, 'faro-roots').estado, 'aviso');
  // Modelo PLUGIN: '.claude' ya NO se exige (el motor vive en el plugin); la taxonomia vigente si.
  assert.ok(!get(r, 'faro-roots').faltan.includes('.claude'));
  // #293: un repo sin nada de FARO nace con el layout nuevo → las areas se esperan bajo faro/.
  assert.ok(get(r, 'faro-roots').faltan.includes('faro/documentos'));
  assert.ok(get(r, 'faro-roots').faltan.includes('faro/gestion'));
  assert.ok(!get(r, 'faro-roots').faltan.includes('gestion'));
  // Sin copia local de comandos → ok (los provee el plugin como /faro:*).
  assert.equal(get(r, 'comandos').estado, 'ok');
  assert.equal(get(r, 'mcp').estado, 'ok');   // el MCP lo provee el plugin
  assert.equal(get(r, 'clasificacion').estado, 'aviso');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('diagnosticarEstructura (#293): FARO en la raíz → aviso de layout con el comando de migración; bajo faro/ → ok', () => {
  const viejo = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-lay-'));
  fs.mkdirSync(path.join(viejo, 'gestion'));
  const r = diagnosticarEstructura(viejo);
  assert.equal(get(r, 'layout').estado, 'aviso');
  assert.match(get(r, 'layout').detalle, /migrar-layout/);
  assert.ok(get(r, 'faro-roots').faltan.includes('documentos'), 'en un repo legado se esperan las áreas en la raíz, sin abrir faro/ a medias');
  const nuevo = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-lay2-'));
  fs.mkdirSync(path.join(nuevo, 'faro', 'gestion'), { recursive: true });
  assert.equal(get(diagnosticarEstructura(nuevo), 'layout').estado, 'ok');
  for (const d of [viejo, nuevo]) fs.rmSync(d, { recursive: true, force: true });
});

test('diagnosticarEstructura: copia legada de comandos → aviso de migracion', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-est3-'));
  fs.mkdirSync(path.join(dir, '.claude', 'commands', 'faro'), { recursive: true });
  const r = diagnosticarEstructura(dir);
  assert.equal(get(r, 'comandos').estado, 'aviso');
  assert.match(get(r, 'comandos').detalle, /legada/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('diagnosticarEstructura: con .git, .mcp.json(propio) y clasificación válida → ok', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-est2-'));
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { propio: { type: 'http', url: 'x' } } }));
  fs.writeFileSync(path.join(dir, '.faro.json'), JSON.stringify({ domain: 'producto' }));
  const r = diagnosticarEstructura(dir);
  assert.equal(get(r, 'git').estado, 'ok');
  assert.equal(get(r, 'mcp').estado, 'ok');
  assert.equal(get(r, 'clasificacion').estado, 'ok');
  fs.rmSync(dir, { recursive: true, force: true });
});

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-chk-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1'); g('add', '-A'); g('commit', '-m', 'c1');
  const gitLocal = (a) => { try { return execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  return { dir, g, gitLocal };
}

test('diagnosticarRamasLocal: sin develop, en main → tieneDevelop=false y enPrincipal=true', () => {
  const { dir, gitLocal } = tmpRepo();
  const d = diagnosticarRamasLocal(gitLocal);
  assert.equal(d.tieneDevelop, false);
  assert.equal(d.enPrincipal, true);
  assert.equal(d.developSupersetMain, true);   // no hay develop → invariante trivialmente true
  fs.rmSync(dir, { recursive: true, force: true });
});

test('diagnosticarRamasLocal: develop por detrás de main → developSupersetMain=false', () => {
  const { dir, g, gitLocal } = tmpRepo();
  g('branch', 'develop');                       // develop == main (en el commit c1)
  fs.writeFileSync(path.join(dir, 'b.txt'), '2'); g('add', '-A'); g('commit', '-m', 'c2');  // main avanza
  const d = diagnosticarRamasLocal(gitLocal);
  assert.equal(d.tieneDevelop, true);
  assert.equal(d.developSupersetMain, false);   // main tiene c2 que develop no tiene
  fs.rmSync(dir, { recursive: true, force: true });
});
