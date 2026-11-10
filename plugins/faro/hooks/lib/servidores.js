// lib/servidores.js — ¿esta orden levanta un SERVIDOR DE DESARROLLO? (#177)
//
// Regla de la casa: el agente NO levanta servidores de desarrollo (vite, pnpm/npm run dev, wrangler dev,
// next dev, serve…). Entrega el comando exacto y el puerto, y el usuario lo lanza en una terminal aparte:
// un servidor que arranca el agente queda vivo tras el turno, ocupa un puerto y memoria, y nadie lo ve.
// pre-bash lo traduce en un `ask` (confirmacion humana), nunca en un bloqueo. Tests, builds, lint y
// typecheck NO se tocan.
//
// ES UNA RED DE SEGURIDAD, NO UNA FRONTERA (misma logica que lib/alcance.js): analiza solo el TEXTO de la
// orden. NO ve: `run_in_background` (solo se ve el texto del comando), scripts propios (`node server.js`,
// `bash arranca.sh`), interpretes (`node -e`, `python -c`), alias o funciones, ni un servidor lanzado por
// otro programa (un test que arranca uno). Ante duda razonable FALLA CERRADO (ask): un orden que no se
// parsea del todo pero nombra un servidor conocido, `start`/`Start-Process`/`nohup`/`&`, shells anidados
// (`bash -c`, `cmd /c`, `powershell -Command`) y envoltorios (`sudo`, `timeout`, `cross-env`, `npx`…) se
// desenvuelven y se analizan. La frontera real son los permisos de Claude Code.
//
// No duplica el parser: reutiliza `trocear` de lib/alcance.js (comillas, escapes, heredocs, sustituciones).
'use strict';

const path = require('path');

const MENSAJE = 'Servidor de desarrollo detectado: dame el comando y el puerto; lo levantas tú en una terminal aparte.';

const MAX_TEXTO = 50000;
const MAX_PROF = 5;

// Programas que solo lanzan a otro: se mira lo que viene detras (en cualquier posicion, porque llevan
// opciones con valor: `sudo -u x vite`, `timeout 60 npm run dev`).
const ENVOLTORIOS = new Set(['nohup', 'time', 'exec', 'command', 'builtin', 'sudo', 'doas', 'env', 'setsid', 'call', 'start', 'cross-env', 'dotenv',
  'nice', 'ionice', 'stdbuf', 'timeout', 'watch', 'unbuffer', 'busybox', 'npx', 'pnpx', 'bunx', 'xargs', 'concurrently', 'npm-run-all', 'run-p', 'run-s']);
const LANZADORES_PS = new Set(['start-process', 'saps']);           // PowerShell: los argumentos viajan como lista
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell', 'cmd']);
const EVALUADORES = new Set(['iex', 'invoke-expression', 'eval', 'invoke-command', 'icm']);
const GESTORES = new Set(['npm', 'pnpm', 'yarn', 'bun']);
// Subcomandos de gestor que NUNCA arrancan un servidor.
const NO_EJECUTA = new Set(['test', 't', 'tst', 'build', 'lint', 'typecheck', 'tsc', 'install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade',
  'publish', 'audit', 'init', 'create', 'pack', 'ci', 'outdated', 'version', 'config', 'cache', 'login', 'logout', 'whoami', 'link', 'unlink', 'prune', 'rebuild',
  'dedupe', 'format', 'check', 'list', 'ls', 'why', 'view', 'info', 'help', 'store', 'patch', 'fetch']);
const ES_SCRIPT = /^(dev|start|serve|develop|preview)(:[\w.-]+)?$/i;

// Herramienta -> subcomandos que levantan el servidor ('*' = cualquier invocacion salvo ayuda/build).
const SUBCOMANDOS = {
  next: ['dev', 'start', undefined], nuxt: ['dev', 'preview'], nuxi: ['dev', 'preview'], astro: ['dev', 'preview'], remix: ['dev'],
  'react-scripts': ['start'], ng: ['serve', 's'], wrangler: ['dev'], storybook: ['dev'], expo: ['start'], gatsby: ['develop', 'serve'],
  vitepress: ['dev', 'serve', 'preview'], docusaurus: ['start', 'serve'], hugo: ['server'], jekyll: ['serve', 's'], rails: ['s', 'server'],
  'svelte-kit': ['dev', 'preview'], 'vue-cli-service': ['serve'], webpack: ['serve', 's'], flask: ['run'], deno: ['task'],
};
const SIEMPRE = new Set(['nodemon', 'http-server', 'live-server', 'browser-sync', 'serve', 'webpack-dev-server', 'ts-node-dev', 'start-storybook', 'uvicorn', 'gunicorn', 'miniflare']);
const VITE_NO = new Set(['build', 'optimize']);
const AYUDA = /^(--help|-h|--version|-v|-V)$/;
const TODAS = new Set([...Object.keys(SUBCOMANDOS), ...SIEMPRE, 'vite']);

