// flows/check.mjs — flujo CHECK (doctor FARO): valida ESTRUCTURA + DEPENDENCIAS + RAMAS de un repo
// y aplica los arreglos SANOS (crear develop, fijar default, ...). Con --dry-run: solo informe.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as p from '@clack/prompts';
import { argVal, paso, say, C, ok, warn, fail, caja, confirma, YES, DRY, gh, run } from '../lib/core.mjs';
import {
  diagnosticarEstructura, diagnosticarRamasLocal, asegurarDevelopLocal, normalizarPrincipalLocal,
  asegurarPluginSuperpowers, asegurarCredencialesPlugins, revisarPlantillasLegadas, overlayFaro, FARO_ROOTS,
  escribirSettingsPlugin, migrarCopiaLegada, leerMetaRepo, carpetasFaroQueFaltan,
} from '../lib/repo.mjs';
import { estamparTopics, aplicarConfigRepo, esPlanDePago, planDeOrg, protegerRama, teamsDeRepo } from '../lib/github.mjs';
import { settingsPluginOk, escribirMetaRepo } from '../lib/repo.mjs';
import { detectarDeclarada } from '../lib/forja-propia.mjs';
import { perfilesConocidos } from '../lib/perfil.mjs';
import { overrideMarketplace } from '../lib/gitcred.mjs';

const ICON = { ok: `${C.g}✔${C.x}`, aviso: `${C.y}⚠${C.x}`, error: `${C.r}✖${C.x}` };

// teams de .faro.json vs los REALES del repo (GitHub): devuelve la lista nueva si difieren, null si no.
// El 'auth' del plugin sobrescribe ese campo con los equipos del USUARIO; aquí mandan los del REPO.
function reconciliarTeams(meta, reales) {
  const a = [...new Set((meta && meta.teams) || [])].sort(), b = [...new Set(reales || [])].sort();
  return JSON.stringify(a) === JSON.stringify(b) ? null : b;
}

