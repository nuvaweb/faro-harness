// #161/#162 — CONSOLIDAR LA GESTION de una app en la raiz del monorepo (caso acme-aiops: dos repos
// con su propio ESTADO, riesgos, requisitos y documentos, unidos en uno).
//
// Garantias que fija este test, todas deterministas (sin modelo):
//   - riesgos (R-NN) y requisitos (REQ-NN) se renumeran con un desplazamiento por origen (+100, +200…)
//     y TODAS las referencias se reescriben: ninguna queda colgante;
//   - los documentos se mueven conservando su doc_id; si choca con algo de la raiz NO se pisa: sale
//     como colision y como DECISION (nunca se resuelve en silencio);
//   - el ESTADO.md original se archiva en gestion/historico/ESTADO-<CLAVE>-<app>.md;
//   - .gitignore / .node-version / allowBuilds se unifican en la raiz.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const mg = require(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'monorepo-gestion.js'));

const w = (dir, rel, txt) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };
const r = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8').replace(/\r\n/g, '\n');
const hay = (dir, rel) => fs.existsSync(path.join(dir, rel));

const ESTADO_APP = `---
iniciativa: Observabilidad
fases_total: 2
fase_actual: 2
owner: ana
---

### Fase 1 · Cimientos — done
Hecho.
- [x] #3 · Base — @ana

### Fase 2 · Paneles — in_progress
En curso.
- [ ] #7 · Panel — @ana (cubre REQ-02, riesgo R-01)
`;
const RISKS_APP = `# Riesgos
| ID | Tipo | Descripcion | Prob/Imp | Mitigacion | Estado |
|----|------|-------------|----------|------------|--------|
| R-01 | riesgo | Latencia | M/A | Cache (ver REQ-01) | abierto |
| R-02 | riesgo | Coste | B/M | Tope | cerrado |
`;
const REQS_APP = `# Requisitos
## REQ-01 · Medir latencia
estado: aceptado
origen: reunion
Texto que enlaza R-01.

## REQ-02 · Panel
estado: propuesto
origen: reunion
`;

function raiz() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-gest-'));
  w(d, 'ESTADO.md', '---\niniciativa: Raiz\nfases_total: 1\nfase_actual: 1\nowner: x\n---\n\n### Fase 1 · Una — in_progress\n- [ ] #1 · Algo — @x\n');
  w(d, 'gestion/risks.md', '# Riesgos\n| ID | Tipo | Descripcion | Prob/Imp | Mitigacion | Estado |\n|----|------|-------------|----------|------------|--------|\n| R-01 | riesgo | De la raiz | M/M | - | abierto |\n');
  w(d, 'gestion/requisitos.md', '# Requisitos\n## REQ-01 · De la raiz\nestado: aceptado\norigen: x\n');
  w(d, '.gitignore', 'node_modules\ndist\n');
  w(d, 'pnpm-workspace.yaml', 'packages:\n  - "apps/*"\n\nallowBuilds:\n  esbuild: true\n');
  w(d, '.node-version', '22\n');
  return d;
}
function conApp(d, id = 'obs') {
  const a = `apps/${id}`;
  w(d, `${a}/ESTADO.md`, ESTADO_APP);
  w(d, `${a}/gestion/risks.md`, RISKS_APP);
  w(d, `${a}/gestion/requisitos.md`, REQS_APP);
  w(d, `${a}/gestion/decisions/2026-01-01-uso-kv.md`, '# ADR\nVer REQ-01 y R-02.\n');
  w(d, `${a}/gestion/tareas/7.json`, '{"issue":7}\n');
  w(d, `${a}/documentos/funcional/f.md`, '---\ndoc_id: OBS-FUN-001\ntitle: F\nstatus: aprobado\n---\nCubre REQ-02. Ver #7 y el color #123456.\n');
  w(d, `${a}/documentos/ref.md`, '---\ndoc_id: OBS-ARQ-002\n---\nx\n');
  w(d, `${a}/fuentes/nota.txt`, 'nota\n');
  w(d, `${a}/src/index.ts`, '// implementa REQ-02 (ver R-01)\nexport const x = 1;\n');
  w(d, `${a}/.gitignore`, 'node_modules\n/dist\n.wrangler\n');
  w(d, `${a}/.node-version`, '22\n');
  w(d, `${a}/pnpm-workspace.yaml`, 'allowBuilds:\n  esbuild: true\n  sharp: true\n');
  return d;
}

