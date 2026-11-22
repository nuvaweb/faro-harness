#!/usr/bin/env node
// scripts/tests-afectados.js — que ficheros de test hay que correr para un cambio (#8).
//
// En un PR el CI corre solo los tests afectados; en main, la suite completa (red de seguridad). La seleccion
// es CONSERVADORA: ante la duda, la suite completa.
//   1. Cambiados = git diff --name-only <merge-base(base, HEAD)>...HEAD.
//   2. Alcanzados = cambiados + todo lo que los importa, sin limite de saltos (grafo de imports de FARO).
//   3. Un test entra si esta alcanzado, o si CITA por nombre un fichero alcanzado: la mayoria de tests lanzan
//      harness.js o un hook como proceso (spawn), y esa dependencia no es un import que el grafo vea.
//   4. Suite completa si: el grafo no se puede construir/leer, falla git, o el cambio toca la infraestructura
//      de tests (cualquier fichero de test/ que no sea un *.test.*, package.json, workflows del CI).
//   5. Siempre se incluye smoke.test.mjs: un PR nunca pasa sin correr nada.
//
// Uso: node scripts/tests-afectados.js <base>   -> un fichero por linea (test/x.test.mjs), o '*' = suite completa.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RE_TEST = /\.test\.(mjs|cjs|js)$/;
const SIEMPRE = 'smoke.test.mjs';

// Cambios que obligan a la suite completa: el lanzador, helpers/fixtures de test, dependencias y el propio CI.
function esInfraestructura(rel) {
  if (rel.startsWith('test/') && !RE_TEST.test(rel)) return true;
  return /^(package(-lock)?\.json|pnpm-lock\.yaml|\.github\/workflows\/)/.test(rel);
}

/**
 * Seleccion pura (testeable sin git ni grafo).
 * @param {{cambiados: string[], inversas: Map<string, Iterable<string>>, tests: string[], leer: (t: string) => string}} p
 *   cambiados: rutas relativas con '/'; inversas: fichero -> quienes lo importan; tests: nombres de test/ (x.test.mjs);
 *   leer: contenido de un test por nombre.
 * @returns {'*' | string[]} '*' = suite completa; si no, nombres de fichero de test/ ordenados.
 */
function seleccionar({ cambiados, inversas, tests, leer }) {
  if (!Array.isArray(cambiados)) return '*';
  if (cambiados.some(esInfraestructura)) return '*';
  const vistos = new Set(cambiados);
  let frontera = [...cambiados];
  while (frontera.length) {
    const sig = [];
    for (const r of frontera) for (const d of (inversas.get(r) || [])) if (!vistos.has(d)) { vistos.add(d); sig.push(d); }
    frontera = sig;
  }
  if ([...vistos].some(esInfraestructura)) return '*';
  const nombres = [...new Set([...vistos].filter((r) => !r.startsWith('test/')).map((r) => path.basename(r)))];
  const elegidos = new Set([SIEMPRE]);
  for (const t of tests) {
    if (vistos.has(`test/${t}`)) { elegidos.add(t); continue; }
    let txt = '';
    try { txt = leer(t); } catch { continue; }
    if (nombres.some((n) => txt.includes(n))) elegidos.add(t);
  }
  return [...elegidos].filter((t) => tests.includes(t)).sort();
}

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout : null;
}

function calcular(root, base) {
  if (!base || !/^[A-Za-z0-9][A-Za-z0-9._/~^-]*$/.test(base)) return '*';
  const mb = git(root, ['merge-base', base, 'HEAD']);
  if (!mb) return '*';
  const diff = git(root, ['diff', '--name-only', `${mb.trim()}...HEAD`]);
  if (diff === null) return '*';
  const cambiados = diff.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const harness = path.join(root, 'plugins', 'faro', 'hooks', 'harness.js');
  const c = spawnSync(process.execPath, [harness, 'grafo', 'construir'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (c.status !== 0) return '*';
  let inversas;
  try {
    const I = require(path.join(root, 'plugins', 'faro', 'hooks', 'lib', 'grafo', 'indice.js'));
    const idx = I.cargar(root);
    if (!idx || !idx.ficheros) return '*';
    inversas = I.aristas(idx).inversas;
  } catch { return '*'; }
  const dir = path.join(root, 'test');
  const tests = fs.readdirSync(dir).filter((f) => RE_TEST.test(f)).sort();
  return seleccionar({ cambiados, inversas, tests, leer: (t) => fs.readFileSync(path.join(dir, t), 'utf8') });
}

module.exports = { seleccionar, esInfraestructura, calcular, SIEMPRE };

if (require.main === module) {
  const r = calcular(process.cwd(), process.argv[2]);
  process.stdout.write(r === '*' ? '*\n' : r.map((t) => `test/${t}`).join('\n') + '\n');
}
