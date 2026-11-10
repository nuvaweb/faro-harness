#!/usr/bin/env node
// code.js — capa de CODIGO del harness (MODULO SEPARADO, patron clickup.js).
// Lo consume harness.js (subcomandos 'gates' | 'infra' | 'deps') y los hooks (lineas de sesion).
// Sin dependencias: solo fs/child_process nativos.
//
// STACK-AWARE (un mismo harness sirve a doc/worker/app):
//   - modo 'cloudflare'  -> hay wrangler.jsonc/.json/.toml: gates typecheck+test+deploy dry-run; infra = bindings wrangler.
//   - modo 'generic'     -> hay package.json sin wrangler:  gates = scripts typecheck/test/lint/build; infra = generica.
//   - modo 'monorepo'    -> .faro.json declara 'monorepo' (#129): varias apps en un workspace con gestion unica
//                           en la raiz. Gates POR APP (#130): los de las apps que toca el cambio (o todas al
//                           publicar), cada uno en la carpeta de su app; deps y CI conscientes del workspace.
//   - modo 'none'        -> sin package.json (repo documental): gates/infra/deps DORMIDOS (no fallan, avisan).
//
// Asi el harness es IDENTICO en los tres templates; lo que no aplica queda inactivo, no ausente.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const appsLib = require('./apps.js');
const { esMonorepo } = appsLib;
const X = require('./ejecutar-pesado.js');      // #182: unico punto por el que pasan los gates pesados
const CG = require('./cache-gates.js');
const CMD = require('./gates-comandos.js');
const DRY = require('./dry-run.js');

