// El esqueleto es lo que recibe cualquier repo nuevo: no puede arrastrar la marca de nadie y tiene que
// viajar dentro del paquete npm (npm NO empaqueta un fichero llamado .gitignore: de ahí `gitignore`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RAIZ_ESQUELETO, copiarEsqueleto } from '../bin/lib/esqueleto.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ESQUELETO = path.join(REPO, 'bin', 'esqueleto');

const recorrer = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? recorrer(p, base) : [path.relative(base, p).replaceAll('\\', '/')];
});
const temporal = () => fs.mkdtempSync(path.join(os.tmpdir(), 'faro-esqueleto-'));

test('esqueleto: ningún fichero lleva marca ni servicios de una organización', () => {
  const marca = new RegExp(['fract' + 'alia', 'clickup', 'n8n', 'cas-?' + 'ia', 'qratia'].join('|'), 'i');   // troceado: el test no se cita a sí mismo
  const conMarca = recorrer(ESQUELETO).flatMap((rel) => fs.readFileSync(path.join(ESQUELETO, rel), 'utf8')
    .split(/\r?\n/)
    .filter((linea) => marca.test(linea))
    .map((linea) => `${rel}: ${linea.trim()}`));
  assert.deepEqual(conMarca, []);
});

test('esqueleto: no lleva configuración de un MCP ni de equipos ajenos', () => {
  const ficheros = recorrer(ESQUELETO);
  for (const fuera of ['.mcp.json', '.faro.json', 'formativo.md']) assert.equal(ficheros.includes(fuera), false, fuera);
  const settings = JSON.parse(fs.readFileSync(path.join(ESQUELETO, '.claude', 'settings.json'), 'utf8'));
  assert.equal(JSON.stringify(settings).includes('mcp__'), false);
});

test('esqueleto: el paquete npm lo incluye, gitignore incluido', () => {
  const salida = execSync('npm pack --dry-run --json --ignore-scripts', { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const empaquetados = JSON.parse(salida)[0].files.map((f) => f.path.replaceAll('\\', '/'));
  for (const rel of recorrer(ESQUELETO)) assert.ok(empaquetados.includes(`bin/esqueleto/${rel}`), `falta en el paquete: ${rel}`);
});

test('copiarEsqueleto: instala el gitignore como .gitignore y deja la estructura FARO', () => {
  const destino = temporal();
  copiarEsqueleto(destino);
  assert.equal(fs.existsSync(path.join(destino, 'gitignore')), false);
  assert.match(fs.readFileSync(path.join(destino, '.gitignore'), 'utf8'), /\.env/);
  for (const rel of ['CLAUDE.md', 'README.md', '.claude/settings.json', 'gestion/risks.md', 'documentos/README.md']) {
    assert.ok(fs.existsSync(path.join(destino, rel)), rel);
  }
});

test('copiarEsqueleto: copia las carpetas que solo llevan .gitkeep, que git necesita para conservarlas', () => {
  const destino = temporal();
  copiarEsqueleto(destino);
  assert.ok(fs.existsSync(path.join(destino, 'borrador', 'data', '.gitkeep')));
  assert.ok(fs.existsSync(path.join(destino, 'gestion', 'cambios', 'changes', 'archive', '.gitkeep')));
});

test('RAIZ_ESQUELETO: apunta al esqueleto que viaja con el CLI', () => {
  assert.equal(path.resolve(RAIZ_ESQUELETO), ESQUELETO);
});

test('esqueleto: la allowlist no abre WebFetch sin límite ni deja git escribir historia sin confirmar', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(ESQUELETO, '.claude', 'settings.json'), 'utf8'));
  const allow = settings.permissions.allow;
  assert.equal(allow.includes('WebFetch'), false, 'WebFetch sin restricción');
  for (const herramienta of ['Bash', 'PowerShell']) {
    for (const cmd of ['git log*', 'git diff*', 'git commit*', 'git checkout*', 'git merge*', 'git cherry-pick*']) {
      assert.equal(allow.includes(`${herramienta}(${cmd})`), false, `${herramienta}(${cmd})`);
    }
  }
});
