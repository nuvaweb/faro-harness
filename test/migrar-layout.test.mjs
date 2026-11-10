// #293 — `harness.js migrar-layout`: pasa un repo del layout antiguo (FARO en la raiz) a faro/.
// Mueve con git (el historial sigue a cada fichero), quita .metrics/, reescribe las referencias que se
// romperian (enlaces markdown, rutas citadas en CLAUDE.md/README, .gitignore, permisos de settings) y
// nunca deja una migracion a medias: si algo choca, no mueve nada.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const mig = require(path.join(HOOKS, 'lib', 'migrar-layout.js'));
const paths = require(path.join(HOOKS, 'lib', 'paths.js'));

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const leer = (d, rel) => fs.readFileSync(path.join(d, rel), 'utf8');
const hay = (d, rel) => fs.existsSync(path.join(d, rel));

function repo(ficheros, { commit = true } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-miglay-'));
  git(d, 'init', '-q');
  git(d, 'config', 'user.email', 't@t');
  git(d, 'config', 'user.name', 't');
  git(d, 'config', 'core.autocrlf', 'false');
  for (const [rel, txt] of Object.entries(ficheros)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), txt);
  }
  if (commit) { git(d, 'add', '-A'); git(d, 'commit', '-qm', 'base'); }
  return d;
}

const LEGADO = {
  'ESTADO.md': '# Estado\nVer [riesgos](gestion/risks.md), [guia](CLAUDE.md) y [codigo](src/index.js).\n',
  '.faro.json': '{"tipo":"proyecto"}\n',
  'gestion/risks.md': '# RAID\nVuelve al [estado](../ESTADO.md); ADR en [aqui](decisions/x.md).\n',
  'gestion/decisions/x.md': '# ADR\n',
  'documentos/README.md': '# Docs\nLa [config](../.faro.json) y el [README](../README.md).\n',
  'borrador/tmp/.gitkeep': '',
  '.metrics/eventos.jsonl': '{}\n',
  'CLAUDE.md': '# Guia\nEl RAID vive en `gestion/risks.md` y el estado en `ESTADO.md`; config en `.faro.json`.\nEnlace [riesgos](gestion/risks.md) y [web](https://x.test/gestion/a). Codigo en `src/` y `scripts/x.js`.\n',
  'README.md': '# Producto\nVer [estado](./ESTADO.md#fase-1).\n',
  '.gitignore': 'node_modules/\nborrador/*\n!borrador/tmp/.gitkeep\n.metrics/\n',
  '.claude/settings.json': JSON.stringify({ permissions: { allow: ['Write(gestion/**)', 'Edit(ESTADO.md)', 'Bash(git status*)'] } }, null, 2) + '\n',
  'src/index.js': 'module.exports = 1;\n',
};

test('plan: en un repo legado enumera lo que mueve y no toca nada', () => {
  const d = repo(LEGADO);
  const p = mig.plan(d);
  assert.strictEqual(p.motivo, null);
  const de = p.mover.map((m) => m.de);
  for (const x of ['gestion', 'documentos', 'borrador', 'ESTADO.md', '.faro.json']) assert.ok(de.includes(x), x);
  assert.ok(p.mover.find((m) => m.de === '.faro.json').a === 'faro/config.json');
  assert.deepStrictEqual(p.quitar, ['.metrics']);
  assert.ok(p.reescribir.includes('CLAUDE.md') && p.reescribir.includes('.gitignore') && p.reescribir.includes('.claude/settings.json'));
  assert.ok(hay(d, 'gestion/risks.md') && !hay(d, 'faro'), 'el plan no mueve nada');
});

test('aplicar: mueve con git, quita .metrics/ y deja el repo en layout faro', () => {
  const d = repo(LEGADO);
  const r = mig.aplicar(d);
  assert.strictEqual(r.ok, true, r.motivo);
  assert.strictEqual(paths.detectarLayout(d), 'faro');
  for (const x of ['faro/ESTADO.md', 'faro/config.json', 'faro/gestion/risks.md', 'faro/gestion/decisions/x.md', 'faro/documentos/README.md']) assert.ok(hay(d, x), x);
  for (const x of ['ESTADO.md', '.faro.json', 'gestion', 'documentos', 'borrador', '.metrics']) assert.ok(!hay(d, x), `${x} sigue en la raiz`);
  assert.ok(hay(d, 'src/index.js') && hay(d, 'CLAUDE.md') && hay(d, 'README.md'), 'lo del producto no se mueve');
  const st = git(d, 'status', '--porcelain');
  assert.match(st, /^R {2}gestion\/risks\.md -> faro\/gestion\/risks\.md$/m, 'git mv: el historial sigue al fichero');
  assert.match(st, /^R {2}\.faro\.json -> faro\/config\.json$/m);
});