test('desplazar: REQ-NN y R-NN suben el desplazamiento y conservan el relleno; el resto no se toca', () => {
  const t = 'REQ-01 y R-02 y REQ-9, no ABC-REQ-01 ni R-ESTADO ni XR-01 ni R-3x; doc OBS-FUN-001';
  assert.strictEqual(mg.desplazar(t, 100), 'REQ-101 y R-102 y REQ-109, no ABC-REQ-01 ni R-ESTADO ni XR-01 ni R-3x; doc OBS-FUN-001');
  assert.strictEqual(mg.desplazar(t, 0), t);
  assert.strictEqual(mg.desplazar('REQ-01 R-01', 100, { soloRequisitos: true }), 'REQ-101 R-01');
});

test('leerGestion: fases, ids de riesgos y requisitos, doc_id y clave documental', () => {
  const d = conApp(raiz());
  const g = mg.leerGestion(path.join(d, 'apps/obs'));
  assert.ok(g.tiene);
  assert.deepStrictEqual(g.fases.map((f) => [f.n, f.estado]), [[1, 'done'], [2, 'in_progress']]);
  assert.deepStrictEqual(g.riesgos, ['R-01', 'R-02']);
  assert.deepStrictEqual(g.requisitos, ['REQ-01', 'REQ-02']);
  assert.deepStrictEqual(g.docs.map((x) => x.id).sort(), ['OBS-ARQ-002', 'OBS-FUN-001']);
  assert.strictEqual(g.clave, 'OBS');
  assert.deepStrictEqual(g.carpetas.sort(), ['documentos', 'fuentes', 'gestion']);
  assert.strictEqual(mg.leerGestion(path.join(d, 'apps/nada')).tiene, false);
});

test('planConsolidar: movimientos, renumeraciones, colisiones y decisiones; no toca el disco', () => {
  const d = conApp(raiz());
  const antes = r(d, 'apps/obs/ESTADO.md');
  const p = mg.planConsolidar(d, 'obs', { desplazamiento: 100, origen: { org: 'acme-org', repo: 'obs' } });
  assert.strictEqual(p.clave, 'OBS');
  assert.deepStrictEqual(p.renumeraciones.requisitos, [{ de: 'REQ-01', a: 'REQ-101' }, { de: 'REQ-02', a: 'REQ-102' }]);
  assert.deepStrictEqual(p.renumeraciones.riesgos, [{ de: 'R-01', a: 'R-101' }, { de: 'R-02', a: 'R-102' }]);
  assert.strictEqual(p.historico.a, 'gestion/historico/ESTADO-OBS-obs.md');
  const dest = p.movimientos.map((m) => m.a).sort();
  assert.ok(dest.includes('documentos/funcional/f.md'));
  assert.ok(dest.includes('documentos/ref.md'));
  assert.ok(dest.includes('fuentes/nota.txt'));
  assert.ok(dest.includes('gestion/decisions/2026-01-01-uso-kv.md'));
  assert.ok(!dest.some((x) => /tareas|risks|requisitos/.test(x)), 'tareas se quedan; risks y requisitos se fusionan');
  assert.ok(p.avisos.some((a) => /tareas/.test(a)), 'avisa de que gestion/tareas no se mueve');
  assert.ok(p.decisiones.some((x) => x.id === 'fusion-faseo:obs'), 'la fusion de faseos es una decision, no se hace sola');
  assert.strictEqual(r(d, 'apps/obs/ESTADO.md'), antes, 'el plan no escribe');
  assert.ok(!hay(d, 'gestion/historico'));
});

test('planConsolidar: un documento que choca (misma ruta o mismo doc_id) es colision y decision, no se pisa', () => {
  const d = conApp(raiz());
  w(d, 'documentos/ref.md', '---\ndoc_id: RAIZ-ARQ-001\n---\ndistinto\n');
  w(d, 'documentos/otro/dup.md', '---\ndoc_id: OBS-FUN-001\n---\nmismo id en otra ruta\n');
  const p = mg.planConsolidar(d, 'obs', { desplazamiento: 100 });
  assert.ok(p.colisiones.some((c) => c.rel === 'documentos/ref.md'));
  assert.ok(p.colisiones.some((c) => c.rel === 'documentos/funcional/f.md' && /doc_id/.test(c.motivo)));
  assert.ok(p.decisiones.some((x) => x.id === 'duplicado:documentos/ref.md'));
  assert.ok(!p.movimientos.some((m) => m.a === 'documentos/ref.md'));
});

