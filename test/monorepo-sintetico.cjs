// Generador de un monorepo pnpm SINTETICO y grande para medir 'validate' (#167). Determinista: mismo
// resultado para los mismos parametros. Crea una instancia FARO valida (ESTADO.md, funcional, cambios),
// N apps con M ficheros .ts que se importan en cadena, un paquete compartido, ficheros generados y
// una carpeta node_modules ignorada, y lo deja commiteado en un repo git.
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawnSync } = require('child_process');

const escribir = (dir, rel, txt) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, txt);
};

const ESTADO = `---
iniciativa: Sintetico
fases_total: 1
fase_actual: 1
owner: t
funcional: documentos/funcional/f.md
---

### Fase 1 · Una — in_progress
Lo que trae esta fase.
Objetivo: 2026-12-01
- [ ] #1 · Algo — @t
`;

function generar({ apps = 8, ficheros = 150, cambios = 30, commits = 0, dir } = {}) {
  dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'faro-sintetico-'));
  escribir(dir, 'ESTADO.md', ESTADO);
  escribir(dir, 'documentos/funcional/f.md', '# F\n## Fuera de alcance\n- Nada mas\n');
  escribir(dir, 'package.json', JSON.stringify({ name: 'mono', private: true }));
  escribir(dir, 'pnpm-workspace.yaml', 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  escribir(dir, '.gitignore', 'node_modules/\ndist/\n');
  for (let a = 0; a < apps; a++) {
    const app = `apps/app${a}`;
    escribir(dir, `${app}/package.json`, JSON.stringify({ name: `mono-app${a}`, version: '1.0.0', scripts: { typecheck: 'tsc --noEmit', lint: 'eslint .', test: 'vitest run', build: 'tsc' }, devDependencies: { wrangler: '^4.40.0' } }));
    escribir(dir, `${app}/wrangler.jsonc`, `{ "name": "mono-app${a}", "main": "src/index.ts" }\n`);
    escribir(dir, `${app}/CHANGELOG.md`, '# Changelog\n');
    for (let f = 0; f < ficheros; f++) {
      const sig = f + 1 < ficheros ? `import { f${f + 1} } from './m${f + 1}';\n` : '';
      const cuerpo = Array.from({ length: 40 }, (_, i) => `// linea ${i}`).join('\n');
      escribir(dir, `${app}/src/m${f}.ts`, `${sig}export const f${f} = ${f};\n${cuerpo}\n`);
    }
    escribir(dir, `${app}/src/index.ts`, "import { f0 } from './m0';\nexport default { f0 };\n");
    escribir(dir, `${app}/src/routeTree.gen.ts`, '// generado\nexport const r = 1;\n');
    escribir(dir, `${app}/node_modules/dep/index.js`, 'module.exports = 1;\n');
  }
  for (let f = 0; f < ficheros; f++) escribir(dir, `packages/shared/src/s${f}.ts`, `export const s${f} = ${f};\n`);
  for (let c = 0; c < cambios; c++) {
    escribir(dir, `gestion/cambios/changes/c${c}/proposal.md`,
      `---\ntitulo: Cambio ${c}\ndescripcion: sintetico\nestado: borrador\nfase: 1\ndecision: 2026-01-01-d.md\nowner: t\nresponsable: t@t\ntareas: []\n---\n\n## Por qué\nx\n`);
    escribir(dir, `gestion/cambios/changes/c${c}/specs/s${c}/spec.md`, `# S${c}\n\n## Requisitos AÑADIDOS\n\n### Requisito: R${c}\n\nDEBE hacer algo.\n\n#### Escenario: e\n\n- CUANDO a\n- ENTONCES b\n`);
  }
  escribir(dir, 'gestion/decisions/2026-01-01-d.md', ['# D', '', '## Contexto', 'x', '', '## Decisión', 'x', '', '## Consecuencias', 'x', ''].join('\n'));
  const declaradas = {};
  for (let a = 0; a < apps; a++) declaradas[`app${a}`] = { rol: `App ${a}`, equipo: 'desarrollo' };
  escribir(dir, '.faro.json', JSON.stringify({ teams: ['desarrollo'], monorepo: { apps: declaradas } }));
  const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 's@s'); g('config', 'user.name', 'S'); g('config', 'commit.gpgsign', 'false');
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  g('branch', 'develop');
  for (let i = 0; i < commits; i++) {
    fs.appendFileSync(path.join(dir, `apps/app${i % apps}/src/m${i % ficheros}.ts`), `// c${i}\n`);
    g('commit', '-q', '-am', `c${i}`);
  }
  return dir;
}

module.exports = { generar };
if (require.main === module) console.log(generar({ apps: +process.argv[2] || 8, ficheros: +process.argv[3] || 150 }));
