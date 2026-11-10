// #127 — Contexto minimo en los hooks (con #122, #123 y #125, que tocan las mismas funciones).
//
// MEDIDOR REPRODUCIBLE: un repo de trabajo GRANDE (calcado de la forma de un monorepo real: cuatro
// fases, cinco cambios abiertos con plan, 54 requisitos con 18 aceptados sin cobertura, 27
// documentos controlados, 31 riesgos, codigo) sobre el que se mide lo que inyecta cada hook.
// Partida medida en v0.59.1 sobre ese repo real: session 26.134 car. (la plataforma corta a 10.000
// y el modelo solo ve 2.000), prompt-context ~1.490 car. EN CADA prompt, pre-doc 370-730 por edicion.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'harness.js');
const DATOS = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-plugin-data-'));

function correr(sub, dir, payload, extra = []) {
  return spawnSync(process.execPath, [HARNESS, sub, ...extra], {
    cwd: dir, encoding: 'utf8', timeout: 120000,
    input: payload === undefined ? '' : JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_DATA: DATOS, FARO_GITHUB_TOKEN: '', GITHUB_TOKEN: '' },
  });
}
// Lo que llega AL MODELO: additionalContext (o el stdout crudo si no es JSON).
function contexto(r) {
  const s = (r.stdout || '').trim();
  if (!s) return '';
  try { const j = JSON.parse(s); return (j.hookSpecificOutput && j.hookSpecificOutput.additionalContext) || ''; } catch { return s; }
}
const veces = (txt, aguja) => txt.split(aguja).length - 1;

