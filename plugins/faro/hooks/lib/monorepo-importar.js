// lib/monorepo-importar.js — `harness.js monorepo importar`: levantar un FARO nuevo e IMPORTAR repos
// existentes como apps, con su historial y su gestion consolidada en la raiz (#162).
//
// Flujo por origen:
//   1. validar (id, rama, modo, origen: patron estricto, MISMA organizacion que la sesion);
//   2. traerlo a un directorio TEMPORAL con `git clone` (solo lectura: el origen no se modifica);
//   3. historial: reescribir la historia de esa copia bajo apps/<id>/ (git filter-branch con un
//      index-filter FIJO) y fusionarla con `merge --allow-unrelated-histories` -> `git log --follow`
//      atraviesa la importacion. Modo 'copia': solo los ficheros, con el origen documentado en el plan;
//   4. consolidar su gestion en la raiz (lib/monorepo-gestion.js) y declarar la app (lib/monorepo.js).
//
// SEGURIDAD: no se ejecuta NADA del repo importado (ni scripts, ni hooks: core.hooksPath vacio en la
// copia temporal); los valores que vienen del usuario o del plan llegan a git solo tras validarse y
// siempre tras '--' o como valor de una opcion; nunca shell. Dry-run por defecto.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const mp = require('./monorepo-plan.js');
const mg = require('./monorepo-gestion.js');
const mono = require('./monorepo.js');

const ENV_GIT = { ...process.env, GIT_TERMINAL_PROMPT: '0', FILTER_BRANCH_SQUELCH_WARNING: '1', GIT_ALLOW_PROTOCOL: 'https:file', GIT_CONFIG_NOSYSTEM: '1' };
const sh = (cwd, args, extra = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: ENV_GIT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 900000, maxBuffer: 256 * 1024 * 1024, ...extra });
const limpiarMsg = (e) => String((e && (e.stderr || e.message)) || e).split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' · ').slice(0, 300);

// index-filter FIJO: antepone apps/<id>/ a cada ruta del indice. Solo se le inyecta el id YA validado.
const scriptPrefijo = (id) => { if (!mp.validarId(id)) throw new Error("id de app inválido"); return `git ls-files -s | sed "s-\\t\\"*-&apps/${id}/-" | GIT_INDEX_FILE=$GIT_INDEX_FILE.new git update-index --index-info && mv "$GIT_INDEX_FILE.new" "$GIT_INDEX_FILE"`; };

/** {org, repo} del remote `origin` de un repo local, o null. */
function remotoDe(ruta) {
  const url = (mono.gitOut(ruta, ['remote', 'get-url', 'origin']) || '').trim();
  const m = url.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? { org: m[1], repo: m[2] } : null;
}

/** Valida UN origen completo (forma + organizacion). -> { ok, fuente(parseFuente), error }. */
function validarOrigen(texto, org, { permitirRuta = false } = {}) {
  const f = mp.parseFuente(texto, { org, permitirRuta });
  if (!f.ok) return { ok: false, error: `Origen '${String(texto).slice(0, 80)}': ${f.error}.` };
  if (f.tipo === 'repo' && !org) return { ok: false, error: `Origen '${texto}': no detecto la organización de este repositorio (remote origin), así que no puedo comprobar que el origen es de la misma; usa una ruta local o configura el remote.` };
  if (f.tipo === 'ruta') {
    const rem = remotoDe(f.ruta);
    if (!rem) return { ok: false, error: `Origen '${texto}': la ruta local no tiene un remote origin de GitHub, así que no puedo comprobar que es de la misma organización; clónalo desde GitHub o impórtalo como org/repo.` };
    if (!org || rem.org.toLowerCase() !== org.toLowerCase()) return { ok: false, error: `Origen '${texto}': su remote pertenece a otra organización (${rem.org}); solo se importa de ${org || 'la organización de esta sesión'} (no detecto la de este repo si es null).` };
  }
  return { ok: true, fuente: f };
}