test('aplicarConsolidar: mueve conservando doc_id, fusiona RAID y requisitos renumerados y archiva el ESTADO', () => {
  const d = conApp(raiz());
  const p = mg.planConsolidar(d, 'obs', { desplazamiento: 100, origen: { org: 'acme-org', repo: 'obs' } });
  const res = mg.aplicarConsolidar(d, p, { git: false });
  assert.deepStrictEqual(res.errores, []);
  // documentos movidos con su doc_id
  assert.match(r(d, 'documentos/funcional/f.md'), /doc_id: OBS-FUN-001/);
  assert.ok(!hay(d, 'apps/obs/documentos/funcional/f.md'));
  // referencias reescritas en el texto movido, con el issue calificado y el color intacto
  assert.match(r(d, 'documentos/funcional/f.md'), /Cubre REQ-102\. Ver acme-org\/obs#7 y el color #123456\./);
  assert.match(r(d, 'gestion/decisions/2026-01-01-uso-kv.md'), /REQ-101 y R-102/);
  // codigo: solo requisitos
  assert.match(r(d, 'apps/obs/src/index.ts'), /REQ-102 \(ver R-01\)/);
  // fusion en la raiz: lo de la raiz intacto + lo nuevo renumerado
  const risks = r(d, 'gestion/risks.md');
  assert.match(risks, /\| R-01 \| riesgo \| De la raiz/);
  assert.match(risks, /\| R-101 \| riesgo \| Latencia \| M\/A \| Cache \(ver REQ-101\) \| abierto \|/);
  assert.match(risks, /\| R-102 \|/);
  const reqs = r(d, 'gestion/requisitos.md');
  assert.match(reqs, /## REQ-01 · De la raiz/);
  assert.match(reqs, /## REQ-101 · Medir latencia[\s\S]*Texto que enlaza R-101/);
  assert.match(reqs, /## REQ-102 · Panel/);
  // ESTADO archivado, renumerado, con resumen de fases cerradas; el original de la app desaparece
  const h = r(d, 'gestion/historico/ESTADO-OBS-obs.md');
  assert.match(h, /Fase 1 · Cimientos — done/);
  assert.match(h, /REQ-102, riesgo R-101/);
  assert.match(h, /FARO · histórico/);
  assert.ok(!hay(d, 'apps/obs/ESTADO.md'));
  // el ESTADO raiz no se toca (la fusion de faseos es una decision)
  assert.match(r(d, 'ESTADO.md'), /iniciativa: Raiz/);
  // tareas se quedan donde estan
  assert.ok(hay(d, 'apps/obs/gestion/tareas/7.json'));
});

test('integridad: tras consolidar no queda ninguna referencia colgante', () => {
  const d = conApp(raiz());
  const p = mg.planConsolidar(d, 'obs', { desplazamiento: 100 });
  mg.aplicarConsolidar(d, p, { git: false });
  assert.deepStrictEqual(mg.referenciasColgantes(d, ['gestion', 'documentos']), []);
  // y detecta una colgante de verdad
  w(d, 'documentos/malo.md', 'Cubre REQ-777 y R-888\n');
  assert.deepStrictEqual(mg.referenciasColgantes(d, ['documentos']).sort(), ['REQ-777', 'R-888'].sort());
});

test('aplicarConsolidar es idempotente: repetirlo no duplica nada', () => {
  const d = conApp(raiz());
  mg.aplicarConsolidar(d, mg.planConsolidar(d, 'obs', { desplazamiento: 100 }), { git: false });
  const risks = r(d, 'gestion/risks.md'); const reqs = r(d, 'gestion/requisitos.md');
  const p2 = mg.planConsolidar(d, 'obs', { desplazamiento: 100 });
  assert.ok(p2.yaConsolidado);
  mg.aplicarConsolidar(d, p2, { git: false });
  assert.strictEqual(r(d, 'gestion/risks.md'), risks);
  assert.strictEqual(r(d, 'gestion/requisitos.md'), reqs);
});

test('unificar: .gitignore (anclados con prefijo), .node-version y allowBuilds en la raiz', () => {
  const d = conApp(raiz());
  const p = mg.planConsolidar(d, 'obs', { desplazamiento: 100 });
  assert.deepStrictEqual(p.unificar.gitignore, ['/apps/obs/dist', '.wrangler']);
  assert.deepStrictEqual(p.unificar.allowBuilds, ['sharp']);
  mg.aplicarConsolidar(d, p, { git: false });
  assert.strictEqual(r(d, '.gitignore'), 'node_modules\ndist\n/apps/obs/dist\n.wrangler\n');
  assert.ok(!hay(d, 'apps/obs/.gitignore'));
  assert.ok(!hay(d, 'apps/obs/.node-version'), 'igual que la raiz: se quita');
  const ws = r(d, 'pnpm-workspace.yaml');
  assert.match(ws, /esbuild: true/); assert.match(ws, /sharp: true/);
  assert.ok(!hay(d, 'apps/obs/pnpm-workspace.yaml'));
});

test('unificar: .node-version distinta es una decision y no se toca', () => {
  const d = conApp(raiz());
  w(d, 'apps/obs/.node-version', '20\n');
  const p = mg.planConsolidar(d, 'obs', { desplazamiento: 100 });
  assert.ok(p.decisiones.some((x) => x.id === 'node-version'));
  mg.aplicarConsolidar(d, p, { git: false });
  assert.strictEqual(r(d, '.node-version'), '22\n');
  assert.ok(hay(d, 'apps/obs/.node-version'));
});

test('siguienteDesplazamiento: +100, +200… segun las apps con gestion propia', () => {
  assert.strictEqual(mg.siguienteDesplazamiento([]), 100);
  assert.strictEqual(mg.siguienteDesplazamiento([100]), 200);
  assert.strictEqual(mg.siguienteDesplazamiento([100, 300]), 400);
});

// ---- symlinks: nada fuera de la raiz se lee ni se mueve ----
const sePuedeSymlink = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-sl-'));
  try { fs.writeFileSync(path.join(d, 'a'), 'x'); fs.symlinkSync(path.join(d, 'a'), path.join(d, 'l')); return true; } catch { return false; }
})();

test('leerSeguro (logica pura, lstat simulado): rechaza enlaces, no-ficheros, gigantes y escapes', () => {
  const fake = (st, real) => ({ lstatSync: () => st, realpathSync: (p) => real(p), readFileSync: () => 'CONTENIDO' });
  const ok = { isSymbolicLink: () => false, isFile: () => true, size: 5 };
  const id = (p) => p;
  assert.strictEqual(mg.leerSeguro('/r/a.md', '/r', fake(ok, id)), 'CONTENIDO');
  assert.strictEqual(mg.leerSeguro('/r/a.md', '/r', fake({ ...ok, isSymbolicLink: () => true }, id)), null);
  assert.strictEqual(mg.leerSeguro('/r/a.md', '/r', fake({ ...ok, isFile: () => false }, id)), null);
  assert.strictEqual(mg.leerSeguro('/r/a.md', '/r', fake({ ...ok, size: 99999999 }, id)), null);
  assert.strictEqual(mg.leerSeguro('/r/a.md', '/r', fake(ok, (p) => (p === '/r' ? '/r' : '/fuera/a.md'))), null, 'realpath fuera de la raiz');
});

test('symlinks reales: ESTADO.md y carpetas enlazadas no se leen ni se mueven', { skip: sePuedeSymlink ? false : 'esta maquina no puede crear symlinks sin privilegios' }, () => {
  const d = raiz(); const fuera = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-fuera-'));
  w(fuera, 'secreto.md', 'TOKEN=abc REQ-01'); w(fuera, 'dir/x.md', 'REQ-02');
  w(d, 'apps/obs/package.json', '{}');
  fs.symlinkSync(path.join(fuera, 'secreto.md'), path.join(d, 'apps/obs/ESTADO.md'));
  fs.symlinkSync(path.join(fuera, 'dir'), path.join(d, 'apps/obs/documentos'), 'junction');
  const g = mg.leerGestion(path.join(d, 'apps/obs'));
  assert.strictEqual(g.estado, false); assert.deepStrictEqual(g.fases, []);
  const p = mg.planConsolidar(d, 'obs', { desplazamiento: 100 });
  assert.deepStrictEqual(p.movimientos, []);
  mg.aplicarConsolidar(d, p, { git: false });
  assert.ok(hay(fuera, 'secreto.md') && hay(fuera, 'dir/x.md'), 'lo de fuera sigue donde estaba');
  assert.ok(!hay(d, 'gestion/historico'));
});

test('operaciones.dentro rechaza rutas cuyo padre real escapa de la raiz', { skip: sePuedeSymlink ? false : 'sin permiso para symlinks' }, () => {
  const d = raiz(); const fuera = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-fuera-'));
  fs.symlinkSync(fuera, path.join(d, 'enlace'), 'junction');
  const op = mg.operaciones(d, false);
  assert.throws(() => op.dentro('enlace/x.md'), /fuera de la ra/);
  assert.doesNotThrow(() => op.dentro('gestion/nuevo.md'));
});