test('aplicar: los enlaces relativos siguen apuntando a lo mismo', () => {
  const d = repo(LEGADO);
  mig.aplicar(d);
  const estado = leer(d, 'faro/ESTADO.md');
  assert.match(estado, /\[riesgos\]\(gestion\/risks\.md\)/, 'enlace entre movidos: no cambia');
  assert.match(estado, /\[guia\]\(\.\.\/CLAUDE\.md\)/);
  assert.match(estado, /\[codigo\]\(\.\.\/src\/index\.js\)/);
  assert.match(leer(d, 'faro/gestion/risks.md'), /\[estado\]\(\.\.\/ESTADO\.md\)/);
  const docs = leer(d, 'faro/documentos/README.md');
  assert.match(docs, /\[config\]\(\.\.\/config\.json\)/);
  assert.match(docs, /\[README\]\(\.\.\/\.\.\/README\.md\)/);
  assert.match(leer(d, 'README.md'), /\[estado\]\(faro\/ESTADO\.md#fase-1\)/);
});

test('aplicar: reescribe rutas citadas, .gitignore y permisos; no toca URLs ni lo del producto', () => {
  const d = repo(LEGADO);
  mig.aplicar(d);
  const claude = leer(d, 'CLAUDE.md');
  assert.match(claude, /`faro\/gestion\/risks\.md`/);
  assert.match(claude, /`faro\/ESTADO\.md`/);
  assert.match(claude, /`faro\/config\.json`/);
  assert.match(claude, /\[riesgos\]\(faro\/gestion\/risks\.md\)/);
  assert.match(claude, /https:\/\/x\.test\/gestion\/a/, 'una URL no se toca');
  assert.match(claude, /`src\/` y `scripts\/x\.js`/);
  const gi = leer(d, '.gitignore');
  assert.match(gi, /^faro\/borrador\/\*$/m);
  assert.match(gi, /^!faro\/borrador\/tmp\/\.gitkeep$/m);
  assert.match(gi, /^node_modules\/$/m);
  assert.doesNotMatch(gi, /^\.metrics\/$/m, '.metrics/ ya no existe');
  const allow = JSON.parse(leer(d, '.claude/settings.json')).permissions.allow;
  assert.ok(allow.includes('Write(faro/gestion/**)') && allow.includes('Edit(faro/ESTADO.md)') && allow.includes('Bash(git status*)'), allow.join(' '));
});

test('el historial (cambios archivados, ADR, CHANGELOG) conserva sus citas; sus enlaces si se recalculan', () => {
  const d = repo({
    'ESTADO.md': '# x\n',
    'CHANGELOG.md': '## 1.0\n- movido `gestion/risks.md`\n',
    'gestion/decisions/2026-01-01-x.md': 'Se decidio usar `gestion/risks.md`.\n',
    'gestion/cambios/changes/archive/viejo/proposal.md': 'Tocaba `gestion/risks.md`. Ver [claude](../../../../../CLAUDE.md).\n',
    'CLAUDE.md': '# g\n',
  });
  assert.strictEqual(mig.aplicar(d).ok, true);
  const t = leer(d, 'faro/gestion/cambios/changes/archive/viejo/proposal.md');
  assert.match(t, /`gestion\/risks\.md`/, 'la cita historica no se reescribe');
  assert.match(t, /\[claude\]\(\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/CLAUDE\.md\)/);
  assert.match(leer(d, 'CHANGELOG.md'), /`gestion\/risks\.md`/);
  assert.match(leer(d, 'faro/gestion/decisions/2026-01-01-x.md'), /`gestion\/risks\.md`/);
});

test('si algo choca, no mueve nada (nunca una migracion a medias)', () => {
  const d = repo({ ...LEGADO, 'faro/documentos/otra.md': 'ajeno\n' });
  assert.strictEqual(paths.detectarLayout(d), 'legado', 'una faro/ sin marcas no cambia el layout');
  const r = mig.aplicar(d);
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /faro\/documentos/);
  assert.ok(hay(d, 'gestion/risks.md') && hay(d, 'ESTADO.md') && !hay(d, 'faro/gestion'));
});

test('con cambios sin guardar no migra: la migracion va en su propio commit', () => {
  const d = repo(LEGADO);
  fs.appendFileSync(path.join(d, 'gestion/risks.md'), 'cambio a medias\n');
  const r = mig.aplicar(d);
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /sin guardar/);
  assert.ok(hay(d, 'gestion/risks.md'));
});