function repoGrande({ rama = 'feat/1-monorepo' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-grande-'));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  const w = (rel, txt) => {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), txt);
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test User');
  git('config', 'commit.gpgsign', 'false');
  git('remote', 'add', 'origin', 'git@github.com:acme-org/grande.git');
  const tareas = (n, hechas, pref) => Array.from({ length: n }, (_, i) =>
    `- [${i < hechas ? 'x' : ' '}] #${pref + i} · Entregable ${pref + i} con un titulo de longitud realista — @test-user`).join('\n');
  w('ESTADO.md', `---
iniciativa: Grande
clave: GRAN
tipo: proyecto
fases_total: 4
fase_actual: 2
owner: Test User
funcional: documentos/funcional/GRAN-FUN-001-funcional.md
---

### Fase 1 · Estandar y piloto — done
Lo que trae la fase uno.
Objetivo: 2026-09-01
${tareas(3, 3, 100)}

### Fase 2 · Monorepo y despliegue — in_progress
Lo que trae la fase dos.
Objetivo: 2026-12-24
${tareas(4, 0, 1)}

### Fase 3 · Produccion — pending
Lo que trae la fase tres.
Objetivo: 2027-01-30
${tareas(12, 4, 10)}

### Fase 4 · Generalizacion — pending
Lo que trae la fase cuatro.
Objetivo: 2027-02-28
${tareas(13, 0, 30)}
`);
  w('gestion/reporting/informes/2026-09-01-fase-1-informe.md', '---\nfase: 1\n---\n# Informe\n');
  const doc = (id, tema, slug, status = 'draft') => w(`documentos/${tema}/${id}-${slug}.md`, `---
doc_id: ${id}
title: Documento ${id} con un titulo largo como los de verdad
description: Una descripcion de una linea que dice que va dentro del documento y para que sirve
status: ${status}
version: 1.0.0
date: 2026-09-01
classification: interna
author: Test User
---
# ${id}
`);
  doc('GRAN-FUN-001', 'funcional', 'funcional', 'approved');
  for (let i = 1; i <= 26; i++) doc(`GRAN-ANA-${String(i).padStart(3, '0')}`, 'analisis', `analisis-${i}`);
  w('gestion/risks.md', '| ID | Tipo | Desc | Impacto | Dueno | Estado |\n|---|---|---|---|---|---|\n' +
    Array.from({ length: 31 }, (_, i) => `| R${i + 1} | Riesgo | riesgo ${i + 1} | Alto | @t | abierto |`).join('\n') + '\n');
  const reqs = Array.from({ length: 54 }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    const estado = i < 18 ? 'aceptado' : i < 38 ? 'entregado' : i < 45 ? 'propuesto' : i < 47 ? 'descartado' : 'aceptado';
    return `## REQ-${n} · Requisito ${n} con nombre realista\n- estado: ${estado}\n- origen: fuentes/reunion.vtt\n`;
  });
  w('gestion/requisitos.md', `# Requisitos\n\n${reqs.join('\n')}`);
  // Los aceptados del final quedan cubiertos por un cambio que los cita: no todos son huecos.
  const cambio = (slug, estado, hechas, total, extra = '') => {
    w(`gestion/cambios/changes/${slug}/proposal.md`, `---
titulo: Cambio ${slug}
descripcion: Que resuelve ${slug}
estado: ${estado}
fase: 2
owner: Test User
responsable: test@example.com
tareas: []
aprobada_por: Test User
---
## Por qué
Motivo suficientemente largo para el gate del harness. ${extra}
## Qué cambia
- Algo
`);
    w(`gestion/cambios/changes/${slug}/tasks.md`, Array.from({ length: total }, (_, i) => `- [${i < hechas ? 'x' : ' '}] Paso ${i + 1}`).join('\n') + '\n');
  };
  cambio('dimensionamiento-datos-reales', 'aprobada', 18, 19, 'REQ-48 REQ-49 REQ-50');
  cambio('dimensionamiento-mapa-horario', 'aprobada', 12, 13, 'REQ-51 REQ-52');
  cambio('dimensionamiento-tres-mapas', 'implementada', 13, 13, 'REQ-53 REQ-54');
  cambio('endurecer-acceso-y-pruebas', 'aprobada', 4, 7);
  cambio('operativa-v2-backlog-equipos', 'aprobada', 3, 4);
  w('package.json', JSON.stringify({ name: 'grande', private: true, scripts: { test: 'node --test', lint: 'eslint .' } }, null, 2));
  w('apps/panel/src/index.js', 'export const x = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('branch', '-M', 'main');
  if (rama !== 'main') git('switch', '-q', '-c', rama);
  return dir;
}

// ---------- piezas puras (lib/contexto.js) ----------

const CM = createRequire(import.meta.url)(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'contexto.js'));

test('presupuesto: recorta avisos antes que estado, y nunca la seguridad', () => {
  const largo = (c) => c.repeat(1000);
  const out = CM.presupuestar([
    { prio: 0, lineas: [largo('S')] },
    { prio: 1, lineas: [largo('E')] },
    { prio: 2, lineas: [largo('A'), largo('B')] },
  ], 2500, 'PUNTERO');
  const txt = out.join('\n');
  assert.ok(txt.includes(largo('S')), 'la seguridad no se recorta');
  assert.ok(txt.includes(largo('E')), 'el estado cabe y se queda');
  assert.ok(!txt.includes(largo('B')), 'los avisos del final se van primero');
  assert.match(txt, /recortadas/, 'el recorte se dice');
  assert.strictEqual(out[out.length - 1], 'PUNTERO', 'el puntero al detalle siempre va');
});

test('agregacion: un bloque con cabecera se dice en una linea, y lo que no cabe se cuenta', () => {
  const l = CM.unaLinea(['Cosas pendientes:', '- uno', '- dos', '- tres'], 30, 'harness.js estado');
  assert.match(l, /^Cosas pendientes: uno · dos/);
  assert.match(l, /\(\+\d mas: harness\.js estado\)$/);
  assert.strictEqual(CM.unaLinea([]), '');
});