function traer(f, rama, tmp) {
  const vacio = path.join(tmp, 'sin-hooks'); fs.mkdirSync(vacio, { recursive: true });
  const dest = path.join(tmp, 'repo');
  const src = f.tipo === 'repo' ? f.url : f.ruta;
  sh(tmp, ['-c', `core.hooksPath=${vacio}`, '-c', 'protocol.ext.allow=never', 'clone', '-q', '--no-hardlinks', ...(rama ? ['--branch', rama, '--single-branch'] : []), '--', src, dest]);
  const ramaReal = (sh(dest, ['rev-parse', '--abbrev-ref', 'HEAD']).trim());
  if (!ramaReal || ramaReal === 'HEAD' || !mp.validarRama(ramaReal)) throw new Error('el origen no tiene una rama utilizable (HEAD suelto o nombre no permitido).');
  return { dir: dest, rama: ramaReal, commit: sh(dest, ['rev-parse', 'HEAD']).trim(), vacio };
}

function abortarMerge(root) { try { sh(root, ['merge', '--abort']); } catch { /* sin merge en curso */ } }

/** Rutas con modo 120000 (symlink) en la salida de `git ls-files -s -z`. Pura, testeable. */
function enlacesEnIndice(salida) {
  return String(salida || '').split('\0').filter(Boolean).filter((l) => l.startsWith('120000 ')).map((l) => l.slice(l.indexOf('\t') + 1));
}

const ficherosRastreados =(dir) => sh(dir, ['ls-files', '-z']).split('\0').filter(Boolean);

function copiarFicheros(dirOrigen, root, id) {
  let n = 0;
  for (const rel of ficherosRastreados(dirOrigen)) {
    if (rel.split('/').some((s) => s === '..' || s === '') || path.isAbsolute(rel)) throw new Error(`ruta no permitida en el origen: ${rel}`);
    const de = path.join(dirOrigen, rel);
    let st; try { st = fs.lstatSync(de); } catch { continue; }
    if (!st.isFile()) continue;
    const a = path.join(root, 'apps', id, rel);
    fs.mkdirSync(path.dirname(a), { recursive: true });
    fs.copyFileSync(de, a); n++;
  }
  return n;
}

function borrarTmp(tmp) { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temporal del sistema */ } }

/** Entrada de plan para un origen (la del plan guardado si existe, mezclada con lo dado). */
function entradaPlan(plan, item) {
  const previa = plan && plan.apps.find((a) => a.id === item.app) || {};
  return previa;
}

/**
 * Importa (o simula) UN origen. -> { ok, lineas:[], errores:[], bloqueos:[], decisiones:[], aplicado, nada }.
 */