const nombre = (w) => path.basename(String(w).replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat|ps1|js|mjs|cjs)$/, '');
const esAsignacion = (w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
const limpiarPs = (w) => String(w).replace(/[@(),'"]/g, ' ').trim();

function servidorDeHerramienta(n, args) {
  if (args.some((a) => AYUDA.test(a))) return null;
  const primero = args.find((a) => !a.startsWith('-'));
  if (n === 'vite') return VITE_NO.has(primero) ? null : n;
  if (SIEMPRE.has(n)) return n;
  if (n === 'wrangler') return primero === 'dev' || (primero === 'pages' && args.includes('dev')) ? n : null;
  if (n === 'deno') return primero === 'task' && args.some((a) => ES_SCRIPT.test(a)) ? n : null;
  const subs = SUBCOMANDOS[n];
  if (subs && subs.includes(primero)) return n;
  return null;
}

function analizarPalabras(ws, prof) {
  if (prof > MAX_PROF || !ws.length) return null;
  let i = 0;
  while (i < ws.length && esAsignacion(ws[i])) i++;
  ws = ws.slice(i);
  if (!ws.length) return null;
  const n = nombre(ws[0]);
  const resto = ws.slice(1);

  if (LANZADORES_PS.has(n)) {                                        // Start-Process npm -ArgumentList "run dev"
    const limpio = resto.filter((w) => !/^-[A-Za-z]/.test(w)).map(limpiarPs).join(' ');
    return detectarTexto(limpio, prof + 1);
  }
  if (SHELLS.has(n)) {                                                // bash -c "…", cmd /c "…", pwsh -Command "…"
    if (resto.some((a) => /^-(enc|ec|encodedcommand)$/i.test(a))) {
      const b64 = resto[resto.findIndex((a) => /^-(enc|ec|encodedcommand)$/i.test(a)) + 1] || '';
      let txt = ''; try { txt = Buffer.from(b64, 'base64').toString('utf16le'); } catch {}
      return txt ? detectarTexto(txt, prof + 1) : n;                  // ilegible: ante la duda, confirmar
    }
    const utiles = resto.filter((a) => !/^(-{1,2}[A-Za-z]+|\/[A-Za-z])$/.test(a));
    return detectarTexto(utiles.join(' '), prof + 1);
  }
  if (EVALUADORES.has(n)) return detectarTexto(resto.map(limpiarPs).join(' '), prof + 1);

  if (ENVOLTORIOS.has(n)) {
    if ((n === 'command' || n === 'builtin') && resto.some((a) => /^-[vV]$/.test(a))) return null;   // command -v vite: solo consulta
    for (let k = 0; k < resto.length && k < 8; k++) {
      if (resto[k].startsWith('-') || /^\/[A-Za-z]$/.test(resto[k]) || /^\d+[smhd]?$/.test(resto[k]) || resto[k] === '""') continue;
      const r = analizarPalabras(resto.slice(k), prof + 1);
      if (r) return r;
    }
    return null;
  }

  if (GESTORES.has(n)) {
    const idx = resto.indexOf('--');
    const antes = idx < 0 ? resto : resto.slice(0, idx);
    for (let k = 0; k < antes.length; k++) {
      const w = antes[k];
      if (w.startsWith('-')) continue;
      if (NO_EJECUTA.has(w.toLowerCase())) return null;
      if (ES_SCRIPT.test(w)) return n + ' ' + w.toLowerCase().split(':')[0];
      if (TODAS.has(nombre(w))) { const r = analizarPalabras(antes.slice(k).concat(idx < 0 ? [] : resto.slice(idx + 1)), prof + 1); if (r) return r; }
    }
    return null;
  }

  if (/^(node|nodejs|tsx|ts-node|bun|deno)$/.test(n) && n !== 'bun' && n !== 'deno') {   // node …/vite/bin/vite.js
    const k = resto.findIndex((a) => !a.startsWith('-'));
    if (k >= 0 && TODAS.has(nombre(resto[k]))) return analizarPalabras([nombre(resto[k]), ...resto.slice(k + 1)], prof + 1);
    return null;
  }
  if (n === 'deno') return servidorDeHerramienta('deno', resto);
  if (/^(python|python3|py)$/.test(n)) { const m = resto.indexOf('-m'); return m >= 0 && resto[m + 1] === 'http.server' ? 'http.server' : null; }
  if (n === 'php') return resto.includes('-S') ? 'php -S' : null;
  return TODAS.has(n) ? servidorDeHerramienta(n, resto) : null;
}

const RAIZ_DURA = /\b(vite|nodemon|http-server|live-server|webpack-dev-server|wrangler\s+dev|next\s+(dev|start)|(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve))\b/i;

function detectarTexto(texto, prof) {
  const t = String(texto || '').slice(0, MAX_TEXTO);
  if (!t.trim()) return null;
  const { trocear } = require('./alcance.js');
  const items = trocear(t);
  for (const it of items) {
    if (it.t === 'sub') { const r = detectarTexto(it.cmd, prof + 1); if (r) return r; continue; }
    if (it.t !== 'seg') continue;
    const ws = [];
    for (let k = 0; k < it.words.length; k++) {
      const w = it.words[k];
      if (w.redir) { k++; continue; }                                // el destino de una redireccion no es un argumento
      ws.push(w.v);
    }
    const r = analizarPalabras(ws, prof);
    if (r) return r;
  }
  if (items.incompleto && RAIZ_DURA.test(t)) return 'orden-incompleta';   // no se parsea del todo y nombra un servidor: confirmar
  return null;
}

/** → { herramienta } si la orden levanta un servidor de desarrollo; null si no. Nunca lanza. */
function detectarServidor(cmd) {
  try {
    if (typeof cmd !== 'string' || !cmd.trim()) return null;
    const r = detectarTexto(cmd, 0);
    return r ? { herramienta: r } : null;
  } catch { return typeof cmd === 'string' && RAIZ_DURA.test(cmd) ? { herramienta: 'no-analizable' } : null; }
}

module.exports = { detectarServidor, MENSAJE };