test('deltas: sin estado previo se emite todo; con estado, solo lo cambiado y lo marcado siempre', () => {
  const secs = (fase) => [
    { clave: 'rama', siempre: true, lineas: ['RAMA'] },
    { clave: 'fase', lineas: [fase] },
    { clave: 'git', lineas: ['GIT'] },
  ];
  const a = CM.deltas(secs('F1'), null);
  assert.deepStrictEqual(a.lineas, ['RAMA', 'F1', 'GIT']);
  const b = CM.deltas(secs('F1'), a.estado);
  assert.deepStrictEqual(b.lineas, ['RAMA']);
  const c = CM.deltas(secs('F2'), b.estado);
  assert.deepStrictEqual(c.lineas, ['RAMA', 'F2']);
});

test('deltas: el estado vive fuera del repo, con clave por repo y sesion', () => {
  const r1 = CM.rutaEstado('/repo/a', 'ses-1', { CLAUDE_PLUGIN_DATA: DATOS });
  assert.ok(r1.startsWith(DATOS));
  assert.notStrictEqual(r1, CM.rutaEstado('/repo/b', 'ses-1', { CLAUDE_PLUGIN_DATA: DATOS }));
  assert.notStrictEqual(r1, CM.rutaEstado('/repo/a', 'ses-2', { CLAUDE_PLUGIN_DATA: DATOS }));
  assert.strictEqual(CM.rutaEstado('/repo/a', '', {}), null, 'sin sesion no hay estado');
  assert.ok(CM.rutaEstado('/repo/a', 'x', {}).startsWith(path.join(os.tmpdir(), 'faro')), 'sin CLAUDE_PLUGIN_DATA, al temporal');
});

// ---------- medidor ----------

test('MEDIDOR: el arranque cabe en el presupuesto (< 8.000 car.) en un repo grande', () => {
  const dir = repoGrande();
  const s = contexto(correr('session', dir, { session_id: 'med-1', source: 'startup' }));
  console.log(`# medidor · session = ${s.length} car.`);
  assert.ok(s.length > 1000, `el arranque no puede quedarse vacio:\n${s}`);
  assert.ok(s.length < 8000, `session = ${s.length} car. (partida 26.134):\n${s}`);
});

test('MEDIDOR: una sesion tipica (20 prompts, 15 ediciones) cuesta <= 8.000 tokens de hooks', () => {
  const dir = repoGrande();
  const sid = 'med-tipica';
  let total = contexto(correr('session', dir, { session_id: sid, source: 'startup' })).length;
  let prompts = 0, ediciones = 0;
  for (let i = 0; i < 20; i++) {
    const p = contexto(correr('prompt-context', dir, { session_id: sid, prompt: `peticion ${i}` }));
    prompts += p.length;
    if (i === 10) fs.writeFileSync(path.join(dir, 'apps', 'panel', 'src', 'nuevo.js'), 'export const y = 2;\n');
  }
  const rutas = ['ESTADO.md', 'documentos/analisis/GRAN-ANA-001-analisis-1.md', 'apps/panel/src/index.js'];
  for (let i = 0; i < 15; i++) {
    const fp = path.join(dir, rutas[i % rutas.length]);
    const r = correr('pre-doc', dir, { session_id: sid, tool_name: 'Edit', tool_input: { file_path: fp } });
    ediciones += (r.stdout || '').length;
  }
  total += prompts + ediciones;
  const tokens = Math.round(total / 4);
  console.log(`# medidor · sesion tipica: prompts=${prompts} car. · ediciones=${ediciones} car. · total=${total} car. ≈ ${tokens} tokens`);
  assert.ok(tokens <= 8000, `sesion tipica = ${tokens} tokens (partida ~20.000)`);
});

// ---------- indice de sesion (#127) y presupuesto (#123) ----------

