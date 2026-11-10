// flows/adoptar.mjs — flujo ADOPTAR (fase 1, mecánica): reenfoca una carpeta EXISTENTE hacia el
// harness SIN tocar el stack (colisiones -> *.faro), la sube a la forja y estampa la clasificación v2.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as p from '@clack/prompts';
import { argVal, paso, say, C, elige, pasoElige, correrPasos, pregunta, ok, confirma, YES, warn, DRY, caja, fail, run, runState, spinner, ui } from '../lib/core.mjs';
import { slugify, dominiosVisibles } from '../lib/model.mjs';
import { detectarDeclarada } from '../lib/forja-propia.mjs';
import { perfilesConocidos } from '../lib/perfil.mjs';
import { tokenPara } from '../lib/credenciales.mjs';
import { overrideMarketplace, usuarioHttp } from '../lib/gitcred.mjs';
import { nombreForja } from '../lib/sesion.mjs';
import { RAIZ_ESQUELETO } from '../lib/esqueleto.mjs';
import { archivarRepo } from '../lib/migrar.mjs';
import { mostrarPermisos } from './preparar.mjs';
import { asegurarMantenedor } from '../lib/alta.mjs';
import { elegirValidacion } from './paso-validacion.mjs';
import { consultaCi, generarCi } from '../lib/validacion.mjs';
import { configurarRemotoSeamless, asegurarPluginSuperpowers, asegurarCredencialesPlugins, revisarPlantillasLegadas, overlayFaro, mergeGitignore, FARO_ROOTS, carpetasFaroQueFaltan, inventarioRamas, asegurarDevelopLocal, normalizarPrincipalLocal, cdSugerido, estamparIdentidad, escribirSettingsPlugin, migrarCopiaLegada, leerMetaRepo, escribirMetaRepo, aplicarExigirPipeline } from '../lib/repo.mjs';