async function flujoCheck(auth, org, cfg, catalogo, esOwner, ctx = null) {
  const destino = path.resolve((ctx && ctx.dir) || argVal('dir') || process.cwd());
  const esGitlab = !!(ctx && ctx.perfil && ctx.perfil.forja === 'gitlab');
  const host = (ctx && ctx.perfil && ctx.perfil.host) || 'github.com';
  paso('Check FARO');
  say(`  Carpeta: ${C.b}${destino}${C.x}${DRY ? `  ${C.d}(dry-run: solo informe)${C.x}` : ''}`);
  const gitLocal = (a) => { try { return execFileSync('git', ['-C', destino, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  const hasF = (f) => fs.existsSync(path.join(destino, f));
  let avisos = 0, errores = 0, arreglos = 0;
  const linea = (c) => { say(`  ${ICON[c.estado] || ICON.aviso} ${c.etiqueta}: ${C.d}${c.detalle}${C.x}`); if (c.estado === 'aviso') avisos++; if (c.estado === 'error') errores++; };
  const item = (estado, texto, extra) => { say(`  ${ICON[estado]} ${texto}${extra ? ` ${C.d}${extra}${C.x}` : ''}`); if (estado === 'aviso') avisos++; if (estado === 'error') errores++; };

  // === ESTRUCTURA ===
  say(''); say(`${C.b}Estructura${C.x}`);
  const est = diagnosticarEstructura(destino);
  for (const c of est) linea(c);
  if (est.find((c) => c.id === 'git').estado !== 'ok') { fail('No es un repo git — nada más que revisar. Usa adoptar.'); process.exit(1); }

  // Naturaleza (para el overlay del template).
  let naturaleza = 'documental';
  if (hasF('wrangler.toml') || hasF('wrangler.jsonc') || hasF('wrangler.json')) naturaleza = 'worker';
  else if (hasF('package.json') || hasF('requirements.txt') || hasF('pyproject.toml') || hasF('go.mod')) naturaleza = 'app';

  // Remoto GitHub (org/repo) para los checks de servidor.
  const origin = gitLocal(['remote', 'get-url', 'origin']);
  let orgSrv = null, repoSrv = null;
  const fo = detectarDeclarada(origin, { dir: destino, perfiles: perfilesConocidos(cfg) });
  if (fo.forja === 'github') { orgSrv = fo.owner; repoSrv = fo.project; }
  else if (fo.forja === 'gitlab') { orgSrv = fo.path.split('/').slice(0, -1).join('/'); repoSrv = fo.project; }
  const rutaRepo = orgSrv && repoSrv ? `${orgSrv}/${repoSrv}` : null;

  // [fix] Crear las carpetas de la capa FARO que falten. NO se clona el template: el andamio es
  // estructura vacia (.gitkeep + un README por carpeta) y el HARNESS ya la materializa en cada sesion
  // (REF_DIRS, plugin >= 0.8.5). Clonar un repo privado por red para crear carpetas vacias anadia una
  // dependencia -y un punto de fallo- que no compensa: aqui solo se adelanta lo que el motor hara igual.
  const roots = est.find((c) => c.id === 'faro-roots');
  if (roots.faltan && roots.faltan.length && !DRY) {
    if (YES || await confirma(`¿Crear las carpetas FARO que faltan (${roots.faltan.join(', ')})? (no destructivo: no toca nada de lo que ya hay)`, 's')) {
      try {
        for (const d of carpetasFaroQueFaltan(destino)) fs.mkdirSync(path.join(destino, d), { recursive: true });
        // .gitkeep para que las vacias existan en git (sin el, git no versiona carpetas y el equipo
        // no las recibe al clonar). Solo en las que quedan vacias: si ya hay contenido, sobra.
        for (const d of carpetasFaroQueFaltan(destino, { soloVacias: true })) {
          const k = path.join(destino, d, '.gitkeep');
          if (!fs.existsSync(k)) fs.writeFileSync(k, '');
        }
        ok('Capa FARO completada (carpetas creadas en local; el harness las mantiene en cada sesión).'); arreglos++;
      } catch { warn('No pude crear alguna carpeta de la capa FARO.'); }
    }
  }

  // [fix] Modelo PLUGIN: sin copia legada del harness + distribucion declarada en settings del repo
  // (con la copia presente el plugin se INHIBE; sin la declaracion, un clon no sabe de donde
  // instalarlo y el marketplace no se auto-actualiza).
  const legacy = hasF(path.join('.claude', 'hooks', 'harness.js'));
  let sOk = false;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(destino, '.claude', 'settings.json'), 'utf8'));
    sOk = settingsPluginOk(s);   // acepta source git, github y url; exige autoUpdate y superpowers
  } catch {}
  if (!legacy && sOk) item('ok', 'plugin faro', 'sin copia legada · distribucion declarada en settings (autoUpdate)');
  else {
    if (legacy) item('aviso', 'copia legada del harness (.claude/hooks/)', 'el plugin faro se inhibe mientras exista');
    if (!sOk) item('aviso', 'settings sin la distribucion del plugin faro', 'un clon no sabria de donde instalarlo · sin auto-update');
    if (!DRY && (YES || await confirma('¿Migrar al modelo plugin (retirar copia legada y/o declarar la distribucion en settings)?', 's'))) {
      const m = migrarCopiaLegada(destino, { perfil: ctx && ctx.perfil, override: overrideMarketplace() });
      const c = escribirSettingsPlugin(destino, ctx && ctx.perfil ? ctx.perfil : undefined, { override: overrideMarketplace() });
      if (m || c) {
        arreglos++;
        // La copia legada estaba COMMITEADA (y subida): sin commit, el repo queda lleno de borrados
        // sueltos y git "salta" en cada sesion. Se commitea SOLO lo de la migracion (rutas acotadas).
        if (YES || await confirma('¿Commiteo la migración (borrados de la copia + settings + metadato)?', 's')) {
          // DIAGNOSTICO PREVIO: si .claude/settings.json esta IGNORADO, el add acotado no stagea nada,
          // el commit falla por vacio... y ademas el settings NO viaja al clonar, que es justo el
          // objetivo de declarar el plugin. Hay que decirlo explicito: en silencio parece que fue bien.
          const ignorado = (() => {
            try { execFileSync('git', ['-C', destino, 'check-ignore', '-q', path.join('.claude', 'settings.json')], { stdio: 'ignore' }); return true; }
            catch { return false; }
          })();
          if (ignorado) {
            warn('.claude/settings.json está en .gitignore — no puede commitearse y NO viajará al clonar: el equipo no sabrá de dónde instalar el plugin.');
            say(`  ${C.d}Quita esa regla del .gitignore (o añade la excepción !.claude/settings.json) y repite el check.${C.x}`);
          }
          try {
            run('git', ['-C', destino, 'add', '-A', '--', '.claude', '.faro.json'], { stdio: 'ignore' });
            run('git', ['-C', destino, 'commit', '-m', 'chore: migracion al plugin faro — retira copia legada del harness (settings + metadato .faro.json)'], { stdio: 'ignore' });
            ok('Migración commiteada.');
            // PUSH de la rama actual (con confirmacion): no dejar el repo "abierto" con la migracion
            // solo en local. A main NO se mergea aqui: eso es la APROBACION (la aplica un maintainer
            // via /faro:aprobar) — la migracion llegara a main con el siguiente merge normal.
            if (YES || await confirma('¿Subo (push) la migración a origin?', 's')) {
              try {
                run('git', ['-C', destino, 'push', 'origin', 'HEAD'], { stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
                ok('Migración subida a origin. Llegará a main con la próxima aprobación (/faro:aprobar).');
                say(`${C.b}  Al abrir Claude Code aquí por primera vez:${C.x} acepta instalar el plugin faro y ejecuta ${C.b}/reload-plugins${C.x}${C.d} (si no, las skills /faro:* aparecen en la SIGUIENTE sesión).${C.x}`);
              } catch { warn('Push fallido (¿remoto por delante? haz pull/reconcilia y sube) — el commit local está a salvo.'); }
            } else ok('Sin push — súbela con tu flujo normal.');
          } catch (e) {
            // El motivo REAL lo da git: tragarselo (stdio ignore) obligaba a adivinar entre "nada
            // staged", hook que falla, identidad sin configurar o fichero ignorado. Se muestra.
            const salida = `${(e && e.stdout) || ''}${(e && e.stderr) || ''}`.trim();
            let staged = '';
            try { staged = execFileSync('git', ['-C', destino, 'diff', '--cached', '--name-only'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
            warn(`No pude commitear la migración${!staged ? ' — no hay nada en el índice (staged)' : ''}.`);
            if (salida) for (const l of salida.split('\n').slice(0, 4)) say(`  ${C.d}git: ${l}${C.x}`);
            if (!salida && !staged && !ignorado) say(`  ${C.d}Los cambios pueden estar ya commiteados, o las rutas migradas quedan fuera de .claude/.faro.json — revisa 'git status'.${C.x}`);
          }
        } else ok('Modelo plugin aplicado — revisa y commitea los cambios (git status).');
      }
    }
  }

  // === DEPENDENCIAS ===
  say(''); say(`${C.b}Dependencias${C.x}`);
  const gitMail = gitLocal(['config', 'user.email']);
  item(gitMail ? 'ok' : 'aviso', 'Identidad git', gitMail || 'sin configurar (se asegura al arrancar)');
  if (!DRY) {
    /* specs nativas del harness: nada que instalar */   // instala directo + commit/push manifiesto
    await asegurarCredencialesPlugins({ silencioSiOk: false, perfil: ctx && ctx.perfil, override: overrideMarketplace() });   // canal HTTPS que usa Claude Code para bajar el plugin
    await asegurarPluginSuperpowers({ destino, perfil: ctx && ctx.perfil, override: overrideMarketplace() });                                                 // reporta (se instala dentro de Claude Code)
    await revisarPlantillasLegadas(destino);                                     // copias viejas que tapan a las del plugin
  } else say(`  ${C.d}(dry-run) omito instalar plugins / superpowers${C.x}`);

  // === RAMAS ===
  // Invariante FARO: la principal es SIEMPRE 'main' (destino de aprobación, protegida) y la rama
  // por defecto en GitHub es 'develop' (donde cae el trabajo y los clones). 'master' es legado: se
  // normaliza a 'main' como arreglo sano (decision 2026-08-03), y al final se vuelve SIEMPRE a develop.
  say(''); say(`${C.b}Ramas${C.x}`);
  let ram = diagnosticarRamasLocal(gitLocal);
  let masterRenombrada = false;
  if (ram.principalExistente === 'master') {
    if (DRY) item('aviso', "principal 'master'", 'FARO usa main (con fix: master → main)');
    else {
      const nm = normalizarPrincipalLocal(destino);
      if (nm.renombrada) {
        masterRenombrada = true; arreglos++;
        item('ok', 'principal', 'master → main (renombrada en local; se sube abajo)');
        ram = diagnosticarRamasLocal(gitLocal);   // el inventario cambió: releer
      } else item('aviso', "principal 'master'", `no normalizada: ${nm.motivo}`);
    }
  }
  const principal = ram.principalExistente || 'main';
  if (ram.tieneDevelop) item('ok', "develop local", 'existe');
  else if (DRY) item('aviso', 'develop local', 'no existe (con fix: se crearía)');
  else { asegurarDevelopLocal(destino, principal); arreglos++; item('ok', 'develop local', `no existía → creada desde ${principal}`); }
  if (ram.tieneDevelop && !ram.developSupersetMain) item('aviso', `develop ⊇ ${principal}`, `NO — reconcilia: git switch develop && git merge ${principal}`);
  else item('ok', `develop ⊇ ${principal}`, 'ok');

  // Servidor (best-effort).
  if (!orgSrv || !repoSrv) item('aviso', 'Servidor', 'sin remoto origin en GitHub/GitLab — omito default/protección');
  else if (DRY) say(`  ${C.d}(dry-run) omito checks de servidor (default branch, protección, topics, config de repo)${C.x}`);
  else if (esGitlab) {
    // GitLab: lo portable por API (Free): ramas presentes, rama por defecto, protección de la principal, topics.
    const info = await ctx.forja.repo(host, auth.token, rutaRepo);
    if (!info.ok) item('aviso', 'Servidor', `no pude consultar ${rutaRepo} en ${host}`);
    else {
      const nombresRem = await ctx.forja.ramas(host, auth.token, rutaRepo);
      if (nombresRem === null) item('aviso', 'ramas en servidor', 'no pude listarlas — omito la sincronización');
      else {
        const faltanRem = [principal, 'develop'].filter((b) => !nombresRem.includes(b));
        if (faltanRem.length) {
          item('aviso', 'ramas en servidor', `faltan: ${faltanRem.join(', ')} — el repo quedó a medias`);
          if (YES || await confirma(`¿Subo a origin las ramas que faltan (${faltanRem.join(', ')})?`, 's')) {
            const NOPUSH = { stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } };
            for (const b of faltanRem) {
              try { run('git', ['-C', destino, 'push', 'origin', `${b}:${b}`], NOPUSH); arreglos++; ok(`Subida rama '${b}'.`); }
              catch { warn(`No pude subir '${b}' (¿remoto por delante? haz pull y reintenta).`); }
            }
          } else ok('Sin push — súbelas con tu flujo normal.');
        } else item('ok', 'ramas en servidor', `${principal} + develop presentes`);
      }
      if (info.body.default_branch === 'develop') item('ok', 'rama por defecto', 'develop');
      else {
        const r = await ctx.forja.ramaPorDefecto(host, auth.token, rutaRepo, 'develop');
        if (r.ok) { arreglos++; item('ok', 'rama por defecto', `${info.body.default_branch} → develop (arreglado)`); }
        else item('aviso', 'rama por defecto', 'no pude fijar develop — ¿existe la rama en el servidor?');
      }
      const pr = await ctx.forja.proteger(host, auth.token, rutaRepo, principal);
      if (pr.ok) { arreglos++; item('ok', `${principal} protegida`, 'nadie empuja directo; la fusión es de Maintainer+'); }
      else item('aviso', `${principal} protegida`, `no pude (HTTP ${pr.status}): hace falta nivel Maintainer`);
      const metaCls = leerMetaRepo(destino) || {};
      if (metaCls.domain) {
        const actuales = await ctx.forja.topics(host, auth.token, rutaRepo);
        const conservados = actuales.filter((x) => !x.startsWith('ent-') && !x.startsWith('nat-'));
        const deseados = new Set([...conservados, 'faro', `dom-${metaCls.domain}`, `nat-${naturaleza}`]);
        if (metaCls.domain === 'innovacion') deseados.add('innovacion');
        const faltan = [...deseados].filter((x) => !actuales.includes(x));
        const obsoletos = actuales.filter((x) => x.startsWith('ent-') || (x.startsWith('nat-') && x !== `nat-${naturaleza}`));
        if (faltan.length || obsoletos.length) {
          const rt = await ctx.forja.estamparTopics(host, auth.token, rutaRepo, [...deseados]);
          if (rt.ok) { arreglos++; item('ok', 'topics', `${faltan.length ? `+${faltan.join(', ')}` : 'al día'}${obsoletos.length ? ` · quitados obsoletos: ${obsoletos.join(', ')}` : ''}`); }
          else item('aviso', 'topics', 'no pude aplicarlos (¿nivel Maintainer?)');
        } else item('ok', 'topics', 'al día');
      } else item('aviso', 'clasificación', 'sin domain en .faro.json (usa adoptar)');
      say(`  ${C.d}Equipo: los miembros del grupo ${orgSrv} heredan el acceso (en GitLab no hay teams).${C.x}`);
    }
  }
  else {
    const info = await gh(auth.token, `/repos/${orgSrv}/${repoSrv}`);
    if (!info.ok) item('aviso', 'Servidor', 'no pude consultar el repo en GitHub');
    else {
      // [fix] SINCRONIZAR ramas que falten en el servidor. Repara repos que quedaron a medias (p.ej.
      // una adopción que murió tras crear el repo): sin 'develop' remota, fijar el default falla.
      // ORDEN OBLIGATORIO: subir main → subir develop → fijar default=develop → borrar master remota
      // (GitHub no deja borrar la rama que es default, de ahí que el borrado vaya el último).
      const ramasRemotas = await gh(auth.token, `/repos/${orgSrv}/${repoSrv}/branches?per_page=100`);
      const nombresRem = (ramasRemotas.ok && Array.isArray(ramasRemotas.body)) ? ramasRemotas.body.map((b) => b.name) : null;
      if (nombresRem === null) item('aviso', 'ramas en servidor', 'no pude listarlas — omito la sincronización');
      else {
        const faltanRem = [principal, 'develop'].filter((b) => !nombresRem.includes(b));
        if (faltanRem.length) {
          item('aviso', 'ramas en servidor', `faltan: ${faltanRem.join(', ')} — el repo quedó a medias`);
          if (YES || await confirma(`¿Subo a origin las ramas que faltan (${faltanRem.join(', ')})?`, 's')) {
            const NOPUSH = { stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } };
            for (const b of faltanRem) {
              try { run('git', ['-C', destino, 'push', 'origin', `${b}:${b}`], NOPUSH); arreglos++; ok(`Subida rama '${b}'.`); }
              catch { warn(`No pude subir '${b}' (¿remoto por delante? haz pull y reintenta).`); }
            }
          } else ok('Sin push — súbelas con tu flujo normal.');
        } else item('ok', 'ramas en servidor', `${principal} + develop presentes`);
      }

      // Default branch = develop (gratis). Va DESPUÉS del push: si develop no existe remota, esto falla.
      if (info.body.default_branch === 'develop') item('ok', 'default branch', 'develop');
      else { const pat = await gh(auth.token, `/repos/${orgSrv}/${repoSrv}`, { method: 'PATCH', body: JSON.stringify({ default_branch: 'develop' }) }); if (pat.ok) { arreglos++; item('ok', 'default branch', `${info.body.default_branch} → develop (arreglado)`); } else item('aviso', 'default branch', 'no pude fijar develop — ¿existe la rama en el servidor?'); }

      // 'master' remota: solo tras haber subido 'main' y fijado develop por defecto. Se borra para que
      // no queden DOS principales divergiendo (la referencia legada queda en el historial de main).
      if (masterRenombrada && nombresRem && nombresRem.includes('master')) {
        // Releemos el default REAL: si el PATCH de arriba falló, borrar master dejaría el repo sin principal.
        const defOk = (await gh(auth.token, `/repos/${orgSrv}/${repoSrv}`)).body?.default_branch === 'develop';
        if (defOk && (YES || await confirma("¿Borro la rama 'master' del servidor (ya migrada a main)?", 's'))) {
          try { run('git', ['-C', destino, 'push', 'origin', '--delete', 'master'], { stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }); arreglos++; item('ok', "master en servidor", 'borrada (migrada a main)'); }
          catch { warn("No pude borrar 'master' del servidor — bórrala a mano cuando confirmes que main está bien."); }
        } else if (!defOk) item('aviso', "master en servidor", "sigue ahí: 'develop' no es default aún — no se puede borrar la default");
      }

      // Protección de la principal: SOLO plan de pago (Free da 403; se auto-activa al pasar a Team).
      const plan = await planDeOrg(auth, orgSrv);
      if (esPlanDePago(plan)) { const p = await protegerRama(auth, orgSrv, repoSrv, principal, plan); if (p) { arreglos++; item('ok', `${principal} protegida`, 'servidor'); } else item('aviso', `${principal} protegida`, 'no pude'); }
      else item('aviso', `${principal} protegida`, 'no disponible en Free — la protege el harness en local (se aplicará sola en GitHub Team)');

      // GitHub: clasificación y config (idempotente — pone al día repos creados antes de estos cambios).
      const metaCls = leerMetaRepo(destino) || {};   // .faro.json (o el legado, que check migra por rename)
      const dom = metaCls.domain;
      if (dom) {
        const infoTopics = await gh(auth.token, `/repos/${orgSrv}/${repoSrv}/topics`);
        const actuales = (infoTopics.ok && infoTopics.body && infoTopics.body.names) || [];
        // Set deseado: faro + dom-* + nat-* (+ innovacion). Descartamos los ent-* obsoletos (modelo viejo).
        // Los nat-* tambien se RECALCULAN: la naturaleza se deriva del disco en cada check (un repo
        // documental que gana codigo pasa a app/worker SIN re-adoptar — mismo repo, mismo template),
        // asi que conservar el nat-* viejo dejaria dos etiquetas contradictorias. Solo queda la vigente.
        const conservados = actuales.filter((t) => !t.startsWith('ent-') && !t.startsWith('nat-'));
        const deseados = new Set([...conservados, 'faro', `dom-${dom}`, `nat-${naturaleza}`]);
        if (dom === 'innovacion') deseados.add('innovacion');
        const obsoletos = actuales.filter((t) => t.startsWith('ent-') || (t.startsWith('nat-') && t !== `nat-${naturaleza}`));
        const faltan = [...deseados].filter((t) => !actuales.includes(t));
        if (faltan.length || obsoletos.length) {
          await estamparTopics(auth, orgSrv, repoSrv, [...deseados]);
          arreglos++;
          item('ok', 'topics', `${faltan.length ? `+${faltan.join(', ')}` : 'al día'}${obsoletos.length ? ` · quitados obsoletos: ${obsoletos.join(', ')}` : ''}`);
        } else item('ok', 'topics', 'al día');
        const nat = catalogo.naturalezas[naturaleza] || catalogo.naturalezas.documental;
        await aplicarConfigRepo(auth, orgSrv, repoSrv, { descripcion: `${repoSrv} · ${nat.etiqueta} · dom-${dom}` });
        arreglos++;
      } else item('aviso', 'clasificación', 'sin domain en .faro.json (usa adoptar)');
      // teams de .faro.json: el 'auth' del plugin los sobrescribe con los del USUARIO; mandan los del REPO.
      try {
        const reales = await teamsDeRepo(auth, orgSrv, repoSrv, { slugs: true });
        const nuevo = reconciliarTeams(metaCls, reales);
        if (nuevo) { escribirMetaRepo(destino, { ...metaCls, teams: nuevo }); arreglos++; item('ok', 'teams en .faro.json', `reconciliados con el repo: ${nuevo.join(', ') || 'ninguno'}`); }
        else item('ok', 'teams en .faro.json', metaCls.teams && metaCls.teams.length ? metaCls.teams.join(', ') : 'sin equipos');
      } catch {}

      // Reporte de ramas acumuladas (solo lectura): feature/fix/chore sin limpiar. delete_branch_on_merge
      // (ya activado por aplicarConfigRepo) las limpiará a futuro al mergear; las viejas se borran a mano.
      if (nombresRem) {
        const trabajo = nombresRem.filter((n) => !['main', 'master', 'develop'].includes(n));
        if (trabajo.length >= 6) item('aviso', 'ramas acumuladas', `${trabajo.length} ramas de trabajo en servidor — al mergear se borran solas; limpia las viejas con 'git push origin --delete <rama>'`);
        else item('ok', 'ramas', `${trabajo.length} de trabajo`);
      }
    }
  }

  // === VUELTA A DEVELOP ===
  // Invariante FARO: nunca se deja al usuario en la principal. El merge a 'main' es la APROBACIÓN
  // (la aplica un maintainer vía /faro:aprobar), así que el trabajo del día a día vive en develop.
  if (!DRY) {
    const actual = gitLocal(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (actual !== 'develop') {
      const sucio = gitLocal(['status', '--porcelain']);
      if (sucio) item('aviso', `rama actual '${actual}'`, "cambios sin commitear — no te muevo; commitea y haz 'git switch develop'");
      else {
        try { run('git', ['-C', destino, 'switch', 'develop'], { stdio: 'ignore' }); item('ok', 'rama actual', `${actual} → develop (el trabajo vive en develop)`); }
        catch { item('aviso', `rama actual '${actual}'`, "no pude cambiar a develop — hazlo con 'git switch develop'"); }
      }
    } else item('ok', 'rama actual', 'develop');
  } else item('aviso', `rama actual '${ram.ramaActual}'`, ram.ramaActual === 'develop' ? 'ok' : '(con fix: volvería a develop)');

  // === RESUMEN ===
  say('');
  caja([
    `${C.y}${avisos}${C.x} aviso(s) · ${C.r}${errores}${C.x} error(es)${DRY ? '' : ` · ${C.g}${arreglos}${C.x} arreglo(s)`}`,
    DRY ? `${C.d}dry-run: no se aplicó ningún arreglo.${C.x}` : `${C.d}Los arreglos sanos se aplicaron; los avisos requieren tu decisión.${C.x}`,
  ], { titulo: 'Check FARO', color: errores ? C.r : avisos ? C.y : C.g });
  p.outro(errores ? `${C.r}Check con errores${C.x}` : `${C.g}✅ Check completado${C.x}`);
  if (errores) process.exit(1);
}

export { flujoCheck, reconciliarTeams };
