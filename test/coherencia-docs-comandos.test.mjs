// La DOCUMENTACION del plugin (skills, agentes, schema) cita comandos del harness. Si un comando se
// renombra o se elimina y la cita se queda, quien la sigue —persona o AGENTE— ejecuta algo que no
// existe y se queda parado en mitad del ciclo.
//
// Caso real (0.37.0): 'aprobar' se renombro a 'publicar' y se elimino del despachador sin alias, pero
// skills/publicar/SKILL.md siguio afirmando que "aprobar sigue funcionando como alias" (falso) y
// faro-schema.json siguio citando "harness.js hito sync y aprobar". Nadie se entero hasta que un
// agente lo ejecuto en el ultimo paso del ciclo.
//
// Este test es la red: extrae los comandos CITADOS en la documentacion y los contrasta con los que
// el despachador acepta de verdad. Es determinista y no necesita ejecutar nada.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(RAIZ, 'plugins', 'faro');
const HARNESS = path.join(PLUGIN, 'hooks', 'harness.js');

// ---------- lo que el despachador acepta de verdad ----------

// El despachador es una cadena de `if (cmd === 'x')` / `else if (cmd === 'x' || cmd === 'y')`.
// Se leen TODOS los literales comparados contra `cmd`, que es exactamente el universo de subcomandos.
function comandosReales() {
  const src = fs.readFileSync(HARNESS, 'utf8');
  const cmds = new Set();
  for (const m of src.matchAll(/\bcmd\s*===\s*'([^']+)'/g)) cmds.add(m[1]);
  return cmds;
}

// ---------- lo que la documentacion dice que existe ----------

function ficherosDoc() {
  const out = [];
  const anadirDir = (dir, filtro) => {
    let entradas = [];
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) anadirDir(p, filtro);
      else if (filtro(e.name)) out.push(p);
    }
  };
  anadirDir(path.join(PLUGIN, 'skills'), (n) => n === 'SKILL.md');
  anadirDir(path.join(PLUGIN, 'agents'), (n) => n.endsWith('.md'));
  out.push(path.join(PLUGIN, 'hooks', 'faro-schema.json'));
  return out.filter((p) => fs.existsSync(p));
}

// Cita = 'harness.js <cmd>' en cualquiera de sus formas (con ruta delante, con node delante, entre
// backticks...). Se queda con la PRIMERA palabra tras harness.js: el subcomando.
// Se ignoran los placeholders (<algo>, ${...}) y los flags.
const RE_CITA = /harness\.js["'`\s]+([a-z][a-z0-9-]*)/gi;
// 'harness.js X y Z' / 'harness.js X, Z': el segundo comando tambien se esta citando, aunque no
// lleve el 'harness.js' delante. Caso real: faro-schema.json decia "harness.js hito sync y aprobar"
// y la cita a 'aprobar' (comando ya inexistente) se colaba porque la regex solo miraba la primera.
const RE_CITA_ENCADENADA = /harness\.js["'`\s]+[a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*)*?\s*(?:,|\by\b|\bo\b)\s+([a-z][a-z0-9-]+)/gi;
// Tras el conector puede venir PROSA, no otro comando ("harness.js tipo y el redactor"). Se descartan
// las palabras que nunca serian un subcomando: sin esto la regex encadenada da falsos positivos.
const PROSA = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'su', 'sus', 'este', 'esta', 'esto',
  'lo', 'que', 'al', 'del', 'con', 'sin', 'por', 'para', 'desde', 'hasta', 'como', 'cuando', 'donde',
  'si', 'no', 'se', 'es', 'son', 'ya', 'mas', 'menos', 'todo', 'toda', 'todos', 'todas', 'otro', 'otra']);

function comandosCitados(fichero) {
  const txt = fs.readFileSync(fichero, 'utf8');
  const citas = new Map();   // cmd -> primera linea donde aparece
  const lineas = txt.split('\n');
  for (let i = 0; i < lineas.length; i++) {
    for (const re of [RE_CITA, RE_CITA_ENCADENADA]) {
      for (const m of lineas[i].matchAll(re)) {
        const c = m[1].toLowerCase();
        if (PROSA.has(c)) continue;
        if (!citas.has(c)) citas.set(c, i + 1);
      }
    }
  }
  return citas;
}

// ---------- el contrato ----------

test('todo comando citado en skills/agentes/schema existe en el despachador', () => {
  const reales = comandosReales();
  const fallos = [];
  for (const f of ficherosDoc()) {
    for (const [cmd, linea] of comandosCitados(f)) {
      if (!reales.has(cmd)) {
        fallos.push(`${path.relative(RAIZ, f)}:${linea} cita 'harness.js ${cmd}', que NO existe en el despachador`);
      }
    }
  }
  assert.deepStrictEqual(fallos, [], `Comandos citados que no existen:\n  - ${fallos.join('\n  - ')}`);
});

// 'aprobar' se ELIMINO a proposito al renombrarse a 'publicar' (sin alias, sin codigo muerto). Este
// test lo fija: si alguien lo reintroduce como cita, se entera aqui y no en produccion.
// Ojo: 'pr aprobar' SI existe (aprobar una PETICION de integracion) y es legitimo; lo que no existe
// es 'harness.js aprobar' a secas (el paso develop -> main, que ahora es 'publicar').
test("'aprobar' a secas ya no se cita como subcomando del harness (se llama 'publicar')", () => {
  const fallos = [];
  for (const f of ficherosDoc()) {
    const cita = comandosCitados(f).get('aprobar');
    if (cita) fallos.push(`${path.relative(RAIZ, f)}:${cita}`);
  }
  assert.deepStrictEqual(fallos, [], `Siguen citando 'harness.js aprobar' (no existe; es 'publicar'):\n  - ${fallos.join('\n  - ')}`);
});

// La promesa del alias cruza SALTOS DE LINEA en el markdown real ("`aprobar` sigue funcionando\n>
// como alias."), asi que se busca sobre el texto entero, no linea a linea.
test("ninguna skill promete que 'aprobar' funciona como alias (no lo hace)", () => {
  const fallos = [];
  for (const f of ficherosDoc()) {
    const txt = fs.readFileSync(f, 'utf8');
    if (/aprobar[\s\S]{0,80}\balias\b|\balias\b[\s\S]{0,80}aprobar/i.test(txt)) {
      const linea = txt.split('\n').findIndex((l) => /aprobar|alias/i.test(l)) + 1;
      fallos.push(`${path.relative(RAIZ, f)}:~${linea}`);
    }
  }
  assert.deepStrictEqual(fallos, [], `Prometen un alias 'aprobar' que no existe:\n  - ${fallos.join('\n  - ')}`);
});

// Guarda del propio test: si el parseo del despachador se rompe (cambia el formato del if/else), el
// primer test pasaria en vacio sin detectar nada. Esto fija que la extraccion sigue funcionando.
test('el parseo del despachador encuentra los comandos conocidos (guarda del propio test)', () => {
  const reales = comandosReales();
  for (const c of ['validate', 'consolidar', 'publicar', 'rama', 'asignar-tarea', 'hito']) {
    assert.ok(reales.has(c), `el parseo del despachador no encontro '${c}': la extraccion esta rota`);
  }
  assert.ok(reales.size >= 30, `solo ${reales.size} comandos extraidos: el parseo parece roto`);
});