function importarUna(root, item, { confirmo, ctx, plan }) {
  const out = { lineas: [], errores: [], bloqueos: [], decisiones: [], avisos: [], aplicado: false, nada: false };
  const id = item.app; const dest = mp.rutaDeApp(id);
  const yaExiste = fs.existsSync(path.join(root, dest));
  const previa = entradaPlan(plan, item);
  const rol = item.rol || previa.rol || ((ctxCfgApps(root)[id] || {}).rol) || null;
  if (yaExiste && !item.actualizar) { out.nada = true; out.lineas.push(`apps/${id}: ya importada (usa --actualizar para traer lo nuevo del origen).`); return out; }
  if (!yaExiste && item.actualizar) { out.errores.push(`apps/${id} no existe: no hay nada que actualizar (importa primero).`); return out; }
  if (item.actualizar && item.modo === 'copia') { out.errores.push('--actualizar no está disponible en modo copia (no hay historia común): reimporta manualmente.'); return out; }
  if (!rol && !item.actualizar) out.decisiones.push({ id: `rol:${id}`, bloquea: true, pregunta: `Falta el rol de la app ${id}: ¿qué es y para qué sirve? (una frase; --rol "<frase>")` });

  const g = mono.estadoGit(root);
  if (!g.git) out.bloqueos.push('El directorio no es un repositorio git.');
  else {
    if (g.protegida) out.bloqueos.push(`Estás en '${g.rama}': trabaja en una rama de trabajo anclada a un issue (feat/<N>-<slug>); nunca en main ni develop.`);
    else if (!g.anclada) out.bloqueos.push(`La rama '${g.rama}' no está anclada a un issue (feat/<N>-<slug>).`);
    if (g.sucio.length) out.bloqueos.push(`El árbol no está limpio (${g.sucio.length} cambio(s) o fichero(s) sin versionar, p. ej. ${g.sucio[0].trim()}): commitea o descarta antes de importar.`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-import-'));
  try {
    let t;
    try { t = traer(item.fuente, item.rama, tmp); } catch (e) { out.errores.push(`No pude traer el origen (solo lectura): ${limpiarMsg(e)}`); return out; }
    // Enlaces simbolicos (modo 120000) en el origen: NO se importa nada. Un enlace podria apuntar a
    // ficheros fuera del repo y la consolidacion los leeria/movería. Se aborta antes de tocar la raiz.
    const enlaces = enlacesEnIndice(sh(t.dir, ['ls-files', '-s', '-z']));
    if (enlaces.length) { out.errores.push(`El origen contiene ${enlaces.length} enlace(s) simbólico(s) (p. ej. ${enlaces[0]}): no se importa. Sustitúyelos por ficheros reales en el origen y repite.`); return out; }
    const rastreados = ficherosRastreados(t.dir);
    const nFich = rastreados.length;
    const secretos = rastreados.filter((x) => /(^|\/)(\.env(\.[^/]*)?|\.dev\.vars(\.[^/]*)?)$/.test(x) && !/\.(example|sample|template)$/.test(x));
    if (secretos.length) out.avisos.push(`El origen versiona ${secretos.length} fichero(s) de secretos (${secretos.slice(0, 3).join(', ')}${secretos.length > 3 ? '…' : ''}): quedarán en el historial importado; revisa y rota esos secretos.`);
    const attrs = rastreados.filter((x) => /(^|\/)\.gitattributes$/.test(x));
    if (attrs.length) out.avisos.push(`El origen trae .gitattributes (${attrs.slice(0, 2).join(', ')}) que quedará en apps/${id}/: no cambia el comportamiento del repo raíz, pero revísalo.`);
    if (rastreados.some((x) => /(^|\/)\.gitignore$/.test(x) && x !== '.gitignore')) out.avisos.push('El origen trae .gitignore anidados: se conservan donde están.');
    const usados = (plan ? plan.apps : []).filter((a) => a.id !== id && Number.isInteger(a.desplazamiento)).map((a) => a.desplazamiento);
    const dz = Number.isInteger(previa.desplazamiento) ? previa.desplazamiento : mg.siguienteDesplazamiento(usados);
    const origenIssues = item.fuente.tipo === 'repo' ? { org: item.fuente.org, repo: item.fuente.repo } : remotoDe(item.fuente.ruta);
    if (!item.actualizar) {
      const c = mg.planConsolidar(root, id, { desplazamiento: dz, clave: previa.clave, origen: origenIssues, plan, leerDe: t.dir });
      out.consolidacion = c;
      out.decisiones.push(...c.decisiones); out.avisos.push(...c.avisos);
      if (item.fuente.tipo === 'ruta' && !origenIssues) out.avisos.push(`Los issues del origen (#N) no se califican (org/repo#N): ${id} es una ruta local sin remote de GitHub.`);
      out.lineas.push(`${item.fuente.tipo === 'repo' ? `${item.fuente.org}/${item.fuente.repo}` : item.fuente.ruta} (${t.rama} @ ${t.commit.slice(0, 7)}, ${nFich} ficheros) → ${dest} · ${item.modo === 'copia' ? 'copia (sin historial)' : 'con historial'}`);
      out.lineas.push(...mono.lineasConsolidacion(c));
    } else out.lineas.push(`${dest}: actualizar desde ${t.rama} @ ${t.commit.slice(0, 7)} (${nFich} ficheros)`);
    if (!confirmo) return out;
    if (out.bloqueos.length || out.decisiones.some((d) => d.bloquea)) { out.errores.push('No aplico: hay bloqueos o decisiones pendientes (ver arriba).'); return out; }

    // ---- traer el codigo
    const mensaje = `feat(monorepo): ${item.actualizar ? 'actualiza' : 'importa'} ${item.fuente.tipo === 'repo' ? `${item.fuente.org}/${item.fuente.repo}` : path.basename(item.fuente.ruta)} en ${dest}${item.modo === 'copia' ? ' (copia)' : ' (historial conservado)'}`;
    try {
      if (item.modo === 'copia') {
        copiarFicheros(t.dir, root, id);
        sh(root, ['add', '-A', '--', dest]);
      } else {
        sh(t.dir, ['-c', `core.hooksPath=${t.vacio}`, 'filter-branch', '-f', '--index-filter', scriptPrefijo(id), '--', t.rama]);
        sh(root, ['fetch', '-q', '--no-tags', '--', t.dir, `refs/heads/${t.rama}`]);
        try { sh(root, ['merge', '-q', '--no-commit', '--allow-unrelated-histories', 'FETCH_HEAD']); } catch (e) {
          try { sh(root, ['merge', '--abort']); } catch { /* nada que abortar */ }
          throw new Error(`la fusión de la historia tiene conflictos o falló (${limpiarMsg(e)}); el repositorio queda como estaba.`);
        }
      }
    } catch (e) { out.errores.push(`Importación: ${e.message}`); return out; }

    // ---- trazabilidad en el plan
    const nueva = { id, rol: rol || previa.rol, ...(previa.funcional ? { funcional: previa.funcional } : {}), ...(previa.equipo ? { equipo: previa.equipo } : {}),
      origen: { fuente: item.fuentePlan || item.fuenteTexto, rama: t.rama, modo: item.modo, commit: t.commit }, desplazamiento: dz, ...(previa.clave ? { clave: previa.clave } : {}) };
    if (!nueva.rol) { const ex = ctxCfgApps(root)[id]; if (ex && ex.rol) nueva.rol = ex.rol; }
    const base = plan || { version: mp.PLAN_VERSION, apps: [] };
    const apps = base.apps.some((a) => a.id === id) ? base.apps.map((a) => (a.id === id ? { ...a, ...nueva } : a)) : [...base.apps, nueva];
    const nuevoPlan = { ...base, apps };
    const errPlan = mp.validarPlan(nuevoPlan, { org: ctx.org });
    if (errPlan.length) { abortarMerge(root); out.errores.push(`El plan resultante no es válido: ${errPlan.join('; ')}. La importación se ha deshecho (git merge --abort).`); return out; }
    mp.escribirPlan(root, nuevoPlan);
    sh(root, ['add', '--', mp.planFile(root)]);
    const hayMerge = (() => { try { sh(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']); return true; } catch { return false; } })();
    const hayCambios = (() => { try { sh(root, ['diff', '--cached', '--quiet']); return false; } catch { return true; } })();
    if (hayMerge || hayCambios) {
      try { sh(root, ['commit', '-q', '-m', mensaje]); } catch (e) {
        out.errores.push(`No pude crear el commit (${limpiarMsg(e)}). Si es la firma, NO la saltes: los cambios quedan en el índice${hayMerge ? ' (merge en curso; para deshacerlo: git merge --abort)' : ''}; completa con 'git commit' y repite para el resto.`);
        return out;
      }
      out.lineas.push(`commit: ${mensaje}`);
    } else out.lineas.push(`${dest}: sin novedades en el origen.`);
    out.aplicado = true;
    out.plan = nuevoPlan;
    return out;
  } finally { borrarTmp(tmp); }
}

function ctxCfgApps(root) {
  try { const j = JSON.parse(mg.leerSeguro(require('./config-repo.js').rutaAbs(root))); return (j.monorepo && j.monorepo.apps) || {}; } catch { return {}; }
}

/** Declara las apps, consolida la gestion y deja el commit hecho. -> { hechos, errores } */
function declararYConsolidar(root, ctx, mensaje) {
  const p = mono.planInit(root, { consolidar: true, schema: ctx.schema, org: ctx.org, crearPackageRaiz: true, codeowners: undefined });
  const res = { hechos: [], errores: [], plan: p };
  if (p.errores.length) { res.errores.push(...p.errores); return res; }
  if (p.nada) return res;
  if (!p.aplicable) { res.errores.push(`No puedo declarar/consolidar: ${[...p.bloqueos, ...p.decisiones.filter((d) => d.bloquea).map((d) => d.pregunta)].join(' · ')}`); return res; }
  const a = mono.aplicarInit(root, p, { git: true, codeownersFn: ctx.codeownersFn });
  res.hechos.push(...a.hechos); res.errores.push(...a.errores);
  if (!a.errores.length) {
    try { sh(root, ['commit', '-q', '-m', mensaje]); res.hechos.push(`commit: ${mensaje}`); } catch (e) {
      res.errores.push(`No pude crear el commit de la consolidación (${limpiarMsg(e)}). Si es la firma, NO la saltes: los cambios quedan en el índice; commitea a mano.`);
    }
  }
  return res;
}

/**
 * `monorepo importar`: o = parseArgs(...) de monorepo.js; ctx = { root, schema, org, log, codeownersFn, ensureLabels }.
 */
async function cli(o, ctx) {
  const log = ctx.log || console.log;
  const root = ctx.root;
  const confirmo = o.flags.has('--confirmo');
  const json = o.flags.has('--json');
  const actualizar = o.flags.has('--actualizar');
  const errores = [];
  const lp = mp.leerPlan(root, { org: ctx.org });
  if (lp && lp.errores.length) { log(lp.errores.map((e) => `- ${e}`).join('\n')); return 1; }
  const plan = lp ? lp.plan : null;
  const modo = o.valores.modo || 'subtree';
  if (!mp.MODOS.includes(modo)) errores.push(`--modo '${o.valores.modo}' inválido (${mp.MODOS.join(' o ')}).`);
  if (o.valores.rama !== undefined && !mp.validarRama(o.valores.rama)) errores.push(`--rama '${String(o.valores.rama).slice(0, 40)}' inválida (nombre de rama sin opciones, espacios ni '..').`);

  // ---- pares origen/app: de la linea de comandos o del plan
  const items = [];
  if (o.posicionales.length) {
    if (o.posicionales.length !== o.apps.length) errores.push(`Cada origen necesita su --app <id>: ${o.posicionales.length} origen(es) y ${o.apps.length} --app.`);
    else o.posicionales.forEach((f, i) => items.push({ fuenteTexto: f, app: o.apps[i], viaCli: true }));
  } else if (o.apps.length) {
    for (const id of o.apps) {
      const e = plan && plan.apps.find((a) => a.id === id && a.origen);
      if (e) items.push({ fuenteTexto: e.origen.fuente, app: id, rama: e.origen.rama, modo: e.origen.modo });
      else errores.push(`--app ${id}: falta el origen (pásalo como argumento o guárdalo en ${mp.planFile(root)}).`);
    }
  } else if (plan) {
    for (const a of plan.apps) if (a.origen) items.push({ fuenteTexto: a.origen.fuente, app: a.id, rama: a.origen.rama, modo: a.origen.modo });
    if (!items.length) errores.push(`${mp.planFile(root)} no tiene ninguna app con 'origen'.`);
  } else errores.push('Uso: harness.js monorepo importar <org/repo|url|ruta> --app <id> [--rol "<frase>"] [--rama <r>] [--modo subtree|copia] [--actualizar] [--dry-run|--confirmo] (o guarda los orígenes en gestion/monorepo-plan.json).');
  const vistos = new Set();
  for (const it of items) {
    if (!mp.validarId(it.app)) { errores.push(`--app '${String(it.app).slice(0, 40)}' inválido: minúsculas, dígitos y guiones (hasta 40, sin '/' ni '..').`); continue; }
    if (vistos.has(it.app)) { errores.push(`la app '${it.app}' está repetida.`); continue; }
    vistos.add(it.app);
    const v = validarOrigen(it.fuenteTexto, ctx.org, { permitirRuta: !!it.viaCli });
    if (!v.ok) { errores.push(v.error); continue; }
    it.fuente = v.fuente;
    // en el plan se guarda SIEMPRE org/repo (portable y sin rutas locales), tambien si se importo desde una ruta
    const rm = v.fuente.tipo === 'ruta' ? remotoDe(v.fuente.ruta) : null;
    it.fuentePlan = v.fuente.tipo === 'repo' ? it.fuenteTexto : `${rm.org}/${rm.repo}`;
    it.rama = o.valores.rama || it.rama; it.modo = o.valores.modo || it.modo || 'subtree'; it.rol = o.valores.rol; it.actualizar = actualizar;
    if (it.rama !== undefined && !mp.validarRama(it.rama)) errores.push(`rama '${String(it.rama).slice(0, 40)}' inválida para ${it.app}.`);
    if (!mp.MODOS.includes(it.modo)) errores.push(`modo '${it.modo}' inválido para ${it.app}.`);
  }
  if (errores.length) { log(`MONOREPO IMPORTAR — no puedo continuar:\n${errores.map((e) => `- ${e}`).join('\n')}`); return 2; }

  // ---- cada origen
  let codigo = 0;
  const informe = [];
  let planVivo = plan;
  for (const it of items) {
    const r = importarUna(root, it, { confirmo, ctx, plan: planVivo });
    informe.push({ app: it.app, ...r });
    log(`\nMONOREPO IMPORTAR — ${it.app}${confirmo ? '' : ' · DRY-RUN (no se ha tocado nada)'}`);
    r.lineas.forEach((l) => log(l.startsWith('-') || l === '' ? l : `${l}`));
    if (r.decisiones.length) { log('\nDECISIONES que requieren criterio (nunca se resuelven en silencio):'); r.decisiones.forEach((d) => log(`- [${d.id}] ${d.pregunta}${d.opciones && d.opciones.length ? ` (${d.opciones.join(' | ')}; por defecto ${d.defecto})` : ''}`)); }
    if (r.avisos.length) { log('\nAvisos:'); r.avisos.forEach((a) => log(`- ${a}`)); }
    if (r.bloqueos.length) { log('\nBLOQUEOS para aplicar:'); r.bloqueos.forEach((b) => log(`- ${b}`)); }
    if (r.errores.length) { log('\nERRORES:'); r.errores.forEach((e) => log(`- ${e}`)); codigo = 1; break; }
    if (r.aplicado && !it.actualizar) {
      const d = declararYConsolidar(root, ctx, `chore(monorepo): consolida la gestión de ${it.app} en la raíz`);
      d.hechos.forEach((h) => log(`- ${h}`));
      if (d.errores.length) { log('\nERRORES:'); d.errores.forEach((e) => log(`- ${e}`)); codigo = 1; break; }
      const lp2 = mp.leerPlan(root, { org: ctx.org });
      planVivo = lp2 ? lp2.plan : planVivo;
    } else if (r.aplicado) planVivo = r.plan;
  }
  if (confirmo && !codigo && informe.some((x) => x.aplicado) && ctx.ensureLabels) {
    try { const l = await ctx.ensureLabels(mono.planInit(root, { schema: ctx.schema, org: ctx.org }).apps.filter((a) => a.rol)); if (l.length) log(`- etiquetas en la forja: ${l.join(', ')}.`); } catch { /* best-effort */ }
  }
  if (!confirmo && !codigo) log('\nPara aplicarlo en esta rama: añade --confirmo (cada origen genera su commit; nada se hace sobre develop ni main).');
  if (confirmo && !codigo && informe.some((x) => x.aplicado)) log("\nSiguiente: 'harness.js validate', revisa las decisiones pendientes (fusión de faseos) y abre el PR.");
  if (json) log(JSON.stringify(informe.map((x) => ({ app: x.app, aplicado: x.aplicado, nada: x.nada, errores: x.errores, bloqueos: x.bloqueos, decisiones: x.decisiones, consolidacion: x.consolidacion || null })), null, 2));
  return codigo;
}

module.exports = { enlacesEnIndice, cli, importarUna, validarOrigen, remotoDe, scriptPrefijo, traer, ficherosRastreados, borrarTmp, limpiarMsg, sh };