// 'ctx' es OPCIONAL y llega como segundo parametro (no como objeto unico) para no romper a quien ya
// llamaba con ROOT a secas. Hoy solo trae 'forge' — el detector de la forja, que hace falta para
// saber cual es el remoto de este repo y poder decir QUE url declarar, no solo que falta.
module.exports = function codeModule(ROOT, ctx = {}) {
  const readFileSafe = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return null; } };

  let _pkg;
  const readPkg = () => {
    if (_pkg !== undefined) return _pkg;
    const text = readFileSafe('package.json');
    if (!text) return (_pkg = null);
    try { return (_pkg = JSON.parse(text)); } catch { return (_pkg = null); }
  };
  const pkgManager = () => {
    if (fs.existsSync(path.join(ROOT, 'pnpm-lock.yaml')) || fs.existsSync(path.join(ROOT, 'pnpm-workspace.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(ROOT, 'yarn.lock'))) return 'yarn';
    const pkg = readPkg();
    if (pkg && typeof pkg.packageManager === 'string') { const m = pkg.packageManager.match(/^(pnpm|yarn|npm)/); if (m) return m[1]; }
    return 'npm';
  };
  const hasScript = (name) => { const pkg = readPkg(); return Boolean(pkg && pkg.scripts && pkg.scripts[name]); };

  // ---- Cloudflare (wrangler) ----
  const parseJsonc = (text) => {
    if (!text) return null;
    try {
      const noTrail = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
      return JSON.parse(noTrail);
    } catch { return null; }
  };
  let _wrangler;
  const readWrangler = () => {
    if (_wrangler !== undefined) return _wrangler;
    for (const f of ['wrangler.jsonc', 'wrangler.json']) {
      const text = readFileSafe(f);
      if (text != null) { const cfg = parseJsonc(text); return (_wrangler = { file: f, cfg, raw: text }); }
    }
    const toml = readFileSafe('wrangler.toml');
    if (toml != null) return (_wrangler = { file: 'wrangler.toml', cfg: null, raw: toml });
    return (_wrangler = null);
  };
  const BINDING_KINDS = [
    ['d1_databases', 'D1 (SQL)'], ['kv_namespaces', 'KV'], ['r2_buckets', 'R2'], ['queues', 'Queues'],
    ['durable_objects', 'Durable Objects'], ['vectorize', 'Vectorize'], ['ai', 'Workers AI'],
    ['hyperdrive', 'Hyperdrive'], ['services', 'Service bindings'], ['workflows', 'Workflows'],
    ['containers', 'Containers'], ['browser', 'Browser Rendering'], ['analytics_engine_datasets', 'Analytics Engine'],
    ['secrets_store_secrets', 'Secrets Store'], ['send_email', 'Email'], ['mtls_certificates', 'mTLS'],
    ['vars', 'Vars'], ['assets', 'Static Assets'],
  ];
  const countBinding = (val) => {
    if (val == null) return 0;
    if (Array.isArray(val)) return val.length;
    if (typeof val === 'object') {
      if (Array.isArray(val.bindings)) return val.bindings.length;
      if (Array.isArray(val.producers) || Array.isArray(val.consumers)) return (val.producers || []).length + (val.consumers || []).length;
      if (val.binding) return 1;
      return Object.keys(val).length;
    }
    return 0;
  };
  const REMOTE_ONLY = [
    ['vectorize', 'Vectorize'], ['ai', 'Workers AI'], ['hyperdrive', 'Hyperdrive'], ['browser', 'Browser Rendering'],
    ['send_email', 'Email'], ['secrets_store_secrets', 'Secrets Store'], ['mtls_certificates', 'mTLS'],
  ];
  const remoteBindings = () => { const w = readWrangler(); if (!w || !w.cfg) return []; return REMOTE_ONLY.filter(([k]) => countBinding(w.cfg[k])).map(([, l]) => l); };
  const wranglerPlaceholders = () => {
    const w = readWrangler(); if (!w) return []; const out = [];
    if (/<WORKER_NAME>/.test(w.raw)) out.push('<WORKER_NAME>');
    if (/<COMPATIBILITY_DATE>/.test(w.raw)) out.push('<COMPATIBILITY_DATE>');
    return out;
  };

  // ---- deteccion de stack (AGNOSTICA: node/python/go/rust/java/ruby/php...) ----
  // El template 'app' es neutral: no impone lenguaje; code.js detecta el stack que el usuario trae por su MANIFIESTO.
  const STACK_MANIFESTS = [
    ['node', 'package.json'], ['python', 'pyproject.toml'], ['python', 'requirements.txt'], ['python', 'setup.py'],
    ['go', 'go.mod'], ['rust', 'Cargo.toml'], ['java', 'pom.xml'], ['java', 'build.gradle'],
    ['ruby', 'Gemfile'], ['php', 'composer.json'], ['dotnet', 'global.json'],
  ];
  const detectStack = () => { for (const [s, f] of STACK_MANIFESTS) if (fs.existsSync(path.join(ROOT, f))) return s; return null; };

  // ---- deteccion de modo ----
  // Naturaleza DECLARADA (.faro.json): si es
  // 'documental', el humano dijo "esto son docs" -> codigo DORMIDO aunque haya manifiesto de tooling.
  const declaredNature = () => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, '.faro.json'), 'utf8')).naturaleza || null; } catch {}
    return null;
  };
  const mode = () => {
    const nat = declaredNature();
    if (nat === 'documental') return 'none';
    // Monorepo DECLARADO: manda sobre lo que haya en la raiz (el codigo vive en las apps del workspace).
    if (esMonorepo(ROOT)) return 'monorepo';
    if (readWrangler()) return 'cloudflare';
    if (detectStack()) return 'generic';
    if (nat === 'app' || nat === 'worker') return 'generic'; // declarado como codigo: ayuda desde el dia 1, aunque el manifiesto aun no exista
    return 'none';
  };
  const hasCode = () => mode() !== 'none';
  // 'monorepo' comparte con 'generic' el routing y el playbook de infra (con sus textos propios);
  // gates, deps y CI tienen rama propia POR APP (#130), resuelta antes de llegar aqui.
  const esGenerico = (m) => m === 'generic' || m === 'monorepo';

  // ---- infra ----
  const infraLinesCloudflare = () => {
    const w = readWrangler();
    if (!w.cfg) return [`Infra Cloudflare: ${w.file} presente pero no parseable como JSON (¿toml o sintaxis rara?). Revisa a mano.`];
    const c = w.cfg;
    const name = c.name && !/[<>]/.test(String(c.name)) ? c.name : '(sin nombre)';
    const parts = [];
    for (const [key, label] of BINDING_KINDS) { const n = countBinding(c[key]); if (n) parts.push(`${label}:${n}`); }
    const lines = [`Infra Cloudflare (${w.file}): worker '${name}' · compat ${c.compatibility_date || '(sin fecha)'}` +
      `${c.account_id ? ` · acct ${String(c.account_id).slice(0, 8)}…` : ' · ⚠ SIN account_id'}` +
      `${c.observability && c.observability.enabled ? ' · observability ON' : ' · observability OFF'}` +
      `${c.placement && c.placement.mode ? ` · placement ${c.placement.mode}` : ''}.`];
    lines.push(parts.length ? `Bindings: ${parts.join(' · ')}.` : 'Bindings: ninguno declarado (worker base).');
    const envs = c.env && typeof c.env === 'object' ? Object.keys(c.env) : [];
    lines.push(envs.length
      ? `Entornos wrangler: default (dev) + ${envs.join(', ')}. Recuerda: bindings/vars/secrets NO se heredan (redeclarar por entorno con IDs propios).`
      : 'Entornos wrangler: solo default (dev) — sin env.production declarado (declaralo cuando separes prod).');
    return lines;
  };
  const infraUpgradeHints = () => {
    const w = readWrangler(); if (!w || !w.cfg) return [];
    const c = w.cfg; const hints = [];
    if (c.compatibility_date && !/[<>]/.test(String(c.compatibility_date))) {
      const d = new Date(c.compatibility_date);
      if (!Number.isNaN(d.getTime())) { const meses = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30); if (meses > 6) hints.push(`compatibility_date (${c.compatibility_date}) tiene ~${Math.round(meses)} meses: valora subirla (skill 'wrangler'/'cloudflare') y re-testear.`); }
    }
    if (!c.account_id) hints.push("sin 'account_id' en wrangler config: con VARIAS cuentas Cloudflare wrangler puede desplegar a la EQUIVOCADA. Declara account_id (o exporta CLOUDFLARE_ACCOUNT_ID) para fijar y validar SIEMPRE el destino.");

    // ORIGEN del Worker: de que repo salio lo que esta desplegado.
    //
    // Cloudflare NO tiene campo estandar para esto (verificado en su documentacion de configuracion:
    // existe 'vars' para texto libre y nada mas), asi que la convencion la pone FARO: una var
    // 'REPO_URL'. Sin ella, quien abre el dashboard y ve un worker con un nombre generico no tiene
    // forma de llegar al codigo — y eso duele justo cuando mas prisa hay, mirando un incidente.
    // Como el harness YA sabe cual es el remoto, no se limita a pedirlo: dice cual poner.
    const repoUrlVar = c.vars && (c.vars.REPO_URL || c.vars.GIT_REPO || c.vars.SOURCE_REPO);
    // La url WEB (la que se abre en un navegador), no la de clonado: quien mira el dashboard a las
    // 3 de la mañana quiere pinchar y ver el codigo, no copiar un remoto y clonarlo.
    const remoto = (() => {
      try {
        const f = ctx.forge ? ctx.forge() : null;
        return f && f.host && f.path ? `https://${f.host}/${f.path}` : null;
      } catch { return null; }
    })();
    if (!repoUrlVar) {
      hints.push(`sin 'REPO_URL' en vars de ${w.file}: un worker desplegado no dice de que repo salio, y desde el dashboard no hay forma de llegar al codigo. ` +
        `Anade  "vars": { "REPO_URL": "${remoto || '<url del repo>'}" }` + (remoto ? ' (es tu remoto actual).' : ' — declara el remoto del repo.'));
    } else if (remoto && !String(repoUrlVar).includes(String(remoto).replace(/\.git$/, '').replace(/^https?:\/\//, ''))) {
      // Peor que no tenerla: tenerla MAL. Una URL que apunta a otro repo manda a leer el codigo
      // equivocado, y nadie duda de un dato que esta escrito.
      hints.push(`'REPO_URL' en ${w.file} (${repoUrlVar}) NO coincide con el remoto de este repo (${remoto}): una url que apunta a otro sitio es peor que ninguna, porque nadie duda de lo que esta escrito. Corrigela o explica por que difiere.`);
    }
    if (!(c.observability && c.observability.enabled)) hints.push("observability desactivada: activala ('observability': { 'enabled': true }) para trazas (y usa el MCP cloudflare-observability para leer logs/traces).");
    const flags = Array.isArray(c.compatibility_flags) ? c.compatibility_flags : [];
    if (!flags.includes('nodejs_compat')) hints.push("sin 'nodejs_compat' en compatibility_flags: OJO — vitest-pool-workers lo inyecta en tests (pasan) pero en PRODUCCION fallaria si usas modulos node:*. Anadelo si dependes de APIs de Node (requiere compatibility_date >= 2024-09-23).");
    const pkg = readPkg();
    if (pkg) { const wr = (pkg.devDependencies && pkg.devDependencies.wrangler) || (pkg.dependencies && pkg.dependencies.wrangler); if (wr && /\^?3\./.test(wr)) hints.push(`wrangler ${wr}: hay major 4.x; migra con la skill 'wrangler' (revisa breaking changes) y re-testea. Remote bindings para tests exigen wrangler >= 4.37.`); }
    const rb = remoteBindings();
    if (rb.length) hints.push(`bindings SIN emulacion local (${rb.join(', ')}): no basta con vitest local. Validalos en REMOTO -> marca 'remote: true' en el binding (wrangler >= 4.37, tests/dev con el recurso REAL) o 'wrangler dev --remote'. Etapa autenticada: la aplica el usuario.`);
    return hints;
  };
  const infraLines = () => {
    const m = mode();
    if (m === 'cloudflare') return infraLinesCloudflare();
    if (m === 'monorepo') return ['Infra: monorepo — cada app del workspace declara su propia infra (su wrangler, su despliegue). Apps y rasgos: node .claude/hooks/harness.js apps. Secrets fuera de git.'];
    if (m === 'generic') return ['Infra: proyecto de código genérico (sin Cloudflare/wrangler). Documenta la arquitectura y el despliegue en un doc ARQ (documentos/) y gobierna secrets fuera de git.'];
    return ['Infra: sin código aquí (repo documental) — nada que inspeccionar.'];
  };

  // ---- gates ----
  // Fallos de DEPENDENCIAS/gestor de paquetes que NO son fallos del gate en si: un lint que no llega
  // a ejecutarse porque el gestor aborta antes (caso reportado: pnpm 11 sale con exit 1 por
  // ERR_PNPM_IGNORED_BUILDS y se leia como "[gates] lint: FALLA" con un stacktrace de pnpm, cuando
  // 'pnpm run lint' pasaba en verde). Se etiqueta aparte para no mandar a nadie a depurar su linter.
  const PATRONES_DEPS = [
    [/ERR_PNPM_IGNORED_BUILDS/, 'pnpm bloquea builds sin aprobar — ejecuta: pnpm approve-builds --all'],
    [/ERR_PNPM_NO_LOCKFILE|ERR_PNPM_OUTDATED_LOCKFILE/, 'lockfile ausente o desincronizado — ejecuta: pnpm install'],
    [/ERR_PNPM_FETCH|ENOTFOUND|ETIMEDOUT|ECONNREFUSED/, 'no se pudieron descargar dependencias (red/registro)'],
    [/Cannot find module|MODULE_NOT_FOUND/, 'faltan dependencias instaladas — ejecuta el install de tu gestor'],
    [/npm ERR! code E|ERR_PNPM_/, 'error del gestor de paquetes, no del gate'],
  ];
  const causaDeps = (texto) => {
    for (const [re, explicacion] of PATRONES_DEPS) if (re.test(texto)) return explicacion;
    return null;
  };
  // 'op' opcional (gates por app): cwd = carpeta de la app y timeout = lo que le quede a esa app.
  const runCmd = (cmd, args, op = {}) => {
    try {
      const out = execFileSync(cmd, args, { windowsHide: true, cwd: op.cwd || ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: op.timeout || 180000, shell: true });
      return { status: 'pass', out: String(out).trim() };
    } catch (e) {
      if (e && e.code === 'ENOENT') return { status: 'skip', out: `comando no disponible: ${cmd}` };
      // Con presupuesto por app, un tiempo agotado es un FALLO del gate (no un problema de red).
      if (op.timeout && e && (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM')) return { status: 'fail', out: `tiempo agotado (${Math.round(op.timeout / 1000)} s) — sube el presupuesto con: git config faro.timeout-app <segundos>` };
      const out = [e && e.stdout, e && e.stderr].map((x) => (x ? String(x) : '')).join('\n').trim();
      const texto = out || (e && e.message) || 'error';
      const deps = causaDeps(texto);
      // 'deps' = el gate NO se pudo evaluar (problema de entorno), distinto de 'fail' (el gate fallo).
      if (deps) return { status: 'deps', out: texto, motivo: deps };
      return { status: 'fail', out: texto };
    }
  };
  // SIMULACRO DE DESPLIEGUE (#89). En proyectos que compilan con Vite antes de desplegar (TanStack Start,
  // React Router, Astro... con @cloudflare/vite-plugin), 'wrangler deploy --dry-run' a secas falla: wrangler
  // apunta a lo que genera la compilacion. Orden: el simulacro PROPIO del proyecto (deploy:dry) manda;
  // si hay 'build', se compila y despues --dry-run; si no, como siempre. Una sola decision para gates y CI.
  const simulacroDespliegue = () => {
    const pm = pkgManager();
    const dry = ['npx', ['wrangler', 'deploy', '--dry-run']];
    const propio = ['deploy:dry', 'deploy:dry-run'].find(hasScript);
    if (propio) return { pasos: [[pm, ['run', propio]]], run: `${pm} run ${propio}` };
    if (hasScript('build')) return { pasos: [[pm, ['run', 'build']], dry], run: `${pm} run build && npx wrangler deploy --dry-run` };
    return { pasos: [dry], run: 'npx wrangler deploy --dry-run' };
  };

  // ---- GATES PESADOS (#182) ----
  // typecheck, lint, test, build y el simulacro de despliegue pasan SIEMPRE por lib/ejecutar-pesado.js (semaforo global
  // por usuario, memoria minima, timeout, arbol de procesos cerrado, sin shell), con cache de verdes por hash del arbol.
  let sinCache = false;
  let bateriaCompleta = false;                // --todas (publicar/consolidar): se verifica de verdad, sin reutilizar verdes
  const buildFresco = new Set();              // apps cuyo `build` acaba de pasar EN ESTA ejecucion: el simulacro no lo repite
  let _instantanea;                           // una sola lectura de git por ejecucion de gates (no una por gate)
  const instantaneaRepo = () => (_instantanea !== undefined ? _instantanea : (_instantanea = CG.instantanea(ROOT)));                       // --sin-cache: no se lee la cache (el verde nuevo si se guarda)
  const fechaCorta = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  const tiempoAgotado = (seg) => ({ status: 'fail', timeout: true, out: `tiempo agotado (${seg} s): se corto por tiempo, no es un fallo de los tests — sube el presupuesto con: git config faro.timeout-app <segundos>` });
  const mapearPesado = (r, spec) => {
    if (r.status === 'pass') return { status: 'pass', out: r.out };
    if (r.status === 'skip') return { status: 'skip', out: r.out };
    // 'busy' = el gate NO se pudo evaluar por saturacion (cola o memoria): ni verde ni rojo.
    if (r.status === 'busy') return { status: 'busy', out: r.out, motivo: r.motivo };
    // Un corte por tiempo NO es un fallo del codigo (#208): sale marcado y sin la salida parcial
    // (todo en verde), que mandaba al agente a relanzar la suite buscando un fallo inexistente.
    if (r.timeout) return tiempoAgotado(spec.presupuestoApp || Math.round((spec.timeoutMs || 0) / 1000));
    const deps = causaDeps(r.out);
    if (deps) return { status: 'deps', out: r.out, motivo: deps };
    return { status: 'fail', out: r.out };
  };
  /** spec: { gate, etiqueta, appId, cwd, rutas, pm, forma, pasos: [{cmd, args, env}], fin|timeoutMs, presupuestoApp?, exclusivo? } */
  const correrPesado = (spec) => {
    const cacheable = spec.gate !== 'deploy-dry-run';   // depende de wrangler, de la cuenta y de recursos remotos que no estan en la clave
    const clave = !cacheable ? null : CG.clave({ root: ROOT, rutas: spec.rutas, gate: spec.gate, forma: spec.forma, pm: spec.pm, instantanea: instantaneaRepo() });
    if (!sinCache && !bateriaCompleta && cacheable) {
      const h = CG.leer(process.env, ROOT, spec.appId, spec.gate, clave);
      if (h) return { status: 'pass', out: `gate ${spec.gate} reutilizado (sin cambios desde ${fechaCorta(h.cuando)})`, reutilizado: true };
    }
    const t0 = Date.now();
    let r = { status: 'pass', out: '' };
    for (const p of spec.pasos) {
      const queda = spec.fin ? spec.fin - Date.now() : spec.timeoutMs;
      if (queda < 1000) { r = tiempoAgotado(spec.presupuestoApp || Math.round((spec.timeoutMs || 0) / 1000)); break; }
      const e = X.ejecutarSync({ cmd: p.cmd, args: p.args, cwd: spec.cwd, timeoutMs: Math.min(Math.round(queda), 6 * 3600e3), env: p.env || {}, etiqueta: spec.etiqueta, exclusivo: Boolean(spec.exclusivo), root: ROOT });
      r = mapearPesado(e, spec);
      if (r.status !== 'pass') break;
    }
    if (r.status === 'pass' && cacheable) CG.escribir(process.env, ROOT, spec.appId, spec.gate, clave, { ms: Date.now() - t0 });
    return r;
  };
  // Un gate de package.json (typecheck|lint|test|build) de la app 'appId' en 'cwd'.
  const gateNode = (nombre, script, o) => {
    const pm = pkgManager();
    const c = CMD.comandoGate({ pm, nombre, script, cwd: o.cwd, env: process.env, maxWorkers: 2 });
    if (!c) return { status: 'skip', out: `script no válido: ${nombre}` };
    const r = correrPesado({
      gate: nombre, etiqueta: `${o.appId === '.' ? '' : `${o.appId}·`}${nombre}`, appId: o.appId, cwd: o.cwd, rutas: o.rutas, pm,
      forma: CMD.formaEstable({ pm, nombre, script }, c), pasos: [{ cmd: c.cmd, args: c.args, env: c.env }], fin: o.fin, timeoutMs: o.timeoutMs, presupuestoApp: o.presupuestoApp,
    });
    if (nombre === 'build' && r.status === 'pass' && !r.reutilizado) buildFresco.add(o.appId);
    return r;
  };
  // Rutas de la app y de TODAS sus dependencias de workspace (cierre transitivo): lo que invalida su cache.
  const rutasConDeps = (a) => {
    const lista = appsWs();
    const porNombre = new Map(lista.filter((x) => x.paquete).map((x) => [x.paquete, x]));
    const vistos = new Map([[a.id, a]]); const cola = [a];
    while (cola.length) {
      const x = cola.shift();
      const p = readJsonAt(`${x.ruta}/package.json`) || {};
      const todas = { ...p.dependencies, ...p.devDependencies, ...p.peerDependencies, ...p.optionalDependencies };
      for (const [n, v] of Object.entries(todas)) {
        if (!porNombre.has(n)) continue;                // cualquier version (workspace:, *, rango, link:): el nombre es de un paquete del workspace
        const d = porNombre.get(n);
        if (!vistos.has(d.id)) { vistos.set(d.id, d); cola.push(d); }
      }
    }
    // Alias de tsconfig (references y compilerOptions.paths) que apuntan a otra carpeta del workspace.
    for (const x of [...vistos.values()]) {
      const ts = parseJsonc(readFileSafe(`${x.ruta}/tsconfig.json`)) || {};
      const cand = [...(ts.references || []).map((r) => r && r.path), ...Object.values((ts.compilerOptions || {}).paths || {}).flat()].filter((p) => typeof p === 'string');
      for (const p of cand) {
        const rel = path.posix.normalize(path.posix.join(x.ruta, p.replace(/\\/g, '/').replace(/\*.*$/, '')));
        const d = lista.find((y) => y.ruta && (rel === y.ruta || rel.startsWith(`${y.ruta}/`)));
        if (d && !vistos.has(d.id)) vistos.set(d.id, d);
      }
    }
    return [...vistos.values()].map((x) => x.ruta);
  };
  // POLITICA del simulacro de despliegue (lib/dry-run.js): solo al publicar o si el cambio afecta al despliegue.
  let _ficherosCambio;
  const ficherosDeCambio = () => {
    if (_ficherosCambio !== undefined) return _ficherosCambio;
    const base = ramaBase();
    return (_ficherosCambio = base ? ficherosCambiados(base) : null);
  };
  const entradaWrangler = (rel) => {
    const t = rel ? readFileSafe(rel) : null;
    if (t == null) return null;
    return /\.toml$/.test(rel) ? DRY.entrypoint(null, t) : DRY.entrypoint(parseJsonc(t), null);
  };
  /** spec: { appId, cwd, rutas, depsRutas, rutaApp, wranglerRel, pasos: [[cmd, args]], textoScripts } */
  const simulacroGobernado = (spec, op) => {
    const d = DRY.debeSimular({
      publicar: Boolean(op.todas), forzar: Boolean(op.simulacro), ficheros: op.todas || op.simulacro ? [] : ficherosDeCambio(),
      rutaApp: spec.rutaApp, entrypoint: entradaWrangler(spec.wranglerRel), depsRutas: spec.depsRutas,
    });
    if (!d.si) return { status: 'omitido', out: d.motivo };
    const pm = pkgManager();
    return correrPesado({
      gate: 'deploy-dry-run', etiqueta: `${spec.appId === '.' ? '' : `${spec.appId}·`}deploy-dry-run`, appId: spec.appId, cwd: spec.cwd, rutas: spec.rutas, pm,
      forma: ['dry-run', pm, ...spec.pasos.map(([c, a]) => [c, ...a].join(' ')), spec.textoScripts || ''],
      pasos: spec.pasos.filter(([cmd, args]) => !(buildFresco.has(spec.appId) && cmd === pm && args[0] === 'run' && args[1] === 'build')).map(([cmd, args]) => ({ cmd, args })), fin: spec.fin, timeoutMs: spec.timeoutMs, presupuestoApp: spec.presupuestoApp, exclusivo: true,
    });
  };

  // ---- MONOREPO: gates POR APP (#130) ----
  // Cada app corre SUS scripts en SU carpeta, con su propio presupuesto de tiempo. Por defecto solo
  // las apps AFECTADAS: diff contra develop + lo sin commitear, ampliado con sus dependientes del
  // workspace. Al publicar/consolidar, todas.
  const gitOut = (args) => { try { return execFileSync('git', ['-c', 'core.quotepath=false', ...args], { windowsHide: true, cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  const readJsonAt = (rel) => { const t = readFileSafe(rel); if (!t) return null; try { return JSON.parse(t); } catch { return null; } };
  let _appsWs;
  const appsWs = () => (_appsWs !== undefined ? _appsWs : (_appsWs = appsLib.apps(ROOT).filter((a) => a.existe && a.ruta)));
  const scriptsDe = (a) => { const p = readJsonAt(`${a.ruta}/package.json`); return (p && p.scripts) || {}; };
  // Prefijo para lanzar algo EN una app desde la raiz (CI y sugerencias): nunca en la raiz a secas.
  const enApp = (pm, a) => {
    if (pm === 'pnpm') return a.paquete ? `pnpm --filter ${a.paquete}` : `pnpm -C ${a.ruta}`;
    if (pm === 'yarn') return a.paquete ? `yarn workspace ${a.paquete}` : `yarn --cwd ${a.ruta}`;
    return `npm -w ${a.ruta}`;
  };
  const execEnApp = (pm, a, bin) => (pm === 'npm' ? `${enApp(pm, a)} exec -- ${bin}` : pm === 'yarn' ? `${enApp(pm, a)} run ${bin}` : `${enApp(pm, a)} exec ${bin}`);
  // Ficheros de la RAIZ que cambian el workspace entero: si se tocan, todas las apps.
  const RAIZ_GLOBAL = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package-lock.json', 'yarn.lock'];
  const ramaBase = () => ['origin/develop', 'develop'].find((r) => gitOut(['rev-parse', '--verify', '--quiet', `${r}^{commit}`])) || null;
  const ficherosCambiados = (base) => {
    const s = new Set();
    for (const args of [['diff', '--name-only', `${base}...HEAD`], ['diff', '--name-only', 'HEAD'], ['ls-files', '--others', '--exclude-standard']]) {
      (gitOut(args) || '').split('\n').filter(Boolean).forEach((f) => s.add(f));
    }
    return [...s];
  };
  // Cierre de DEPENDIENTES: quien declara una app tocada como dependencia 'workspace:' tambien se prueba.
  const ampliarDependientes = (lista, tocadas) => {
    const porNombre = new Map(lista.filter((a) => a.paquete).map((a) => [a.paquete, a.id]));
    const depsDe = new Map(lista.map((a) => {
      const p = readJsonAt(`${a.ruta}/package.json`) || {};
      const todas = { ...p.dependencies, ...p.devDependencies, ...p.peerDependencies, ...p.optionalDependencies };
      return [a.id, Object.entries(todas).filter(([n, v]) => String(v).startsWith('workspace:') && porNombre.has(n)).map(([n]) => porNombre.get(n))];
    }));
    const cola = [...tocadas.keys()];
    while (cola.length) {
      const x = cola.shift();
      for (const a of lista) if (!tocadas.has(a.id) && depsDe.get(a.id).includes(x)) { tocadas.set(a.id, `depende de ${x}`); cola.push(a.id); }
    }
  };
  /** Que apps se ejecutan y por que: {apps, porque: {id: motivo}, resumen}. op: {todas, apps: [id]}. */
  const alcanceApps = (op = {}) => {
    const lista = appsWs();
    const listaIds = lista.map((a) => a.id).join(', ');
    const sel = (mapa, resumen) => ({ apps: lista.filter((a) => mapa.has(a.id)), porque: Object.fromEntries(mapa), resumen });
    const todas = (motivo) => sel(new Map(lista.map((a) => [a.id, motivo])), `todas (${listaIds || 'ninguna en el workspace'}) — ${motivo}`);
    if (op.apps && op.apps.length) {
      const pedidas = new Map(op.apps.filter((id) => lista.some((a) => a.id === id)).map((id) => [id, 'forzada con --app']));
      const desconocidas = op.apps.filter((id) => !pedidas.has(id));
      return sel(pedidas, `${[...pedidas.keys()].join(', ') || 'ninguna'} (forzada con --app)${desconocidas.length ? ` · desconocida(s): ${desconocidas.join(', ')} (válidas: ${listaIds})` : ''}`);
    }
    if (op.todas) return todas('batería completa');
    const base = ramaBase();
    if (!base) return todas('sin rama develop con la que comparar');
    const ficheros = ficherosCambiados(base);
    const globales = ficheros.filter((f) => RAIZ_GLOBAL.includes(f));
    if (globales.length) return todas(`el cambio toca ${globales.join(', ')} de la raíz`);
    const tocadas = new Map();
    for (const a of appsLib.appsAfectadas(ROOT, ficheros).apps) if (lista.some((x) => x.id === a.id)) tocadas.set(a.id, 'cambiada');
    ampliarDependientes(lista, tocadas);
    if (!tocadas.size) return sel(tocadas, ficheros.length ? 'ninguna app — el cambio solo toca raíz/gestión' : `ninguna app — sin cambios respecto a ${base}`);
    const resto = lista.filter((a) => !tocadas.has(a.id)).map((a) => a.id);
    const r = sel(tocadas, '');
    r.resumen = `${r.apps.map((a) => `${a.id} (${tocadas.get(a.id)})`).join(', ')}${resto.length ? ` · sin ejecutar: ${resto.join(', ')}` : ''}`;
    return r;
  };
  const placeholdersApp = (a) => { const t = a.worker ? readFileSafe(a.worker.fichero) : null; return Boolean(t && /<WORKER_NAME>|<COMPATIBILITY_DATE>/.test(t)); };
  // Simulacro de despliegue de UNA app con worker (misma decision que simulacroDespliegue, en su carpeta).
  const simulacroApp = (a) => {
    const pm = pkgManager(); const sc = scriptsDe(a);
    const propio = ['deploy:dry', 'deploy:dry-run'].find((x) => sc[x]);
    const dryLocal = ['npx', ['wrangler', 'deploy', '--dry-run']];
    const dryCi = execEnApp(pm, a, 'wrangler deploy --dry-run');
    if (propio) return { pasos: [[pm, ['run', propio]]], run: `${enApp(pm, a)} run ${propio}` };
    if (sc.build) return { pasos: [[pm, ['run', 'build']], dryLocal], run: `${enApp(pm, a)} run build && ${dryCi}` };
    return { pasos: [dryLocal], run: dryCi };
  };
  const timeoutApp = () => {
    const v = Number(gitOut(['config', 'faro.timeout-app']));
    return (Number.isFinite(v) && v > 0 ? v : 300) * 1000;
  };
  // Repo de una sola app: cada gate tiene el mismo presupuesto que una app de monorepo (#208).
  const unaApp = () => { const ms = timeoutApp(); return { cwd: ROOT, appId: '.', rutas: ['.'], timeoutMs: ms, presupuestoApp: Math.round(ms / 1000) }; };
  const GATES_NODE = ['typecheck', 'lint', 'test', 'build'];
  const runGatesApps = (op) => {
    const alcance = alcanceApps(op);
    const presupuesto = timeoutApp();
    const results = [];
    for (const a of alcance.apps) {
      const cwd = path.join(ROOT, a.ruta);
      const fin = Date.now() + presupuesto;
      const sc = scriptsDe(a);
      const rutas = rutasConDeps(a);
      const o = { cwd, appId: a.id, rutas, fin, presupuestoApp: Math.round(presupuesto / 1000) };
      for (const g of GATES_NODE) if (sc[g]) results.push([`${a.id} · ${g}`, gateNode(g, sc[g], o)]);
      if (a.worker && !placeholdersApp(a)) {
        results.push([`${a.id} · deploy --dry-run`, simulacroGobernado({
          appId: a.id, cwd, rutas, depsRutas: rutas.filter((r) => r !== a.ruta), rutaApp: a.ruta, wranglerRel: a.worker.fichero,
          pasos: simulacroApp(a).pasos, textoScripts: `${sc['deploy:dry'] || sc['deploy:dry-run'] || ''}|${sc.build || ''}`, fin, presupuestoApp: o.presupuestoApp,
        }, op)]);
      }
    }
    return { results, alcance };
  };

  // Comando de gate declarado por el desarrollador (CUALQUIER stack): git config faro.gates "<comando>".
  // Ej.: 'make check', 'poetry run pytest && ruff check', 'go test ./...'. El harness NO impone stack: corre lo TUYO.
  const declaredGates = () => { try { return execFileSync('git', ['config', 'faro.gates'], { windowsHide: true, cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; } };
  const runGates = (op = {}) => {
    sinCache = Boolean(op.sinCache);
    bateriaCompleta = Boolean(op.todas);
    _instantanea = undefined; _ficherosCambio = undefined; buildFresco.clear();
    const results = [];
    const m = mode();
    if (m === 'monorepo') {
      // Los scripts de la RAIZ no son gates de app (suelen ser 'pnpm -r test': todo el workspace).
      const { results: porApp, alcance } = runGatesApps(op);
      results.push(...porApp);
      const dg = declaredGates();
      if (dg) results.push(['faro.gates', runCmd(dg, [])]);
      results.alcance = alcance;
      return results;
    }
    if (m === 'cloudflare') { // stack conocido del worker
      const sc = (readPkg() || {}).scripts || {};
      const o = unaApp();
      for (const g of ['typecheck', 'lint', 'test']) if (sc[g]) results.push([g, gateNode(g, sc[g], o)]);
      if (!wranglerPlaceholders().length) {
        const w = readWrangler();
        results.push(['deploy --dry-run', simulacroGobernado({
          appId: '.', cwd: ROOT, rutas: ['.'], depsRutas: [], rutaApp: '', wranglerRel: w && w.file,
          pasos: simulacroDespliegue().pasos, textoScripts: `${sc['deploy:dry'] || sc['deploy:dry-run'] || ''}|${sc.build || ''}`, timeoutMs: o.timeoutMs, presupuestoApp: o.presupuestoApp,
        }, op)]);
      }
      return results;
    }
    if (!esGenerico(m)) return results;
    // GENERICO: NO imponemos herramientas por lenguaje. Corremos solo lo que TU declaras.
    // 1) Node: scripts que TU definiste en package.json (convencion de facto, no impuesta).
    if (readPkg()) {
      const sc = readPkg().scripts || {};
      const o = unaApp();
      for (const g of ['typecheck', 'lint', 'test', 'build']) if (sc[g]) results.push([g, gateNode(g, sc[g], o)]);
    }
    // 2) Cualquier stack: el comando de gate que hayas declarado (git config faro.gates).
    const dg = declaredGates();
    if (dg) results.push(['faro.gates', runCmd(dg, [])]);
    return results;
  };
  const gateReadinessLines = () => {
    const m = mode();
    if (m === 'none') return [];
    if (m === 'cloudflare') {
      const pm = pkgManager();
      return [
        `Gates de codigo (Cloudflare, gestor ${pm}):`,
        `- typecheck: ${hasScript('typecheck') ? 'OK' : 'FALTA'} · lint: ${hasScript('lint') ? 'OK' : 'opcional'} · tests: ${hasScript('test') ? 'OK' : 'FALTA'} · deploy --dry-run`,
        'Ejecuta: node .claude/hooks/harness.js gates.',
      ];
    }
    if (m === 'monorepo') {
      const lines = [`Gates POR APP (monorepo, gestor ${pkgManager()}): cada app corre sus scripts en su carpeta; por defecto solo las afectadas por el cambio.`];
      for (const a of appsWs()) {
        const sc = Object.keys(scriptsDe(a)).filter((x) => GATES_NODE.includes(x));
        lines.push(`- ${a.id}: ${sc.join(', ') || 'sin scripts de gate'}${a.worker ? ' + deploy --dry-run' : ''}`);
      }
      lines.push('Ejecuta: node .claude/hooks/harness.js gates [--todas | --app <id>].');
      return lines;
    }
    // generico: el harness AYUDA (guardian de calidad) pero NO impone stack.
    const stack = detectStack() || 'sin manifiesto';
    const lines = [`Codigo (stack detectado: ${stack}). El harness AYUDA con calidad, NO impone herramientas.`];
    if (readPkg()) lines.push(`- Node: scripts que corre el gate -> ${['typecheck', 'lint', 'test', 'build'].filter(hasScript).join(', ') || 'ninguno declarado en package.json'}.`);
    lines.push('- Cualquier stack: declara tu comando de gate -> git config faro.gates "<cmd>" (ej. make check, pytest, go test ./...). El harness lo corre con `gates` o `validate --gates`; confia en tu CI para el resto.');
    lines.push('- CALIDAD (lo importante, agnostico al lenguaje): al tocar codigo usa el subagente revisor-code -> buenas practicas / SOLID: responsabilidad unica, sin duplicidad, limites claros (helper/service/utils), 1 archivo = 1 responsabilidad, funciones pequenas, nombres claros.');
    lines.push('Ejecuta gates: node .claude/hooks/harness.js gates.');
    return lines;
  };

  // ---- skill routing (segun modo) ----
  const skillRoutingLines = () => {
    const m = mode();
    if (m === 'cloudflare') return [
      'ROUTING DE SKILLS (usa docs vivas, NO conocimiento pre-entrenado):',
      "- Tocar src/ o revisar el worker -> skill 'workers-best-practices' + subagente revisor-code (duplicidad, helper/service/utils, 1 archivo=1 func).",
      "- Anadir/gestionar D1, KV, R2, vars, colas -> skill 'cloudflare' + MCP cloudflare-bindings (crea el recurso) + skill 'wrangler'.",
      "- Durable Objects -> 'durable-objects'. Agentes/Workflows/Queues -> 'agents-sdk'. Contenedores -> 'sandbox-sdk'. Comunicacion worker<->worker -> RPC (service bindings/WorkerEntrypoint).",
      "- Seguridad/vulnerabilidades -> skill 'security-review' + audit de dependencias; revisor-code vigila Web Crypto, timing-safe y secrets fuera del codigo.",
      '- Dependencias al dia (Cloudflare cambia rapido) -> node .claude/hooks/harness.js deps.',
      '- MCP Cloudflare (con el plugin, AUTH una vez): cloudflare-observability (logs/traces del desplegado), cloudflare-bindings (crea/consulta D1/KV/R2), cloudflare-builds.',
      'Playbook para anadir binding: node .claude/hooks/harness.js infra.',
    ];
    if (esGenerico(m)) return [
      'ROUTING (codigo AGNOSTICO al stack — el harness AYUDA y se ADAPTA, no impone ni limita):',
      '- CALIDAD (nucleo, cualquier lenguaje): subagente revisor-code = guardian de BUENAS PRACTICAS / SOLID -> responsabilidad unica, sin duplicidad, limites claros (helper/service/utils), 1 archivo = 1 responsabilidad, funciones pequenas, nombres claros, acoplamiento bajo. Se adapta al stack que uses.',
      "- Seguridad -> skill 'security-review' (secrets fuera del codigo, validacion de entradas).",
      '- Gates: corre lo que TU declaras (scripts package.json o git config faro.gates "<cmd>"); el harness confia en tu stack/CI, no impone herramientas.',
      m === 'monorepo'
        ? '- Arquitectura: MONOREPO — gestion FARO unica en la raiz; cada app vive en su carpeta del workspace con su CLAUDE.md (contexto) y su ARCHITECTURE.md (contrato). Apps, rol y rasgos: node .claude/hooks/harness.js apps. Despliegue POR GIT (CI), nunca a main directo.'
        : '- Arquitectura/infra/despliegue: documenta en un doc ARQ; back y front en repos separados (microservicio); despliegue POR GIT (CI), nunca a main directo.',
    ];
    return [];
  };

  // DISCIPLINA DE TESTS Y SALUD DEL CODIGO (modo code, cualquier stack). Practicas que el agente
  // aplica al implementar; el detalle de herramienta se resuelve con las skills/docs vivas del stack.
  // En un monorepo los tests son de CADA app y cada una sigue la convencion de su stack (#132):
  // tests/ o test/ en la carpeta de la app, o colocados junto al codigo (src/**/*.test.ts). Exigir
  // test/ en la raiz era pedir lo que un monorepo no tiene.
  const testDisciplineMonorepo = () => {
    const sinTests = require('./apps.js').apps(ROOT)
      .filter((a) => a.existe && a.tipo === 'app' && !(a.tests && (a.tests.carpeta || a.tests.colocados)))
      .map((a) => a.id);
    return [
      'DISCIPLINA DE TESTS (obligatoria al implementar, MONOREPO: por app):',
      '- Cada app tiene SUS tests, con la convencion de su stack: carpeta propia (apps/<x>/tests/ o apps/<x>/test/, por nivel unit/integration/e2e) o colocados junto al codigo (apps/<x>/src/**/*.test.ts). Lo que use la app, sin mezclar las dos dentro de ella.',
      ...(sinTests.length ? [`- Apps SIN tests detectados: ${sinTests.join(', ')}. Anadeselos antes de cerrar un cambio que las toque.`] : []),
      '- Los criterios de aceptacion de la spec se demuestran con validaciones E2E de la app afectada, no solo unitarias: la evidencia de NEGOCIO es la que cierra el cambio (la revisa revisor-code).',
      '- ANTES de implementar algo no trivial: consulta las MEJORES PRACTICAS VIGENTES del stack (WebSearch/docs oficiales/skills), no memoria pre-entrenada — el tooling cambia rapido y la solucion debe ser la actual.',
      '- CODIGO MUERTO: al cerrar un cambio, revisa exports/funciones/deps sin uso (knip en el workspace, ts-prune/depcheck por app) y eliminalos en el mismo cambio — no se acumulan.',
    ];
  };
  const testDisciplineLines = () => {
    if (mode() === 'none') return [];
    if (mode() === 'monorepo') return testDisciplineMonorepo();
    return [
      'DISCIPLINA DE TESTS (obligatoria al implementar):',
      '- TODOS los tests viven en UNA carpeta raiz propia (test/ o tests/, segun convencion del stack), organizada por nivel: test/unit/ · test/integration/ · test/e2e/. NO tests sueltos junto al codigo ni en la raiz.',
      '- Los criterios de aceptacion de la spec se demuestran con validaciones E2E (test/e2e/), no solo unitarias: la evidencia de NEGOCIO es la que cierra el cambio (la revisa revisor-code).',
      '- ANTES de implementar algo no trivial: consulta las MEJORES PRACTICAS VIGENTES del stack (WebSearch/docs oficiales/skills), no memoria pre-entrenada — el tooling cambia rapido y la solucion debe ser la actual.',
      '- CODIGO MUERTO: al cerrar un cambio, revisa exports/funciones/deps sin uso (knip/ts-prune/depcheck en JS-TS, vulture en Python, o el linter del stack) y eliminalos en el mismo cambio — no se acumulan.',
    ];
  };

  // ---- subcomandos CLI ----
  const cmdGates = (op = {}) => {
    if (mode() === 'none') { process.stdout.write('Sin código aquí (repo documental): no hay gates que ejecutar.\n'); return; }
    const results = runGates(op);
    if (results.alcance) process.stdout.write(`Apps: ${results.alcance.resumen}\n`);
    if (!results.length && results.alcance) { process.stdout.write('Nada que ejecutar. Para forzar: harness.js gates --todas  o  --app <id>.\n'); return; }
    if (!results.length) { process.stdout.write('Sin gates que correr. Declara los TUYOS: scripts en package.json (typecheck/test/lint/build) o `git config faro.gates "<comando>"` (cualquier stack). El harness no impone herramientas — confia en tu CI.\n'); return; }
    let fail = 0;
    const lines = ['GATES DE CODIGO:'];
    for (const [name, r] of results) {
      if (r.status === 'pass') lines.push(r.reutilizado ? `- ${name}: OK · ${r.out}` : `- ${name}: OK`);
      else if (r.status === 'omitido') lines.push(`- ${name}: omitido — ${r.out}`);
      else if (r.status === 'busy') { fail++; lines.push(`- ${name}: NO EVALUADO — sistema saturado: ${r.out.split('\n')[0]}`); }
      else if (r.status === 'skip') lines.push(`- ${name}: no disponible (${r.out})`);
      else if (r.status === 'deps') {
        // NO cuenta como gate fallido: el gate no se pudo EVALUAR (entorno/dependencias).
        lines.push(`- ${name}: NO EVALUADO — problema de DEPENDENCIAS, no del gate: ${r.motivo}`);
        lines.push(`${r.out.split('\n').slice(-6).map((l) => `    ${l}`).join('\n')}`);
      } else if (r.timeout) { fail++; lines.push(`- ${name}: ${r.out.replace(/^tiempo agotado/, 'TIEMPO AGOTADO')}`); }
      else { fail++; lines.push(`- ${name}: FALLA\n${r.out.split('\n').slice(-12).map((l) => `    ${l}`).join('\n')}`); }
    }
    process.stdout.write(lines.join('\n') + '\n');
    if (fail) process.exit(1);
  };
  // Workers del monorepo: tipos y simulacro, cada uno EN su app (nunca desde la raiz).
  const typegenApp = (pm, a) => (scriptsDe(a)['cf-typegen'] ? `${enApp(pm, a)} run cf-typegen` : execEnApp(pm, a, 'wrangler types'));
  const workersInfraLines = () => {
    const pm = pkgManager();
    const ws = appsWs().filter((a) => a.worker);
    if (!ws.length) return [];
    return ['', 'WORKERS DEL MONOREPO (cada uno en su app):', ...ws.map((a) => `- ${a.id}${a.worker.nombre ? ` (${a.worker.nombre})` : ''}: tipos ${typegenApp(pm, a)} · simulacro ${simulacroApp(a).run}`)];
  };
  const cmdInfra = () => {
    const m = mode();
    if (m === 'none') { process.stdout.write('Sin código aquí (repo documental): no hay infra que inspeccionar.\n'); return; }
    if (esGenerico(m)) {
      process.stdout.write([...infraLines(), '',
        'PLAYBOOK (código genérico):',
        '1. Documenta la arquitectura en un doc ARQ (documentos/): componentes, límites, contratos.',
        m === 'monorepo'
          ? '2. Monorepo: cada app en su carpeta del workspace, con su CLAUDE.md y su ARCHITECTURE.md; declárala en .faro.json > monorepo.apps (node .claude/hooks/harness.js apps).'
          : '2. Back y front SEPARADOS en repos propios (filosofía microservicio); relaciónalos por sys-<slug> (topic).',
        '3. Despliegue POR GIT (CI): feature/develop -> preview; merge a main (= aprobación) -> producción. Nunca a main directo.',
        '4. Secrets: nunca en git (env / secret store / CI). Validación (definición de HECHO): typecheck + test + build -> node .claude/hooks/harness.js gates.',
        ...(m === 'monorepo' ? workersInfraLines() : []),
      ].join('\n') + '\n');
      return;
    }
    // cloudflare
    const lines = [...infraLines(), ''];
    const hints = infraUpgradeHints();
    if (hints.length) { lines.push('ACTUALIZAR / MODERNIZAR:'); hints.forEach((h) => lines.push(`- ${h}`)); lines.push(''); }
    lines.push(
      'ANADIR UN BINDING (playbook, usa docs vivas):',
      '1. Skill de referencia: cloudflare / wrangler (patron y sintaxis actual).',
      '2. Crea el recurso con el MCP cloudflare-bindings (d1_database_create, kv_namespace_create, r2_bucket_create…) o wrangler.',
      '3. Anade el binding a wrangler.jsonc (D1: d1_databases · KV: kv_namespaces · R2: r2_buckets · cola: queues · DO: durable_objects · service: services · AI: ai · Vectorize: vectorize · Workflow: workflows).',
      `4. Regenera tipos: ${pkgManager()} run cf-typegen (o npx wrangler types).`,
      '5. Codigo + test (vitest) + typecheck (guardian revisor-code: sin duplicidad, helper/service/utils, 1 archivo=1 func).',
      '6. Valida sin desplegar: npx wrangler deploy --dry-run. El deploy real lo aplica el usuario.',
      '',
      'ARQUITECTURA: back y front SEPARADOS, comunicados por RPC (service bindings / WorkerEntrypoint), no HTTP entre ellos.',
      '',
      'DESPLIEGUE = POR GIT (automatico). Conecta el repo en Cloudflare (Workers Builds) UNA vez:',
      '- push a develop/feature -> PREVIEW (wrangler versions upload --env staging), sin trafico.',
      '- merge a main (= aprobacion) -> PRODUCCION (wrangler deploy/versions --env production). Lo hace la CI, no Claude.',
      '- Secrets: nunca en git; wrangler secret put / Secrets Store (o via CI). Tras cambiar bindings: cf-typegen.',
      '',
      'VALIDACION (definicion de HECHO, ciclo git feature->develop->main):',
      '- LOCAL: typecheck + vitest + deploy --dry-run  ->  node .claude/hooks/harness.js gates.',
      '- REMOTA: bindings sin emulacion (Vectorize/AI/Hyperdrive/Browser/Email) con remote:true (wrangler >= 4.37) o wrangler dev --remote (autenticado, lo aplica el usuario).',
      '- SEGURIDAD: audit de dependencias + skill security-review (Web Crypto, timing-safe, secrets fuera del codigo).',
      '',
      'ACCESO CLOUDFLARE: el trabajo LOCAL (codigo, vitest, dry-run) NO requiere cuenta. Deploy/validacion remota SI:',
      '- Humano: wrangler login (rol con permisos MINIMOS: Workers Scripts:Edit + Account Settings:Read + KV/D1/R2:Edit si se usan; NO Administrator).',
      '- CI: CLOUDFLARE_API_TOKEN con scope ("Edit Cloudflare Workers") + CLOUDFLARE_ACCOUNT_ID. Nunca token global.',
    );
    process.stdout.write(lines.join('\n') + '\n');
  };
  const KEY_CF = ['wrangler', '@cloudflare/vitest-pool-workers', 'vitest', 'hono', 'typescript'];
  const KEY_GEN = ['typescript', 'vitest', 'jest', 'eslint'];
  // MONOREPO: cada app sus dependencias, la raiz solo el tooling comun. En un workspace pnpm,
  // 'pnpm add' en la raiz falla (ERR_PNPM_ADDING_TO_ROOT): toda sugerencia lleva --filter o -w.
  const depsLinesMonorepo = () => {
    const pm = pkgManager();
    const lista = appsWs();
    const addEn = (a, x) => (pm === 'npm' ? `npm install -D ${x} -w ${a.ruta}` : `${enApp(pm, a)} add -D ${x}`);
    const addRaiz = (x) => (pm === 'pnpm' ? `pnpm add -Dw ${x}` : pm === 'yarn' ? `yarn add -D -W ${x}` : `npm install -D ${x}`);
    const outdated = pm === 'pnpm' ? 'pnpm outdated -r' : pm === 'npm' ? 'npm outdated --workspaces' : 'yarn outdated';
    const update = pm === 'pnpm' ? 'pnpm update -r' : pm === 'npm' ? 'npm update --workspaces' : 'yarn up';
    const majors = pm === 'pnpm' ? 'pnpm --filter <paquete> up --latest <dep>' : pm === 'npm' ? 'npm install <dep>@latest -w <ruta-app>' : 'yarn workspace <paquete> up <dep>@latest';
    const lines = [`DEPENDENCIAS (gestor: ${pm} · monorepo de ${lista.length} app(s): cada app las suyas, la raíz solo el tooling común):`, 'Versiones clave declaradas:'];
    const clave = (pkg, keys) => { const all = { ...(pkg && pkg.dependencies), ...(pkg && pkg.devDependencies) }; return keys.filter((k) => all[k]).map((k) => `${k} ${all[k]}`); };
    for (const a of lista) { const v = clave(readJsonAt(`${a.ruta}/package.json`), a.worker ? KEY_CF : KEY_GEN); if (v.length) lines.push(`- ${a.id}: ${v.join(' · ')}`); }
    const vr = clave(readPkg(), KEY_GEN); if (vr.length) lines.push(`- raíz: ${vr.join(' · ')}`);
    lines.push('', `Ver desactualizadas (consulta el registro, requiere red): ${outdated}`, 'Actualizar (y SIEMPRE re-validar después):');
    for (const a of lista.filter((x) => x.worker)) lines.push(`- ${a.id} (worker): ${addEn(a, 'wrangler@latest')}  ->  ${typegenApp(pm, a)}`);
    lines.push(
      `- una dependencia de una app: ${pm === 'npm' ? 'npm install <dep> -w <ruta-app>' : pm === 'yarn' ? 'yarn workspace <paquete> add <dep>' : 'pnpm --filter <paquete> add <dep>'}`,
      `- tooling común de la raíz: ${addRaiz('<dep>')}`,
      `- menores dentro de rango: ${update}   ·   subir majors: ${majors} (revisa breaking changes con su skill)`,
      'Tras actualizar: cf-typegen de cada worker + node .claude/hooks/harness.js gates --todas + validate. No mergees/despliegues sin verde.',
    );
    return { lines, outdatedArgs: outdated.split(' ').slice(1) };
  };
  const depsLinesSimple = () => {
    const pm = pkgManager();
    const pkg = readPkg();
    if (!pkg) return ['Sin package.json (repo documental): no hay dependencias que auditar.'];
    const cf = mode() === 'cloudflare';
    const KEY = cf ? KEY_CF : KEY_GEN;
    const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const lines = [`DEPENDENCIAS (gestor: ${pm}${cf ? ' · Cloudflare/wrangler cambian rapido, mantenlas al dia' : ''}):`, 'Versiones clave declaradas:'];
    KEY.forEach((k) => { if (all[k]) lines.push(`- ${k}: ${all[k]}`); });
    lines.push('', `Ver desactualizadas (consulta el registro, requiere red): ${pm} outdated`, 'Actualizar (y SIEMPRE re-validar despues):');
    if (cf) lines.push(
      `- wrangler al ultimo: ${pm} add -D wrangler@latest  ->  ${pm} run cf-typegen`,
      `- toolchain de tests: ${pm} add -D @cloudflare/vitest-pool-workers@latest vitest@latest  (revisa acoplamiento pool<->vitest)`,
    );
    lines.push(
      `- menores dentro de rango: ${pm} update   ·   subir majors: ${pm} up --latest <paquete> (revisa breaking changes con su skill)`,
      `Tras actualizar: ${cf ? 'cf-typegen + ' : ''}node .claude/hooks/harness.js gates + validate. No mergees/despliegues sin verde.`,
    );
    return lines;
  };
  /** Lineas del informe de dependencias SIN consultar el registro (lo que imprime 'deps' antes del outdated). */
  const depsLines = () => (mode() === 'monorepo' ? depsLinesMonorepo().lines : depsLinesSimple());
  const cmdDeps = () => {
    const pm = pkgManager();
    if (mode() !== 'monorepo' && !readPkg()) { process.stdout.write('Sin package.json (repo documental): no hay dependencias que auditar.\n'); return; }
    const mono = mode() === 'monorepo' ? depsLinesMonorepo() : null;
    const lines = mono ? mono.lines : depsLinesSimple();
    const outArgs = mono ? mono.outdatedArgs : ['outdated'];
    const r = runCmd(pm, outArgs);
    if (r.out && /(outdated|wanted|latest|current)/i.test(r.out)) lines.push('', `${pm} ${outArgs.join(' ')}:`, r.out.split('\n').slice(0, 25).join('\n'));
    process.stdout.write(lines.join('\n') + '\n');
  };

  // ¿el comando es un DESPLIEGUE a produccion? (para gobernarlo como aprobacion en pre-bash).
  // Es una GUARDA, falla CERRADA y NO TIENE EXENCIONES: toda orden de despliegue, tambien de pruebas
  // o simulacro, pide aprobacion. Las listas blancas se burlaban ('--dry-run --dry-run=false' gana el
  // ultimo flag; un script 'deploy:dev' puede desplegar a produccion con ese nombre). Un aviso de mas
  // es aceptable; un deploy a produccion sin aprobacion, no. Los simulacros que lanzan los gates del
  // propio harness no pasan por aqui (los ejecuta code.js, no una orden Bash del agente).
  const isDeployCmd = (cmd) => {
    if (!cmd || mode() === 'none') return false;
    // Continuaciones de linea ('\' de bash, backtick de PowerShell + salto) unidas; todo en minusculas.
    const t = String(cmd).replace(/[\\`]\r?\n/g, ' ').toLowerCase();
    if (!t.includes('deploy')) return false;
    return /wrangler|pnpm|npm|npx|yarn|bun|deno|[$`]|\beval\b/.test(t);
  };
  const deployNote = () => 'Toda orden de despliegue (tambien de pruebas o simulacro) = APROBACION: el de produccion normalmente es por push (CI), no manual. El deploy manual es EXCEPCION; valida antes (gates + dry-run) y aplicalo tu.';

  // Errores de validacion propios del stack (para foldear en 'validate'). Cloudflare: wrangler sin rellenar.
  const validationIssues = () => {
    if (mode() !== 'cloudflare') return [];
    const ph = wranglerPlaceholders();
    return ph.length ? [`wrangler config sin rellenar: ${ph.join(', ')} (completa el onboarding).`] : [];
  };

  // Version de Node para el YAML de CI: la que declara el propio package.json (engines.node), o 22 por defecto.
  const nodeVersion = () => {
    const pkg = readPkg();
    const raw = pkg && pkg.engines && pkg.engines.node;
    const m = raw && String(raw).match(/(\d+)/);
    return m ? m[1] : '22';
  };
  const instalarCmd = (pm) => (pm === 'yarn' ? 'yarn install --frozen-lockfile' : pm === 'pnpm' ? 'pnpm install --frozen-lockfile' : 'npm ci');

  // pnpm NO viene en un runner limpio (#143): sin habilitarlo, 'pnpm install' falla con
  // "pnpm: command not found". Se anade al runtime de Node lo necesario, SOLO para pnpm (npm/yarn
  // quedan como estaban):
  // - GitHub: pnpm/action-setup ANTES de setup-node (que cachea el store con cache: pnpm). Sin
  //   'version' si package.json declara packageManager: la accion la lee de ahi (y falla si ambas
  //   discrepan). Sin packageManager la accion exige version: la ultima.
  // - GitLab: corepack (se instala con npm porque Node 25+ ya no lo trae, y asi va al dia con las
  //   claves de firma de pnpm) + store dentro del proyecto para poder cachearlo por lockfile.
  const PNPM_ACTION = 'pnpm/action-setup@v6';
  const conGestor = (runtime, pm) => {
    if (pm !== 'pnpm' || !runtime.ghSetup) return runtime;
    const pkg = readPkg();
    const declarado = Boolean(pkg && typeof pkg.packageManager === 'string' && /^pnpm@/.test(pkg.packageManager));
    return {
      ...runtime,
      ghPre: [declarado ? { uses: PNPM_ACTION } : { uses: PNPM_ACTION, with: { version: 'latest' } }],
      ghSetup: { ...runtime.ghSetup, with: { ...runtime.ghSetup.with, cache: 'pnpm' } },
      gitlabBefore: [
        'npm install -g corepack@latest',
        'corepack enable',
        ...(declarado ? [] : ['corepack prepare pnpm@latest --activate']),
        'pnpm config set store-dir .pnpm-store',
      ],
      gitlabCache: { key: 'pnpm-lock.yaml', paths: ['.pnpm-store'] },
    };
  };

  // RUNTIME por lenguaje detectado (manifiesto de STACK_MANIFESTS): imagen de contenedor para GitLab
  // y accion de setup para GitHub Actions. Son un PUNTO DE PARTIDA razonable (version reciente y
  // estable a la fecha de esta version del harness) — el equipo las ajusta a su gusto; el harness no
  // impone el runtime exacto, solo evita dejar el YAML sin ninguna pista de por donde empezar.
  // ghSetup:null = el runner de GitHub ya trae ese lenguaje preinstalado (rust en ubuntu-latest).
  const RUNTIMES = {
    node: { gitlabImage: (v) => `node:${v}`, ghSetup: (v) => ({ uses: 'actions/setup-node@v7', with: { 'node-version': v } }) },
    python: { gitlabImage: () => 'python:3.12-slim', ghSetup: () => ({ uses: 'actions/setup-python@v5', with: { 'python-version': '3.12' } }) },
    go: { gitlabImage: () => 'golang:1.23', ghSetup: () => ({ uses: 'actions/setup-go@v5', with: { 'go-version': '1.23' } }) },
    rust: { gitlabImage: () => 'rust:1.82', ghSetup: () => null },
    java: { gitlabImage: () => 'eclipse-temurin:21-jdk', ghSetup: () => ({ uses: 'actions/setup-java@v4', with: { distribution: 'temurin', 'java-version': '21' } }) },
    ruby: { gitlabImage: () => 'ruby:3.3', ghSetup: () => ({ uses: 'ruby/setup-ruby@v1', with: { 'ruby-version': '3.3' } }) },
    php: { gitlabImage: () => 'php:8.3-cli', ghSetup: () => ({ uses: 'shivammathur/setup-php@v2', with: { 'php-version': '8.3' } }) },
    dotnet: { gitlabImage: () => 'mcr.microsoft.com/dotnet/sdk:8.0', ghSetup: () => ({ uses: 'actions/setup-dotnet@v4', with: { 'dotnet-version': '8.0.x' } }) },
  };
  const runtimeDe = (lang, version) => {
    const r = RUNTIMES[lang];
    if (!r) return { lang: null, gitlabImage: null, ghSetup: null }; // lenguaje sin manifiesto reconocido: el comando declarado manda, el runtime lo elige el equipo
    return { lang, gitlabImage: r.gitlabImage(version), ghSetup: r.ghSetup(version) };
  };

  // PLAN DE CI: los MISMOS gates que corre 'harness.js gates', en forma de {name, run}, mas el
  // RUNTIME que corresponde al lenguaje detectado, para que harness.js los traduzca al YAML de la
  // forja que corresponda (.gitlab-ci.yml / GitHub Actions). code.js NO conoce la forja (responsabilidad
  // unica); solo dice QUE ejecutar y en QUE runtime.
  const ciPlan = () => {
    const m = mode();
    if (m === 'monorepo') {
      // UN job que instala en la raiz y corre cada gate en las apps CAMBIADAS (+ dependientes) con el
      // filtro nativo de pnpm '...[origin/<destino>]'; en push a develop/main el filtro va vacio = todas.
      // (Un job por app con 'paths' no sirve en GitHub: 'paths' filtra el workflow entero, no un job.)
      const pm = pkgManager();
      const lista = appsWs();
      const gates = [];
      const recursivo = (x) => (pm === 'pnpm' ? `pnpm -r $FARO_FILTRO --if-present run ${x}` : pm === 'npm' ? `npm run ${x} --workspaces --if-present` : `yarn workspaces foreach --all run ${x}`);
      for (const g of GATES_NODE) if (lista.some((a) => scriptsDe(a)[g])) gates.push({ name: g, run: recursivo(g) });
      for (const a of lista) if (a.worker && !placeholdersApp(a)) gates.push({ name: `deploy-dry-run-${a.id}`, run: simulacroApp(a).run });
      const dg = declaredGates();
      if (dg) gates.push({ name: 'faro-gates', run: dg });
      return { mode: m, runtime: conGestor(runtimeDe('node', nodeVersion()), pm), install: instalarCmd(pm), gates, filtroCambios: pm === 'pnpm' ? 'FARO_FILTRO' : null };
    }
    if (m === 'cloudflare') {
      const pm = pkgManager();
      const gates = [];
      if (hasScript('typecheck')) gates.push({ name: 'typecheck', run: `${pm} run typecheck` });
      if (hasScript('lint')) gates.push({ name: 'lint', run: `${pm} run lint` });
      if (hasScript('test')) gates.push({ name: 'test', run: `${pm} run test` });
      if (!wranglerPlaceholders().length) gates.push({ name: 'deploy-dry-run', run: simulacroDespliegue().run });
      return { mode: m, runtime: conGestor(runtimeDe('node', nodeVersion()), pm), install: instalarCmd(pm), gates };
    }
    if (esGenerico(m)) {
      const gates = [];
      let runtime = runtimeDe(detectStack(), nodeVersion()); // detectStack(): node/python/go/rust/java/ruby/php/dotnet/null
      let install = null;
      if (readPkg()) {
        const pm = pkgManager();
        runtime = conGestor(runtimeDe('node', nodeVersion()), pm); install = instalarCmd(pm);
        for (const s of ['typecheck', 'lint', 'test', 'build']) if (hasScript(s)) gates.push({ name: s, run: `${pm} run ${s}` });
      }
      const dg = declaredGates();
      if (dg) gates.push({ name: 'faro-gates', run: dg });
      return { mode: m, runtime, install, gates };
    }
    return { mode: 'none', runtime: { lang: null, gitlabImage: null, ghSetup: null }, install: null, gates: [] };
  };

  return { mode, hasCode, infraLines, gateReadinessLines, skillRoutingLines, testDisciplineLines, cmdGates, cmdInfra, cmdDeps, depsLines, gateResults: runGates, alcanceApps, isDeployCmd, deployNote, validationIssues, ciPlan, simulacroDespliegue };
};
