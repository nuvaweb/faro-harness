// Cambio 'catalogo-ligero' (#128): el catalogo de skills y agentes que ve el modelo.
//
// Caso real (2026-10-10): en una sesion de Claude Code 8 skills de faro NO aparecian en el listado
// del modelo (auditoria, estado, forja, observabilidad, pendientes, sincronizar, sync, triaje) y dos
// agentes salian como "Agent from faro plugin". La causa no era el presupuesto: su frontmatter era
// YAML INVALIDO. Un escalar sin comillas no admite ': ' dentro ("...en una pasada: fase en
// curso..."), el parser YAML del cliente lo rechaza y la skill se descarta en silencio. El lector
// casero del harness no lo ve porque parte por la primera ':'.
//
// Este test es la red: valida el frontmatter con las reglas de YAML que importan aqui, mide cada
// descripcion contra su limite y vigila el presupuesto total, que se paga en CADA sesion.
//
// Inventario medido: `node test/catalogo-ligero.test.mjs --tabla` imprime la longitud de cada una.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(RAIZ, 'plugins', 'faro');

const LIMITE_SKILL = 200;
const LIMITE_AGENTE = 250;
const PRESUPUESTO_TOTAL = 10000; // ~2.500 tokens entre skills y agentes

// Skills con `disable-model-invocation: true`: solo las lanza el humano con /faro:<nombre>.
// Solo se marca una skill cuando NADA (harness, otras skills, agentes) instruye al modelo a lanzarla:
// la bandera la saca del listado del modelo y romperia ese encadenado.
const SOLO_HUMANO = ['renombrar'];