test('un repo ya migrado, o sin nada de FARO, no tiene nada que migrar', () => {
  const nuevo = repo({ 'faro/ESTADO.md': '# x\n', 'src/a.js': '' });
  assert.match(mig.plan(nuevo).motivo, /ya/);
  const vacio = repo({ 'src/a.js': '' });
  assert.match(mig.plan(vacio).motivo, /nada/);
});

test('INICIATIVA.md: se migra como ESTADO.md; si conviven los dos, el legado se queda y se avisa', () => {
  const solo = repo({ 'INICIATIVA.md': '# x\n', 'gestion/risks.md': '' });
  assert.strictEqual(mig.aplicar(solo).ok, true);
  assert.ok(hay(solo, 'faro/ESTADO.md') && !hay(solo, 'INICIATIVA.md'));
  const dos = repo({ 'INICIATIVA.md': '# viejo\n', 'ESTADO.md': '# nuevo\n' });
  const r = mig.aplicar(dos);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(leer(dos, 'faro/ESTADO.md'), '# nuevo\n');
  assert.ok(hay(dos, 'INICIATIVA.md'));
  assert.ok(r.avisos.some((a) => /INICIATIVA\.md/.test(a)));
});

test('cli --dry-run: imprime el plan y no toca el repo', () => {
  const d = repo(LEGADO);
  const lineas = [];
  const code = mig.cli(['--dry-run'], { root: d, out: (t) => lineas.push(t) });
  assert.strictEqual(code, 0);
  const txt = lineas.join('\n');
  assert.match(txt, /gestion\s+→\s+faro\/gestion/);
  assert.match(txt, /\.metrics/);
  assert.ok(hay(d, 'gestion/risks.md'));
});

test('enlaces simbolicos: no se siguen al buscar markdown ni se reescribe a traves de ellos', (t) => {
  const fuera = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-fuera-'));
  fs.writeFileSync(path.join(fuera, 'ajeno.md'), 'Cita `gestion/risks.md` fuera del repo.\n');
  fs.writeFileSync(path.join(fuera, 'gi'), 'gestion/x\n');
  const d = repo(LEGADO, { commit: false });
  try {
    fs.symlinkSync(fuera, path.join(d, 'documentos', 'enlace'), 'junction');
    fs.rmSync(path.join(d, '.gitignore'));
    fs.symlinkSync(path.join(fuera, 'gi'), path.join(d, '.gitignore'), 'file');
  } catch { t.skip('el sistema no permite crear enlaces simbolicos'); return; }
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'base');
  const p = mig.plan(d);
  assert.ok(!p.reescribir.some((r) => /enlace|\.gitignore/.test(r)), `sigue el enlace: ${p.reescribir.join(', ')}`);
  mig.aplicar(d);
  assert.strictEqual(fs.readFileSync(path.join(fuera, 'ajeno.md'), 'utf8'), 'Cita `gestion/risks.md` fuera del repo.\n');
  assert.strictEqual(fs.readFileSync(path.join(fuera, 'gi'), 'utf8'), 'gestion/x\n');
});

test('enlace en un segmento intermedio (.claude/ enlazado): settings.json no se reescribe fuera del repo', (t) => {
  const fuera = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-fuera-claude-'));
  const settings = JSON.stringify({ permissions: { allow: ['Write(gestion/**)'] } }, null, 2) + '\n';
  fs.writeFileSync(path.join(fuera, 'settings.json'), settings);
  const { '.claude/settings.json': _omit, ...sinClaude } = LEGADO;
  const d = repo(sinClaude, { commit: false });
  try { fs.symlinkSync(fuera, path.join(d, '.claude'), 'junction'); } catch { t.skip('el sistema no permite crear enlaces simbolicos'); return; }
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'base');
  assert.ok(!mig.plan(d).reescribir.includes('.claude/settings.json'));
  mig.aplicar(d);
  assert.strictEqual(fs.readFileSync(path.join(fuera, 'settings.json'), 'utf8'), settings);
});

test('faro/ como enlace simbolico: no se migra (moveria y escribiria fuera del repo)', (t) => {
  const fuera = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-fuera-base-'));
  const d = repo(LEGADO);
  try { fs.symlinkSync(fuera, path.join(d, 'faro'), 'junction'); } catch { t.skip('el sistema no permite crear enlaces simbolicos'); return; }
  const r = mig.aplicar(d);
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /enlace simbólico/);
  assert.deepStrictEqual(fs.readdirSync(fuera), []);
  assert.ok(hay(d, 'gestion/risks.md'), 'no movio nada');
});