test('indice: los cambios abiertos salen UNA vez y el resumen ejecutivo UNA vez', () => {
  const dir = repoGrande();
  const s = contexto(correr('session', dir, { session_id: 'idx-1', source: 'startup' }));
  for (const nombre of ['endurecer-acceso-y-pruebas', 'operativa-v2-backlog-equipos']) {
    assert.strictEqual(veces(s, nombre), 1, `'${nombre}' sale ${veces(s, nombre)} veces:\n${s}`);
  }
  assert.strictEqual(veces(s, 'RESUMEN EJECUTIVO'), 1);
  assert.ok(!/Estado del trabajo \(ESTADO\.md\)/.test(s), 'el resumen no se repite con otro titulo');
});

test('indice: los avisos repetidos se agregan en una linea (requisitos sin cobertura)', () => {
  const dir = repoGrande();
  const s = contexto(correr('session', dir, { session_id: 'idx-2', source: 'startup' }));
  assert.match(s, /REQ-01/, s);
  assert.match(s, /REQ-12/);
  assert.match(s, /\(\+6 mas\)/, 'lo que no cabe se cuenta, no se pierde');
  const lineas = s.split('\n').filter((l) => /sin cambio ni tarea que lo cubra/.test(l));
  assert.ok(lineas.length <= 1, `requisitos en ${lineas.length} lineas casi iguales`);
});