// Escalar YAML de una linea: comillas dobles, simples o plano. Devuelve { ok, valor, error }.
export function escalarYaml(crudo) {
  const v = crudo.trim();
  if (v.startsWith('"')) {
    if (!v.endsWith('"') || v.length < 2) return { ok: false, error: 'comilla doble sin cerrar' };
    try { return { ok: true, valor: JSON.parse(v) }; } catch { return { ok: false, error: 'escape no valido entre comillas dobles' }; }
  }
  if (v.startsWith("'")) {
    if (!v.endsWith("'") || v.length < 2) return { ok: false, error: 'comilla simple sin cerrar' };
    const dentro = v.slice(1, -1);
    if (/'(?!')/.test(dentro.replace(/''/g, ''))) return { ok: false, error: "comilla simple sin duplicar ('')" };
    return { ok: true, valor: dentro.replace(/''/g, "'") };
  }
  // Plano: lo que rompe el parser del cliente.
  if (/: |:$/.test(v)) return { ok: false, error: "escalar sin comillas con ': ' dentro (YAML lo lee como otro mapa)" };
  if (/ #/.test(v)) return { ok: false, error: "escalar sin comillas con ' #' (YAML lo corta como comentario)" };
  if (/^[\[\]{}>|*&!%@`,?#]/.test(v) || /^- /.test(v)) return { ok: false, error: `escalar sin comillas que empieza por indicador YAML '${v[0]}'` };
  return { ok: true, valor: v };
}

export function frontmatter(fichero) {
  const txt = fs.readFileSync(fichero, 'utf8').replace(/\r\n/g, '\n');
  const m = txt.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return { errores: ['sin frontmatter'], datos: {} };
  const datos = {}; const errores = [];
  for (const linea of m[1].split('\n')) {
    if (!linea.trim()) continue;
    const k = linea.match(/^([A-Za-z][\w-]*):(?: (.*))?$/);
    if (!k) { errores.push(`linea no es 'clave: valor': ${linea.slice(0, 60)}`); continue; }
    const e = escalarYaml(k[2] || '');
    if (!e.ok) errores.push(`${k[1]}: ${e.error}`); else datos[k[1]] = e.valor;
  }
  return { errores, datos };
}

export function inventario() {
  const out = [];
  for (const d of fs.readdirSync(path.join(PLUGIN, 'skills')).sort()) {
    const f = path.join(PLUGIN, 'skills', d, 'SKILL.md');
    if (fs.existsSync(f)) out.push({ tipo: 'skill', nombre: d, fichero: f, limite: LIMITE_SKILL, ...frontmatter(f) });
  }
  for (const a of fs.readdirSync(path.join(PLUGIN, 'agents')).filter((n) => n.endsWith('.md')).sort()) {
    const f = path.join(PLUGIN, 'agents', a);
    out.push({ tipo: 'agente', nombre: a.replace(/\.md$/, ''), fichero: f, limite: LIMITE_AGENTE, ...frontmatter(f) });
  }
  for (const e of out) e.largo = (e.datos.description || '').length;
  return out;
}

if (process.argv.includes('--tabla')) {
  const inv = inventario();
  for (const e of inv) console.log(`${e.tipo.padEnd(6)} ${String(e.largo).padStart(4)}/${e.limite} ${e.errores.length ? 'YAML-INVALIDO ' : ''}${e.nombre}`);
  const s = (t) => inv.filter((e) => e.tipo === t).reduce((a, e) => a + e.largo, 0);
  console.log(`skills ${s('skill')} · agentes ${s('agente')} · total ${s('skill') + s('agente')}/${PRESUPUESTO_TOTAL}`);
}

test('el validador de escalares rechaza lo que rompe el parser YAML del cliente', () => {
  assert.strictEqual(escalarYaml('Da la foto en una pasada: fase en curso').ok, false);
  assert.strictEqual(escalarYaml('OJO: esto no es sync').ok, false);
  assert.strictEqual(escalarYaml('"Da la foto: fase en curso"').ok, true);
  assert.strictEqual(escalarYaml('usa /faro:pr para abrirla').ok, true, "':' sin espacio detras es valido");
  assert.strictEqual(escalarYaml("'it''s'").valor, "it's");
});

test('todo frontmatter de skill y agente es YAML valido y tiene descripcion', () => {
  const malos = inventario().filter((e) => e.errores.length || !e.datos.description)
    .map((e) => `${e.tipo} ${e.nombre}: ${e.errores.join('; ') || 'sin description'}`);
  assert.deepStrictEqual(malos, [], 'el cliente descarta en silencio la skill/agente con frontmatter invalido');
});

test('los agentes declaran un name igual a su fichero', () => {
  const malos = inventario().filter((e) => e.tipo === 'agente' && e.datos.name !== e.nombre).map((e) => e.nombre);
  assert.deepStrictEqual(malos, []);
});

test('cada descripcion cabe en su limite (skill 200, agente 250)', () => {
  const largos = inventario().filter((e) => e.largo > e.limite).map((e) => `${e.tipo} ${e.nombre}: ${e.largo}/${e.limite}`);
  assert.deepStrictEqual(largos, []);
});

test('las descripciones empiezan por el caso de uso', () => {
  const malos = inventario().filter((e) => !/^(Úsala|Usar)\b/.test(e.datos.description || ''))
    .map((e) => `${e.tipo} ${e.nombre}`);
  assert.deepStrictEqual(malos, [], "skills con 'Úsala…', agentes con 'Usar…'");
});

test('presupuesto del catalogo: la suma de descripciones no pasa de 10.000 caracteres', (t) => {
  const total = inventario().reduce((a, e) => a + e.largo, 0);
  t.diagnostic(`total ${total}/${PRESUPUESTO_TOTAL}`);
  assert.ok(total <= PRESUPUESTO_TOTAL, `catalogo de ${total} car. (> ${PRESUPUESTO_TOTAL})`);
});

test('solo las skills sin invocacion del modelo llevan disable-model-invocation', () => {
  const marcadas = inventario().filter((e) => e.tipo === 'skill' && e.datos['disable-model-invocation'] === 'true')
    .map((e) => e.nombre).sort();
  assert.deepStrictEqual(marcadas, [...SOLO_HUMANO].sort());
});
