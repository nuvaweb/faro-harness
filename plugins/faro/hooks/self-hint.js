// self-hint.js — SessionStart: publica la ruta REAL del motor del plugin.
// El estandar FARO se documenta con 'node .claude/hooks/harness.js <cmd>' (forma historica en repos
// con copia local). Con el motor distribuido como PLUGIN, la ruta correcta es la de la cache del
// plugin: este hook la inyecta en el contexto de sesion para que el agente use SIEMPRE la buena.
'use strict';
const fs = require('fs');
const path = require('path');
const root = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();
// Si el repo aun lleva la copia legada, ELLA gobierna (harness.js se auto-inhibe en LEGACY_COPY):
// omitir el mensaje por completo, no imprimirlo con un matiz al final — evita el aviso
// contradictorio ("usa siempre esta ruta" vs "el plugin esta INHIBIDO, gobierna la copia").
if (fs.existsSync(path.join(projectRoot, '.claude', 'hooks', 'harness.js'))) process.exit(0);
const bin = path.join(root, 'hooks', 'harness.js').replace(/\\/g, '/');
// VERSION ACTIVA + COHERENCIA DE CACHE: publica que version del motor esta gobernando ESTA sesion
// y detecta si la cache tiene una version MAS NUEVA sin activar (caso real: sesion en 0.4.31 con
// 0.8.5 ya descargada). Sin esta senal, un motor viejo produce exigencias ya corregidas y nadie lo ve.
let version = null;
try { version = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version || null; } catch {}
let avisoCache = '';
try {
  const parent = path.dirname(root); // cache/<marketplace>/<plugin>/
  const semver = (v) => String(v).split('.').map((n) => Number(n) || 0);
  const newer = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
  if (version && /[\\/]cache[\\/]/i.test(root)) {
    const dirs = fs.readdirSync(parent, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    const masNueva = dirs.filter((d) => /^\d+\.\d+\.\d+$/.test(d) && newer(d, version)).sort().pop();
    if (masNueva) avisoCache = `\n⚠ CACHE DESFASADA: esta sesion usa el motor v${version} pero la cache ya tiene v${masNueva}. Di al usuario que ejecute 'claude plugin update faro@faro-marketplace' y REINICIE la sesion — hasta entonces las reglas que ves pueden estar corregidas en la version nueva.`;
  }
} catch {}
process.stdout.write(
  `HARNESS (plugin faro${version ? ` v${version}` : ''}): el motor vive en el plugin. Cuando cualquier doc/skill diga ` +
  `'node .claude/hooks/harness.js <cmd>' usa: node "${bin}" <cmd>${avisoCache}\n`,
);