// ADOPTAR (fase 1, mecánica): reenfoca una carpeta EXISTENTE hacia el harness SIN tocar el stack.
async function flujoAdoptar(auth, org, cfg, catalogo, esOwner, ctx) {
  const destino = path.resolve((ctx && ctx.dir) || argVal('dir') || process.cwd());
  const { perfil, forja: { alta } } = ctx;
  const esGitlab = perfil.forja === 'gitlab';
  const host = perfil.host;
  const usuario = usuarioHttp(perfil.forja);
  const forjaTexto = nombreForja(perfil.forja);
  const s = { host, token: auth.token };
  const rutaRepo = () => `${org}/${repoName}`;
  paso('Diagnóstico de la carpeta');
  say(`  Carpeta: ${C.b}${destino}${C.x}`);
  // GUARD (lección de un repo real, 2026-07-30): si la carpeta está DENTRO de un repo git pero NO es su
  // raíz, adoptar aquí haría 'git init' anidado -> repo espurio dentro del repo real. Se bloquea.
  {
    let topLevel = null;
    try { topLevel = execFileSync('git', ['-C', destino, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
    if (topLevel && path.resolve(topLevel).toLowerCase() !== destino.toLowerCase()) {
      fail(`Esta carpeta está DENTRO del repo git ${topLevel} (no es su raíz). Adoptar aquí crearía un repo anidado espurio.`);
      say(`${C.d}  Ve a la raíz real (cd "${topLevel}") y reejecuta, o usa --dir=<raíz>.${C.x}`);
      return;
    }
  }
  const has = (f) => fs.existsSync(path.join(destino, f));
  const gitLocal = (a) => { try { return execFileSync('git', ['-C', destino, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  // E) Detección de stack FINA: worker (wrangler) · app (framework) · Python/Go · documental.
  let naturaleza = argVal('naturaleza');
  let stack = '';
  if (!naturaleza) {
    if (has('wrangler.toml') || has('wrangler.jsonc') || has('wrangler.json')) { naturaleza = 'worker'; stack = 'Cloudflare Worker'; }
    else if (has('package.json')) {
      naturaleza = 'app';
      stack = (has('next.config.js') || has('next.config.mjs') || has('next.config.ts')) ? 'Next.js'
        : (has('vite.config.js') || has('vite.config.ts')) ? 'Vite'
        : (has('astro.config.mjs') || has('astro.config.ts')) ? 'Astro'
        : (has('nuxt.config.ts') || has('nuxt.config.js')) ? 'Nuxt'
        : has('angular.json') ? 'Angular' : 'Node/JS';
    }
    else if (has('requirements.txt') || has('pyproject.toml')) { naturaleza = 'app'; stack = 'Python'; }
    else if (has('go.mod')) { naturaleza = 'app'; stack = 'Go'; }
    else { naturaleza = 'documental'; stack = ''; }   // la etiqueta ya lo dice; sin duplicar "(sin codigo)"
  }
  if (!catalogo.naturalezas[naturaleza]) naturaleza = 'documental';
  ok(`Tipo de repo: ${catalogo.naturalezas[naturaleza].etiqueta}${stack ? ` ${C.d}(${stack})${C.x}` : ''}`);
  if (!YES && !(await confirma('¿Es correcto?'))) naturaleza = await elige('¿Qué tipo de repo es?', catalogo.naturalezas);
  const nat = catalogo.naturalezas[naturaleza];
  const tieneGit = has('.git');
  const remoteViejo = tieneGit ? gitLocal(['remote', 'get-url', 'origin']) : null;
  say(`  Git: ${tieneGit ? 'sí' : 'no'}${remoteViejo ? ` · remoto: ${C.d}${remoteViejo}${C.x}` : ''}`);
  const inv = tieneGit ? inventarioRamas(gitLocal) : null;
  if (inv) {
    say(`  Rama actual: ${C.b}${inv.ramaActual}${C.x} ${C.d}→ será la fuente (develop)${C.x}`);
    if (inv.otrasRamas.length) say(`  ${C.d}Otras ramas locales (NO se suben): ${inv.otrasRamas.join(', ')}${C.x}`);
  }
  // F) Avisos: ¿ya es FARO? · ¿git sucio?
  const metaPrevia = leerMetaRepo(destino);   // .faro.json
  if (metaPrevia) {
    warn('Esta carpeta YA es un repo FARO (metadato presente).');
    // Dos necesidades distintas (decision 2026-07-30): PONER AL DIA un repo legado = check (doctor);
    // RE-ADOPTAR solo tiene sentido para RECLASIFICAR (área — el nombre nunca cambia aqui).
    const q = YES ? 'reclasificar' : await elige('Este repo ya es FARO. ¿Qué necesitas?', {
      actualizar: { etiqueta: 'Ponerlo al día (check)', explica: 'Estructura, migración al plugin, ramas y servidor — sin re-clasificar.' },
      reclasificar: { etiqueta: 'Re-adoptar: cambiar la clasificación', explica: 'El área. El nombre NO cambia.' },
      cancelar: { etiqueta: 'Cancelar', explica: 'No tocar nada.' },
    });
    if (q === 'cancelar') { say('  Cancelado.'); return; }
    if (q === 'actualizar') {
      ui.pasoN = 1; ui.pasoT = 4;   // el contador sigue coherente en el flujo check (la sesion ya fue el paso 1)
      const { flujoCheck } = await import('./check.mjs');
      await flujoCheck(auth, org, cfg, catalogo, esOwner, ctx);
      return;
    }
  }
  if (tieneGit) { const sucio = gitLocal(['status', '--porcelain']); if (sucio) warn(`Cambios git sin commitear (${sucio.split('\n').filter(Boolean).length} fichero(s)) — entrarán en el commit de adopción.`); }

  paso('Clasificar');
  // Solo el ÁREA (dominio). La ENTIDAD la clasifica el harness, no el CLI.
  const clasif = await correrPasos([
    { key: 'domain', run: (_, ctx) => pasoElige('¿De qué área es?', dominiosVisibles(catalogo.dominios, esOwner), argVal('domain') || argVal('departamento') || argVal('area'), ctx) },
  ]);
  const { domain } = clasif;
  if (metaPrevia && metaPrevia.domain && metaPrevia.domain !== domain) warn(`El metadato tenía domain='${metaPrevia.domain}'; lo actualizo a '${domain}'.`);
  // NOMBRE: si el repo YA apunta a la org, se REUTILIZA el del remoto — re-adoptar NO es renombrar
  // y preguntar aqui invitaba a crear un SEGUNDO repo por error.
  // Solo se pregunta cuando la carpeta no tiene aun repo destino en la org.
  let repoName = null;
  const fRem = detectarDeclarada(remoteViejo, { dir: destino, perfiles: perfilesConocidos(cfg) });
  const mismaOrg = !!(fRem.host && fRem.host === host && (esGitlab ? String(fRem.path).toLowerCase().startsWith(String(org).toLowerCase() + '/') : String(fRem.owner).toLowerCase() === String(org).toLowerCase()));
  const migrado = ctx && ctx.repoNombre;   // traer acaba de migrarla: el repo destino ya existe
  if (mismaOrg || migrado) {
    repoName = migrado || fRem.project;
    ok(`Repo destino: ${org}/${repoName} ${C.d}(el del remoto actual)${C.x}`);
  } else {
    const bruto = argVal('nombre') || await pregunta('Nombre del proyecto en lenguaje normal', path.basename(destino), (val) => slugify(val || '') ? undefined : 'Nombre inválido — usa letras/números.');
    const slug = slugify(bruto);
    if (!slug) { fail('Nombre inválido.'); return; }
    repoName = slug;   // nombre NATURAL, sin prefijo (el marcador FARO es el topic `faro`).
  }
  const topics = ['faro', `dom-${domain}`, `nat-${naturaleza}`];
  if (domain === 'innovacion') topics.push('innovacion');

  // GitLab: ORDEN. Los proyectos pueden colgar del grupo raiz o de un subgrupo (clientes, areas...).
  // Si el grupo tiene subgrupos y no vino --org, se elige donde cae el proyecto. Con --yes: la raiz.
  if (esGitlab && !ctx.destino.personal && !mismaOrg && !argVal('org') && !YES && !DRY) {
    const subs = await ctx.forja.subgrupos(host, auth.token, org);
    const ops = { [org]: { etiqueta: `${org} (raíz)`, explica: 'Directamente en el grupo.' } };
    for (const s of subs) ops[s.path] = { etiqueta: s.name, explica: s.path };
    ops.__nuevo = { etiqueta: '➕ Crear un subgrupo nuevo…', explica: 'Para ordenar: un cliente, un área. Exige ser Owner del grupo.' };
    const donde = await elige('¿Dónde cuelga el proyecto en GitLab?', ops);
    if (donde === '__nuevo') {
      const nombreSub = await pregunta('Nombre del subgrupo (ej. "Cliente Acme")', undefined, (v) => slugify(v || '') ? undefined : 'Nombre inválido.');
      const cs = await ctx.forja.crearSubgrupo(host, auth.token, org, nombreSub);
      if (cs.ok && cs.body && cs.body.full_path) { org = cs.body.full_path; ok(`Subgrupo creado: ${org}`); }
      else { warn(`No pude crear el subgrupo (HTTP ${cs.status})${cs.body && cs.body.message ? ': ' + JSON.stringify(cs.body.message) : ''} — sigo en la raíz.`); }
    } else org = donde;
  }

  // Dónde se validan los PR/MR (#289): recomendación según el plan del destino.
  const val = await elegirValidacion({ alta, s, cuenta: { org, personal: ctx.destino.personal }, publico: false });

  say('');
  caja([
    `${C.d}Adoptar${C.x}     ${destino}`,
    `${C.d}Repo${C.x}        ${C.g}${org}/${repoName}${C.x}`,
    `${C.d}Área${C.x}         ${domain}`,
    `${C.d}Tipo de repo${C.x} ${nat.etiqueta}`,
    `${C.d}Validación${C.x}   ${val.validacion}`,
    inv ? `${C.d}Rama fuente${C.x}  ${inv.ramaActual}  ${C.d}→ develop${C.x}` : null,
    remoteViejo ? `${C.d}Remoto viejo${C.x} ${remoteViejo}` : `${C.d}Sin remoto${C.x} previo`,
  ].filter(Boolean), { titulo: 'Adopción', color: C.g });
  say(`${C.d}  NO se toca tu código/stack: solo se añade la capa FARO (colisiones → *.faro).${C.x}`);
  if (DRY) { ok('(dry-run) Adopción validada — nada creado.'); say(''); return; }
  if (!(await confirma('¿Adelante?'))) return;
  // Salvaguarda: si otra rama local tiene commits que la actual no tiene, la actual podría no ser "la buena".
  if (inv && inv.ramasConMasCommits.length) {
    warn(`'${inv.ramasConMasCommits.join("', '")}' tiene(n) commits que '${inv.ramaActual}' no tiene. Se adoptará '${inv.ramaActual}' como fuente (→ develop); el resto NO se sube.`);
    if (!YES && !(await confirma(`¿Seguro que '${inv.ramaActual}' es la rama buena?`, 'n'))) { say('  Cancelado.'); return; }
  }

  if (!tieneGit) { run('git', ['-C', destino, 'init', '-b', 'main'], { stdio: 'ignore' }); ok('git init'); }

  paso(`Crear el repositorio en ${forjaTexto}`);
  const ex = await alta.existe(s, rutaRepo());
  if (ex === null) { fail('Error consultando el repo destino.'); return; }
  if (ex) ok(`El repo ${rutaRepo()} ya existe; lo uso.`);
  else {
    const cuenta = { org, personal: ctx.destino.personal };
    const cr = await alta.crearRepo(s, cuenta, { nombre: repoName, descripcion: `${domain} · adoptado con FARO` });
    if (!cr.ok) { fail(`No pude crear ${repoName}: ${cr.mensaje}`); return; }
    runState.repoCreado = true; ok(`Repo creado: ${cr.web}`);
    const mant = await asegurarMantenedor(ctx.forja, s, cuenta, cr.ruta, auth.id);
    if (mant.aplicado && mant.ok) ok('Eres Maintainer del proyecto (quien lo crea, lo mantiene).');
    if (mant.aplicado && !mant.ok) say(`  ${C.d}No pude fijarte como Maintainer explícito (HTTP ${mant.status}); GitLab suele darlo al creador igualmente.${C.x}`);
  }

  paso('Aplicar la capa FARO');
  const NOPROMPT = { stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } };   // usa SOLO el token de la URL; sin popup del credential manager
  const gitCred0 = ['-c', 'credential.helper=', '-c', 'credential.interactive=false'];
  // 1) ESTRUCTURA: se CREA en local, sin red. El andamio son carpetas vacias (.gitkeep) y el harness
  //    las mantiene en cada sesion.
  for (const d of carpetasFaroQueFaltan(destino)) fs.mkdirSync(path.join(destino, d), { recursive: true });
  for (const d of carpetasFaroQueFaltan(destino, { soloVacias: true })) {
    const k = path.join(destino, d, '.gitkeep');
    if (!fs.existsSync(k)) fs.writeFileSync(k, '');
  }
  // 2) CONTENIDO: lo que el plugin no sirve y el repo aun no tiene sale del esqueleto del paquete.
  if (!fs.existsSync(path.join(destino, 'CLAUDE.md')) || !fs.existsSync(path.join(destino, '.gitignore'))) {
    overlayFaro(path.join(RAIZ_ESQUELETO, 'CLAUDE.md'), path.join(destino, 'CLAUDE.md'));
    mergeGitignore(path.join(RAIZ_ESQUELETO, 'gitignore'), path.join(destino, '.gitignore'));
  }
  ok('Capa FARO aplicada (colisiones como *.faro).');

  // Metadato v2 (nuestra clasificación gana; el harness lo LEE), con MERGE sobre lo previo: conserva
  // alias y claves extra y borra el nombre legado.
  escribirMetaRepo(destino, { ...(metaPrevia || {}), domain, teams: (metaPrevia && metaPrevia.teams) || [], tags: (metaPrevia && metaPrevia.tags) || [], validacion: val.validacion });
  estamparIdentidad(destino, auth, perfil);   // identidad del LOGIN al git config local -> telemetria coherente
  // Modelo PLUGIN: retira la copia legada del harness (la existente O la que acaba de traer el overlay
  // del template) y declara la distribucion del plugin en settings — todo entra en el commit de adopcion.
  migrarCopiaLegada(destino, { perfil: ctx && ctx.perfil, override: overrideMarketplace() });
  escribirSettingsPlugin(destino, ctx && ctx.perfil ? ctx.perfil : undefined, { override: overrideMarketplace() });   // fuente segun la forja
  // Plantillas HTML de marca: las provee el plugin (siempre al dia). Una copia en el repo GANA sobre
  // la del plugin y se queda congelada, asi que se retira aqui — antes del commit, para que la
  // adopcion deje el repo coherente de una vez (no en una pasada posterior de `faro check`).
  await revisarPlantillasLegadas(destino);

  // CI de la forja (#289): el motor lo escribe con los gates del repo; no pisa uno existente.
  const ci = consultaCi(val.validacion) ? generarCi(destino, { forja: perfil.forja }) : null;
  if (ci && ci.estado === 'creado') ok(`CI de la forja generado (${ci.ruta}) con los gates del repo.`);
  else if (ci && ci.estado === 'existe') ok(`El repo ya tiene CI (${ci.ruta}): se usa el existente, no lo toco.`);
  else if (ci) say(`  ${C.d}No he generado CI (${ci.estado === 'sin-motor' ? 'no encuentro el plugin FARO instalado' : 'aún no hay gates lint/test/build'}): dentro del repo, \`harness.js ci\`. Mientras, FARO valida en local.${C.x}`);

  paso(`Subir a ${forjaTexto} (historial completo + capa FARO)`);
  run('git', ['-C', destino, 'add', '-A'], { stdio: 'ignore' });
  try { run('git', ['-C', destino, 'commit', '-m', 'chore: adopcion FARO (capa del harness + clasificacion v2)'], { stdio: 'ignore' }); } catch {}
  const authUrl = `https://${usuario}:${auth.token}@${host}/${org}/${repoName}.git`;
  run('git', ['-C', destino, 'remote', remoteViejo ? 'set-url' : 'add', 'origin', authUrl], { stdio: 'ignore' });

  // Ramas INTELIGENTES: la capa FARO se acaba de commitear en la rama ACTUAL. Según DÓNDE estés al adoptar:
  //   A) estás en la principal (main/master)     -> sube principal + crea 'develop' (que lleva la capa).
  //   B) estás en rama de trabajo y HAY main/master -> tu trabajo va a 'develop'; la principal sube tal cual
  //      (sin la capa; entra a la principal al mergear develop->principal = aprobación).
  //   C) estás en rama de trabajo y NO hay principal -> creas 'main' (=tu contenido) + 'develop' (=tu contenido).
  const push = (ref) => { const sp = spinner(`Subiendo ${ref} a ${forjaTexto} (puede tardar)`); try { run('git', [...gitCred0, '-C', destino, 'push', authUrl, ref], NOPROMPT); } finally { sp(`Subido: ${ref}`); } };
  const existe = (b) => gitLocal(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]) !== null;
  // La principal de FARO se llama 'main'. Un repo adoptado con 'master' se normaliza AQUI (antes de
  // calcular ramas y de subir): si no, el repo se quedaba con 'master' para siempre — `check` lo
  // renombraba, pero solo si alguien lo ejecutaba despues. Adoptar es el momento natural de hacerlo.
  // No toca nada si ya hay 'main', o si existen AMBAS (ambiguo: lo reporta y decide el usuario).
  const norm = normalizarPrincipalLocal(destino);
  if (norm.renombrada) ok(`Rama principal normalizada: ${C.b}master → main${C.x} ${C.d}(convención FARO)${C.x}`);
  else if (norm.motivo && norm.motivo.startsWith('existen main Y master')) warn(`El repo tiene 'main' Y 'master': no toco ninguna. Decide cuál es la principal y retira la otra.`);
  const ramaActual = gitLocal(['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
  const principalExistente = existe('main') ? 'main' : existe('master') ? 'master' : null;
  let principal;
  const fuente = ramaActual;   // la rama con la capa FARO recién commiteada = fuente de 'develop'
  if (ramaActual === principalExistente || (!principalExistente && (ramaActual === 'main' || ramaActual === 'master'))) {
    // Caso A — la rama actual ES la principal (main/master); la capa FARO ya está aquí y sube a la principal.
    push(`${ramaActual}:${ramaActual}`);
    principal = ramaActual;
  } else if (principalExistente) {
    // Caso B — rama de trabajo y EXISTE main/master: la principal sube tal cual (sin la capa hasta el merge = aprobación).
    warn(`Estás en la rama '${ramaActual}' (no es la principal). Su contenido irá a 'develop'; '${principalExistente}' queda como principal.`);
    push(`${principalExistente}:${principalExistente}`);
    principal = principalExistente;
  } else {
    // Caso C — rama de trabajo y NO hay principal: se crea 'main' desde tu contenido (con la capa).
    warn(`Estás en '${ramaActual}' y no hay principal (main/master); creo 'main' desde tu contenido.`);
    push(`${ramaActual}:main`);
    principal = 'main';
  }
  // Común a A/B/C: 'develop' local desde la fuente (con la capa) + push + default + VUELTA A DEVELOP (nunca te quedas en main).
  asegurarDevelopLocal(destino, fuente);
  push('develop:develop');
  const sd = await alta.ramaPorDefecto(s, rutaRepo(), 'develop');
  if (!sd.ok) warn('No pude fijar develop por defecto: cámbialo en la configuración del repo en la forja.');
  ok(`Principal '${principal}' subida · 'develop' ${sd.ok ? 'por defecto' : 'creada'} · estás en 'develop'. El merge a '${principal}' = aprobación.`);

  await configurarRemotoSeamless(destino, org, repoName, auth, ctx);   // remoto listo (SSH/gh/https limpio), sin token en .git/config; NO configura SSH de otra cuenta
  const rt = await alta.estamparTopics(s, rutaRepo(), topics);
  if (rt.ok) ok(`Topics aplicados: ${topics.join(' · ')}`); else warn('No pude aplicar los topics (no bloquea).');
  await alta.configurar(s, rutaRepo(), { descripcion: `${repoName} · ${nat.etiqueta} · dom-${domain}` });
  if (!ctx.destino.personal) say(`  ${C.d}Es privado: quizá solo tú lo veas hasta que des acceso a tu equipo desde la forja.${C.x}`);
  ok('Historial + capa FARO subidos.');

  const pr = await alta.proteger(s, rutaRepo(), principal);
  if (pr.ok) ok(`Rama '${principal}' protegida.`);
  else say(`  ${C.d}'${principal}' no queda protegida en la forja (HTTP ${pr.status}: falta plan o permiso); el harness la protege en local.${C.x}`);
  if (ci) await aplicarExigirPipeline({ ci, meta: val, perfil, auth, ruta: rutaRepo(), alta, subido: true });

  // plugin superpowers: adoptar lo aplica. (Specs spec-driven = motor nativo del harness, sin instalar nada.)
  /* specs nativas del harness: nada que instalar */
  await asegurarCredencialesPlugins({ perfil: ctx && ctx.perfil, override: overrideMarketplace() });   // canal HTTPS que usa Claude Code para bajar el plugin faro (silencioso si ya va)
  await asegurarPluginSuperpowers({ destino, perfil: ctx && ctx.perfil, override: overrideMarketplace() });

  // El repo VIEJO (otra cuenta u otra forja): se ofrece archivarlo (solo lectura, nunca se borra), con
  // el token de SU host: nunca uno de otra forja.
  const viejoTok = fRem.host === host ? auth.token : tokenPara(fRem.host, cfg);
  if (['github', 'gitlab'].includes(fRem.forja) && fRem.path && viejoTok && `${fRem.host}/${fRem.path}`.toLowerCase() !== `${host}/${rutaRepo()}`.toLowerCase()
    && (await confirma(`¿Archivar el repo viejo ${fRem.host}/${fRem.path}? Queda en solo lectura; no se borra.`, 'n'))) {
    const ar = await archivarRepo({ forja: fRem.forja, host: fRem.host, ruta: fRem.path, token: viejoTok });
    if (ar.ok) ok('Repo viejo archivado (solo lectura).'); else warn('No pude archivar el viejo: hazlo desde su configuración en la forja.');
  }

  const cdCmd = cdSugerido(process.cwd(), destino);   // 'cd "<subcarpeta>"' o null si es el cwd (helper tested)
  caja([
    `${C.b}Para terminar la adopción (fase 2), dentro del repo:${C.x}`,
    cdCmd ? `${C.d}  1)${C.x} entra en el proyecto:  ${C.b}${cdCmd}${C.x}` : null,
    `${C.d}  ${cdCmd ? '2)' : '1)'}${C.x} abre Claude Code ahí:  ${C.b}claude${C.x}`,
    `${C.d}  ${cdCmd ? '3)' : '2)'}${C.x} acepta instalar el ${C.b}plugin faro${C.x} cuando Claude lo ofrezca ${C.d}(lo declara el settings del repo)${C.x}`,
    `${C.d}  ${cdCmd ? '4)' : '3)'}${C.x} dentro de Claude, ejecuta:  ${C.b}/faro:adoptar${C.x}  ${C.d}→ readapta tu estructura al harness.${C.x}`,
  ].filter(Boolean), { titulo: 'Siguiente paso', color: C.c });
  mostrarPermisos(perfil, rutaRepo());
  p.outro(`${C.g}✅ Adoptado${C.x}${cdCmd ? `  ${C.d}→ ${cdCmd}${C.x}` : ''}`);
  return rutaRepo();
}

export { flujoAdoptar };