test('indice: fuera catalogos que ya estan en otro sitio (subagentes, convenciones, documentos uno a uno)', () => {
  const dir = repoGrande();
  const s = contexto(correr('session', dir, { session_id: 'idx-3', source: 'startup' }));
  assert.ok(!/Subagentes disponibles/.test(s), 'el prompt de sistema ya lista los subagentes');
  assert.ok(!/CONTROL DOCUMENTAL \(obligatorio/.test(s), 'las convenciones documentales viven en faro:documentacion');
  assert.ok(!/GRAN-ANA-007/.test(s), 'los documentos no se listan uno a uno');
  assert.match(s, /faro:documentacion/, 'debe decir donde estan las convenciones');
  assert.match(s, /harness\.js estado/, 'y como pedir el detalle');
});

test('indice: el detalle completo sigue disponible bajo demanda (harness.js estado)', () => {
  const dir = repoGrande();
  const r = correr('estado', dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /CONTROL DOCUMENTAL/, 'estado debe dar las convenciones');
  assert.match(r.stdout, /GRAN-ANA-007|\+\d+ mas/, 'y el inventario documental');
  assert.match(r.stdout, /REQ-14 \(/, 'y los requisitos uno a uno');
});

test('presupuesto: nada de seguridad se pierde en el indice (rama principal)', () => {
  const dir = repoGrande({ rama: 'main' });
  const s = contexto(correr('session', dir, { session_id: 'seg-1', source: 'startup' }));
  assert.match(s, /PROTECCION 'main'/, s);
  assert.match(s, /Identidad:/);
  assert.match(s, /PROTOCOLO SPEC \(obligatorio/);
  assert.ok(s.length < 8000, `${s.length} car.`);
});

// ---------- deltas en prompt-context (#127) ----------

test('deltas: tras el arranque, un prompt sin cambios no inyecta nada (el indice ya lo dijo)', () => {
  const dir = repoGrande();
  const sid = 'delta-0';
  correr('session', dir, { session_id: sid, source: 'startup' });
  const p1 = contexto(correr('prompt-context', dir, { session_id: sid }));
  assert.strictEqual(p1, '', `el arranque acaba de decirlo:\n${p1}`);
});

test('deltas: sin arranque previo, el primer prompt lleva el estado y el segundo nada', () => {
  const dir = repoGrande();
  const sid = 'delta-1';
  const p1 = contexto(correr('prompt-context', dir, { session_id: sid }));
  const p2 = contexto(correr('prompt-context', dir, { session_id: sid }));
  assert.match(p1, /Cambios abiertos/, 'el primero lleva el estado');
  assert.strictEqual(p2, '', `sin cambios no hay nada nuevo que decir:\n${p2}`);
});

test('deltas: lo que cambia se reemite (y solo eso)', () => {
  const dir = repoGrande();
  const sid = 'delta-2';
  correr('prompt-context', dir, { session_id: sid });
  fs.mkdirSync(path.join(dir, 'gestion', 'cambios', 'changes', 'nuevo-cambio'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'gestion', 'cambios', 'changes', 'nuevo-cambio', 'proposal.md'),
    '---\ntitulo: Nuevo\ndescripcion: x\nestado: borrador\nfase: 2\nowner: T\nresponsable: t@t\ntareas: []\n---\n## Por qué\nx\n');
  const p = contexto(correr('prompt-context', dir, { session_id: sid }));
  assert.match(p, /nuevo-cambio/, p);
  assert.ok(!/Iterando · fase/.test(p), `la fase no cambio y no debe repetirse:\n${p}`);
});

test('deltas: el aviso de rama sin escritura sale en CADA prompt aunque no cambie', () => {
  const dir = repoGrande({ rama: 'main' });
  const sid = 'delta-3';
  correr('prompt-context', dir, { session_id: sid });
  const p2 = contexto(correr('prompt-context', dir, { session_id: sid }));
  assert.match(p2, /RAMA '(main|master)'/, `la seguridad de rama nunca se deduplica:\n${p2}`);
});

test('deltas: tras compactar se reemite todo (el contexto anterior ya no esta)', () => {
  const dir = repoGrande();
  const sid = 'delta-4';
  correr('prompt-context', dir, { session_id: sid });
  const re = contexto(correr('session', dir, { session_id: sid, source: 'compact' }));
  assert.match(re, /REANCLA TRAS COMPACTAR/, 'la plataforma entrega "source": compact');
  const p = contexto(correr('prompt-context', dir, { session_id: sid }));
  assert.match(p, /Cambios abiertos/, `tras compactar el primer prompt vuelve a llevar el estado:\n${p}`);
});

test('deltas: sin session_id (invocacion manual) se emite todo, como siempre', () => {
  const dir = repoGrande();
  const a = contexto(correr('prompt-context', dir, {}));
  const b = contexto(correr('prompt-context', dir, {}));
  assert.ok(a.length > 0 && a === b, 'sin sesion no hay estado que comparar');
});

// ---------- pre-doc deduplicado (#127) ----------

test('pre-doc: el mismo aviso no se repite en la misma sesion', () => {
  const dir = repoGrande();
  const sid = 'predoc-1';
  const fp = path.join(dir, 'ESTADO.md');
  const a = correr('pre-doc', dir, { session_id: sid, tool_input: { file_path: fp } }).stdout;
  const b = correr('pre-doc', dir, { session_id: sid, tool_input: { file_path: fp } }).stdout;
  assert.match(a, /fuente de verdad del faseo/, a);
  assert.strictEqual(b.trim(), '', `segunda edicion, mismo aviso:\n${b}`);
  const c = correr('pre-doc', dir, { session_id: 'otra-sesion', tool_input: { file_path: fp } }).stdout;
  assert.match(c, /fuente de verdad del faseo/, 'otra sesion no lo ha visto');
});

test('pre-doc: los bloqueos NO se deduplican (rama principal)', () => {
  const dir = repoGrande({ rama: 'main' });
  const sid = 'predoc-2';
  const fp = path.join(dir, 'ESTADO.md');
  for (let i = 0; i < 2; i++) {
    const out = correr('pre-doc', dir, { session_id: sid, tool_input: { file_path: fp } }).stdout;
    assert.match(out, /"permissionDecision":"deny"/, `intento ${i + 1}:\n${out}`);
  }
});

test('pre-bash: una orden inocua sale sin decir nada', () => {
  const dir = repoGrande();
  const r = correr('pre-bash', dir, { tool_input: { command: 'ls -la' } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), '');
  const d = correr('pre-bash', dir, { tool_input: { command: 'cat .env' } });
  assert.match(d.stdout, /deny/, 'las guardas siguen vivas para lo que no es inocuo');
});
