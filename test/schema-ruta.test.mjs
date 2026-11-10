// Test de la ruta de faro-schema.json desde los modulos de lib/ (0.9.7). Bug reportado en
// produccion: 'harness.js asignar-tarea --tipo <x>' revienta con
//   TypeError: Cannot read properties of undefined (reading 'github')  en lib/github.js:483
// CAUSA: los modulos de lib/ resolvian el schema con path.join(__dirname, 'faro-schema.json'), pero
// __dirname en lib/ es hooks/lib/ y el schema vive en hooks/ (un nivel arriba). Entro al mover los
// modulos a lib/ en 0.9.0: en cualquier repo SIN copia local .claude/faro-schema.json el catalogo
// salia VACIO -> tipos.find() devolvia undefined -> def.github lanzaba el TypeError. El sintoma
// enganaba ("faro-schema.json sin enums.labels") aunque el schema del plugin SI los tiene.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');

test('el schema vive en hooks/, NO en hooks/lib/ (premisa del test)', () => {
  assert.ok(fs.existsSync(path.join(HOOKS, 'faro-schema.json')), 'falta hooks/faro-schema.json');
  assert.ok(!fs.existsSync(path.join(HOOKS, 'lib', 'faro-schema.json')), 'hay una copia inesperada en hooks/lib/');
});

test('ningun modulo de lib/ resuelve faro-schema.json con __dirname a secas (apuntaria a lib/)', () => {
  const malos = [];
  for (const f of fs.readdirSync(path.join(HOOKS, 'lib')).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(HOOKS, 'lib', f), 'utf8');
    // Correcto desde lib/: __dirname + '..' (o una constante que suba un nivel).
    const re = /path\.join\(\s*__dirname\s*,\s*['"]faro-schema\.json['"]\s*\)/g;
    if (re.test(src)) malos.push(f);
  }
  assert.deepStrictEqual(malos, [], `modulos de lib/ que buscan el schema en su propia carpeta (no existe alli): ${malos.join(', ')}`);
});

test('la ruta de fallback que usan los modulos de lib/ apunta a un schema que EXISTE y trae los tipos', () => {
  // Principio: el schema del PLUGIN es el fallback siempre disponible; el del repo (si existe) manda.
  // Se resuelve la ruta igual que lo hacen los modulos de lib/ tras el arreglo (subiendo un nivel).
  const rutaFallback = path.join(HOOKS, 'lib', '..', 'faro-schema.json');
  assert.ok(fs.existsSync(rutaFallback), `la ruta de fallback de lib/ no existe: ${rutaFallback}`);
  const j = JSON.parse(fs.readFileSync(rutaFallback, 'utf8'));
  const tipos = (j.enums && j.enums.labels || []).filter((l) => !l.transversal);
  assert.ok(tipos.length >= 10, `el catalogo de tipos sale corto (${tipos.length}) desde el fallback del plugin`);
  assert.ok(tipos.every((t) => 'github' in t), 'algun tipo no trae la clave github (rompe resolverLabel)');
});
