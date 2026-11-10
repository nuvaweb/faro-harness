// lib/gates-comandos.js — COMO se lanza cada gate pesado (#182). Una sola decision, sin tocar nunca un comando
// que no reconoce:
//
//   · vitest / jest SIEMPRE en modo `run` (nunca watch) y con workers limitados, pero SOLO si el script del
//     package.json tiene una forma reconocida (`vitest`, `vitest run …`, `jest …` con argumentos simples). Un script
//     desconocido (`vitest run && otra-cosa`, redirecciones, variables, comillas…) se lanza TAL CUAL con
//     `<gestor> run <script>`; aun asi CI=true y la entrada cerrada (sin TTY) impiden que un vitest suelto se quede
//     en modo watch.
//   · tsc: `tsc --noEmit` / `tsc -p <ruta>` (formas reconocidas) pasan a `--incremental --tsBuildInfoFile <cache>`.
//     Se lanza con el `tsc` de typescript de la propia app (node directo, sin shell); si no se resuelve, como siempre.
//
// SEGURIDAD: el texto del script es DATO del repo: solo se reconoce si cumple un patron cerrado; el resultado
// son argumentos de execFile, nunca una cadena de shell.
'use strict';

const crypto = require('crypto');
const path = require('path');
const G = require('./gobernador.js');

const RE_META = /[&|;<>()$`\\"'*?{}[\]!#~%^\n\r]/;
const RE_TOKEN = /^[\w@.\/=:,+-]+$/;
const RE_NOMBRE = /^[A-Za-z0-9:_.-]{1,60}$/;
const WATCH_VITEST = new Set(['watch', '--watch', '-w', '--watch=true']);
const WATCH_JEST = new Set(['--watch', '--watchAll', '--watchAll=true', '--watch=true']);   // en jest `-w` es --maxWorkers

const tokens = (script) => {
  const t = String(script == null ? '' : script).trim();
  if (!t || t.length > 300 || RE_META.test(t)) return null;
  const parts = t.split(/\s+/);
  return parts.every((p) => RE_TOKEN.test(p)) ? parts : null;
};
/** `<gestor> exec <bin> …` sin shell. bun y otros: no reconocido (null). */
function ejecutarBin(pm, bin, args) {
  if (pm === 'pnpm') return { cmd: 'pnpm', args: ['exec', bin, ...args] };
  if (pm === 'npm') return { cmd: 'npm', args: ['exec', '--no', '--', bin, ...args] };
  if (pm === 'yarn') return { cmd: 'yarn', args: ['run', bin, ...args] };
  return null;
}
const pase = (nombre) => ({ cmd: null, args: null, env: nombre === 'test' ? { CI: 'true' } : {}, nota: '', reconocido: null });

function vitest(pm, rest, maxWorkers) {
  const sin = rest.filter((t) => !WATCH_VITEST.has(t));
  const conRun = sin.includes('run') || sin.includes('--run') ? sin : ['run', ...sin];
  const args = [...conRun];
  if (!args.some((t) => /^--pool(=|$)/.test(t))) args.push('--pool=forks');
  if (!args.some((t) => /^--(maxWorkers|max-workers|poolOptions|no-file-parallelism|fileParallelism)/.test(t))) args.push(`--maxWorkers=${maxWorkers}`);
  const r = ejecutarBin(pm, 'vitest', args);
  return r && { ...r, nota: `vitest en modo run, pool de forks, máx. ${maxWorkers} workers` };
}
function jest(pm, rest, maxWorkers) {
  const args = rest.filter((t) => !WATCH_JEST.has(t));
  if (!args.includes('--ci')) args.push('--ci');
  if (!args.some((t) => /^(--maxWorkers|--max-workers|-w$|--runInBand|-i$)/.test(t))) args.push(`--maxWorkers=${maxWorkers}`);
  const r = ejecutarBin(pm, 'jest', args);
  return r && { ...r, nota: `jest en modo ci, máx. ${maxWorkers} workers` };
}
function tsc(rest, cwd, env) {
  const args = [];
  let noEmit = false; let proyecto = null;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '--noEmit') { noEmit = true; continue; }
    if ((t === '-p' || t === '--project') && rest[i + 1] && /^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/.test(rest[i + 1]) && !rest[i + 1].split('/').includes('..')) { proyecto = rest[++i]; continue; }
    return null;                                           // cualquier otra opcion (--watch, -b, --outDir…): no se toca
  }
  if (!noEmit && !proyecto) return null;
  let tscJs;
  try { tscJs = require.resolve('typescript/bin/tsc', { paths: [cwd] }); } catch { return null; }
  const dir = G.preparar(env, 'tsc');
  if (!dir) return null;
  const info = path.join(dir, `${crypto.createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 20)}-${noEmit ? 'ne' : 'em'}-${crypto.createHash('sha1').update(String(proyecto || '')).digest('hex').slice(0, 8)}.tsbuildinfo`);
  if (noEmit) args.push('--noEmit');
  if (proyecto) args.push('-p', proyecto);
  args.push('--incremental', '--tsBuildInfoFile', info);
  return { cmd: process.execPath, args: [tscJs, ...args], nota: 'tsc incremental (tsbuildinfo en la caché del usuario)' };
}

/**
 * Como lanzar el gate `nombre` de una app.
 * op: { pm, nombre, script (texto del package.json o undefined), cwd (absoluto), env, maxWorkers }
 * → { cmd, args, env (extra), nota, reconocido: 'vitest'|'jest'|'tsc'|null }
 */
function comandoGate(op) {
  const nombre = String(op.nombre);
  const env = op.env || process.env;
  const pm = op.pm;
  const maxWorkers = Number.isInteger(op.maxWorkers) && op.maxWorkers >= 1 && op.maxWorkers <= 8 ? op.maxWorkers : 2;
  const porDefecto = { cmd: pm, args: ['run', nombre], env: nombre === 'test' ? { CI: 'true' } : {}, nota: '', reconocido: null };
  if (!RE_NOMBRE.test(nombre)) return null;
  const t = tokens(op.script);
  if (!t) return porDefecto;
  let r = null; let reconocido = null;
  if (nombre === 'test' || /^test[:.]/.test(nombre)) {
    if (t[0] === 'vitest') { r = vitest(pm, t.slice(1), maxWorkers); reconocido = 'vitest'; }
    else if (t[0] === 'jest') { r = jest(pm, t.slice(1), maxWorkers); reconocido = 'jest'; }
  } else if (t[0] === 'tsc' && (nombre === 'typecheck' || /^type-?check|^check-types|^tsc/.test(nombre))) {
    r = tsc(t.slice(1), op.cwd, env); reconocido = 'tsc';
  }
  if (!r) return porDefecto;
  return { cmd: r.cmd, args: r.args, env: nombre.startsWith('test') ? { CI: 'true' } : {}, nota: r.nota, reconocido };
}

/** Forma "estable" del gate para la clave de cache: no depende de rutas de la maquina (tsbuildinfo, tsc.js). */
function formaEstable(op, cmd) {
  const t = tokens(op.script);
  return [cmd.reconocido || 'script', op.pm, String(op.nombre), t ? t.join(' ') : String(op.script == null ? '' : op.script).slice(0, 300), ...(cmd.reconocido ? [`mw=${op.maxWorkers || 2}`] : [])];
}

module.exports = { comandoGate, formaEstable, tokens };
