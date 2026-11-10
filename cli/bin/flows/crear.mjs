// flows/crear.mjs — flujo CREAR: clasifica (área), nombra (natural, sin prefijo), crea el repo vacío en
// la forja, lo puebla con el esqueleto (y el stack, si hay plantilla) y deja el clon listo en local.

import path from 'node:path';
import * as p from '@clack/prompts';
import { paso, C, elige, eligePaso, pasoElige, correrPasos, BACK, argVal, argFlag, YES, fail, warn, spinner, ok, confirma, pregunta, say, caja, DRY, saveConfig, runState } from '../lib/core.mjs';
import { GRUPOS, slugify, dominiosVisibles, esNombreGenerico, sugerirLibres, parecidosA } from '../lib/model.mjs';
import { altaDesdeEsqueleto, asegurarMantenedor, identidadDe, urlGitDe } from '../lib/alta.mjs';
import { elegirDestino, finalizarLocal, asegurarPluginSuperpowers, asegurarCredencialesPlugins } from '../lib/repo.mjs';
import { overrideMarketplace } from '../lib/gitcred.mjs';
import { mostrarPermisos } from './preparar.mjs';
import { elegirValidacion } from './paso-validacion.mjs';
import { plantillasMonorepo, appsDesdeFlags, validarIdApp, conPlantillasPublicas } from '../lib/monorepo.mjs';

// ---------- flujo CREAR (repo nuevo desde el esqueleto) ----------
async function flujoCrear(auth, org, cfg, catalogoEntrada, esOwner, ctx) {
  const { perfil, forja: { alta }, destino: cuenta } = ctx;
  const s = { host: perfil.host, token: auth.token };
  const ruta = () => `${org}/${repoName}`;
  // Una plantilla sin URL pública no se puede instanciar: ni se ofrece.
  const catalogo = { ...catalogoEntrada, naturalezas: conPlantillasPublicas(catalogoEntrada.naturalezas) };
  // Paso 2 · Clasificar: ÁREA (dominio) + NATURALEZA (doc/worker/app -> plantilla). La ENTIDAD (clase
  // del trabajo) la resuelve el harness: un documento puede corresponder a varias.
  paso('Clasificar el trabajo');
  const natFlag = argVal('naturaleza');
  if (natFlag && !catalogo.naturalezas[natFlag]) { fail(`Naturaleza '${natFlag}' no válida. Opciones: ${Object.keys(catalogo.naturalezas).join(', ')}.`); return; }
  const clasif = await correrPasos([
    { key: 'domain', run: (_, ctx) => pasoElige('¿De qué área es?', dominiosVisibles(catalogo.dominios, esOwner), argVal('domain') || argVal('departamento') || argVal('area'), ctx) },
    { key: 'naturaleza', run: (_, ctx) => pasoNaturaleza(catalogo, natFlag, ctx) },
    { key: 'estructura', run: (acc, ctx) => pasoEstructura(catalogo.naturalezas[acc.naturaleza], ctx) },
    { key: 'eleccion', run: (acc, ctx) => (acc.estructura === 'monorepo'
      ? pasoAppsMonorepo(catalogo.naturalezas[acc.naturaleza], argVal('plantilla'), ctx)
      : pasoPlantilla(catalogo.naturalezas[acc.naturaleza], argVal('plantilla'), ctx)) },
  ]);
  const { domain, naturaleza, estructura, eleccion } = clasif;
  const nat = catalogo.naturalezas[naturaleza];
  if (eleccion === null) return;   // --plantilla invalida (el paso ya explico por que)
  // Todo repo nace del ESQUELETO. App única: la PLANTILLA (stack ya montado) se superpone en el primer
  // commit. Monorepo: cada app se instancia en apps/<id> (lo hace finalizarLocal).
  const monorepo = estructura === 'monorepo';
  const apps = monorepo ? eleccion : null;
  const plantilla = monorepo ? undefined : eleccion;
  const plantillaSel = (!monorepo && nat.plantillas && nat.plantillas[plantilla]) || null;

  // Paso 3 · Nombre NATURAL (sin prefijo; el marcador FARO es el topic `faro`, no el nombre).
  paso('Nombre del proyecto');
  let repoName = '';
  const nombreFlag = argVal('nombre');
  // Los nombres del destino, una vez, para detectar parecidos y sugerir libres. Best-effort.
  const nombresOrg = DRY ? [] : await alta.nombres(s, cuenta);
  const reposOrg = nombresOrg.map((name) => ({ name, topics: [] }));
  for (;;) {
    const bruto = nombreFlag || await pregunta('Nombre del proyecto en lenguaje normal (sé específico; ej. "analisis de red")', undefined, (val) => slugify(val || '') ? undefined : 'Nombre inválido — usa letras/números.');
    const slug = slugify(bruto);
    if (!slug) { if (nombreFlag) { fail('El --nombre no produce un slug válido.'); return; } warn('Nombre vacío o inválido — prueba otro.'); continue; }
    // Aviso (no bloqueo) si es poco específico.
    if (!nombreFlag && esNombreGenerico(slug)) {
      warn(`${C.y}"${slug}" es poco específico${C.x} — usa un nombre más descriptivo para reconocerlo luego (ej. "${slug}-de-clientes").`);
      if (!(await confirma(`¿Usar "${slug}" igualmente?`, 'n'))) continue;
    }
    repoName = slug;   // nombre NATURAL, sin prefijo.
    // Comprobación INTELIGENTE de existencia (al teclear, no al final).
    if (!DRY) {
      const ya = await alta.existe(s, ruta());
      if (ya === null) { fail('No pude comprobar si ese nombre está libre (¿red o permisos?). No creo nada a ciegas.'); return; }
      if (ya) {
        warn(`${C.r}Ya existe${C.x} ${C.b}${ruta()}${C.x}.`);
        if (nombreFlag) { fail('Ese nombre ya existe. Usa otro --nombre, o abre el existente con --abrir.'); return; }
        const libres = sugerirLibres(repoName, nombresOrg, 3);
        const q = await elige('Ese nombre ya está usado. ¿Qué hacemos?', {
          abrir: { etiqueta: `Abrir el existente (${repoName})`, explica: 'Clona ese repo en tu carpeta.' },
          otro: { etiqueta: 'Es OTRO distinto — elegir otro nombre', explica: `Especifica más para no chocar${libres.length ? ` (ej. ${libres[0]})` : ''}.` },
        });
        if (q === 'abrir') {
          const dst = await elegirDestino(cfg, repoName);
          await finalizarLocal(auth, org, repoName, path.dirname(dst), dst, null, ctx);
          p.outro(`${C.g}✅ Abierto ${repoName}${C.x}`); process.exit(0);
        }
        if (libres.length) say(`  ${C.d}Nombres libres sugeridos:${C.x} ${libres.join(', ')}`);
        continue;   // 'otro' -> re-preguntar
      }
      // No existe exacto: ¿hay PARECIDOS ya creados? Avisar sin bloquear (evita casi-duplicados).
      const par = parecidosA(repoName, reposOrg).slice(0, 4);
      if (par.length) {
        warn(`${C.y}Hay proyectos parecidos${C.x}: ${par.join(', ')}.`);
        if (!(await confirma(`¿Sigues con "${repoName}"?`, 's'))) continue;
      }
    }
    say(`  → ${C.g}${org}/${repoName}${C.x} ${C.g}(libre ✓)${C.x}`);
    if (nombreFlag || await confirma('¿Correcto?')) break;
  }

  // Topics de clasificación: faro (marcador) + dom-<área> + nat-<naturaleza> (+ innovacion).
  const tags = [];
  const topics = ['faro', `dom-${domain}`, `nat-${naturaleza}`];
  if (domain === 'innovacion') topics.push('innovacion');

  // Paso 4 · Dónde clonar.
  paso('Dónde se crea');
  const destino = await elegirDestino(cfg, repoName);
  const baseDir = path.dirname(destino); cfg.workdir = baseDir; saveConfig(cfg);

  say('');
  caja([
    `${C.d}Nombre${C.x}       ${C.g}${org}/${repoName}${C.x}`,
    `${C.d}Área${C.x}         ${domain}`,
    `${C.d}Tipo${C.x}         ${naturaleza}`,
    ...(plantillaSel && plantillaSel.repo ? [`${C.d}Plantilla${C.x}    ${C.g}${plantillaSel.etiqueta}${C.x} ${C.d}(${plantillaSel.repo})${C.x}`] : []),
    ...(monorepo ? [`${C.d}Estructura${C.x}   ${C.g}monorepo${C.x}`, ...apps.map((a) => `${C.d}  apps/${a.id}${C.x}  ${a.rol} ${C.d}(${a.repo})${C.x}`)] : []),
    `${C.d}Topics${C.x}       ${topics.join(' · ')}`,
    `${C.d}Clon en${C.x}      ${destino}`,
  ], { titulo: 'Resumen', color: C.g });
  say('');
  if (DRY) { ok('(dry-run) Flujo validado — no se ha creado nada.'); say(''); return; }
  if (!(await confirma('¿Adelante?'))) { return; }

  // Paso 5 · Repo vacío en la forja + esqueleto + ramas + topics + protección.
  paso('Crear el repositorio');
  const libre = await alta.existe(s, ruta());
  if (libre !== false) {
    if (libre && await confirma(`Ya existe ${ruta()}. ¿Solo clonarlo (reanudar)?`)) {
      paso('Dejarlo listo en local');
      await finalizarLocal(auth, org, repoName, baseDir, destino, null, ctx);
      p.outro(`${C.g}✅ Reanudado${C.x}`); return;
    }
    fail(libre ? `Ya existe ${ruta()} — elige otro nombre.` : 'No pude comprobar el repo destino (¿red o permisos?).'); return;
  }
  const spinGen = spinner('Creando el repositorio');
  const res = await altaDesdeEsqueleto({
    alta, sesion: s, destino: cuenta, nombre: repoName, descripcion: `${repoName} · ${nat.etiqueta} · dom-${domain}`, topics,
    urlGit: (r) => urlGitDe(perfil, auth.token, r), identidad: identidadDe(auth, perfil), plantilla: plantillaSel,
  });
  spinGen();
  if (res.ruta) runState.repoCreado = true;
  if (!res.ok) { fail(res.fase === 'contenido' ? `El repo ${res.web} está creado, pero ${res.mensaje}.` : `No se pudo crear el repo: ${res.mensaje}.`); return; }
  ok(`Repo creado: ${res.web}`);
  if (res.plantillaError) warn(`${res.plantillaError}: el repo queda con el esqueleto.`);
  const plantillaUsada = res.plantillaError ? null : plantillaSel;
  if (res.develop) ok('Ramas main y develop listas; develop por defecto (main = aprobación).');
  else warn('Ramas main y develop listas, pero no pude fijar develop por defecto: cámbialo en la forja.');
  if (!res.topics) warn('No pude aplicar los topics (no bloquea).');
  if (!res.protegida) say(`  ${C.d}main no queda protegida en la forja (HTTP ${res.statusProteccion}: falta plan o permiso); el harness la protege en local.${C.x}`);
  const mant = await asegurarMantenedor(ctx.forja, s, cuenta, res.ruta, auth.id);
  if (mant.aplicado && !mant.ok) say(`  ${C.d}No pude fijarte como Maintainer explícito (HTTP ${mant.status}); GitLab suele darlo al creador igualmente.${C.x}`);
  if (!cuenta.personal) say(`  ${C.d}Es privado: quizá solo tú lo veas hasta que des acceso a tu equipo desde la forja.${C.x}`);

  // Dónde se validan los PR/MR (#289): el repo nace privado; la recomendación sale del plan.
  const val = await elegirValidacion({ alta, s, cuenta, publico: false });

  // Paso 6 · Local.
  paso('Dejarlo listo en local');
  // plugin superpowers: crear lo aplica. (Specs spec-driven = motor nativo del harness, sin instalar nada.)
  // Este paso lanza el binario 'claude' varias veces (marketplace update + plugin update) y tarda
  // ~20s la primera vez del dia. Sin avisar, la terminal parece COLGADA justo cuando el repo ya
  // esta listo y el usuario se iba: se dice que esta pasando y que no hay que hacer nada.
  const asegurarPlugins = async () => {
    await asegurarCredencialesPlugins({ perfil: ctx && ctx.perfil, override: overrideMarketplace() });   // canal HTTPS que usa Claude Code para bajar el plugin faro (silencioso si ya va)
    say(`  ${C.d}Comprobando los plugins de Claude Code (puede tardar unos segundos)…${C.x}`);
    await asegurarPluginSuperpowers({ destino, perfil: ctx && ctx.perfil, override: overrideMarketplace() });
  };
  // `plantilla` viaja en el meta: finalizarLocal la instancia justo tras clonar, DENTRO de este mismo
  // paso 6 y en el commit comun — no despues, que imprimia un paso extra tras los "Siguientes pasos".
  // Igual las apps del monorepo: van al MISMO commit comun.
  await finalizarLocal(auth, org, repoName, baseDir, destino, {
    template: 'esqueleto', domain, tags, teams: [], naturaleza,
    plantilla: plantillaUsada, plantillaKey: plantillaUsada ? plantilla : null,
    monorepo: monorepo ? { apps } : null,
    validacion: val.validacion, dePago: val.dePago, publico: val.publico,
  }, ctx);
  await asegurarPlugins();

  caja([
    `${C.d}Al abrir Claude Code/Cursor dentro, el harness arranca el onboarding.${C.x}`,
    `Trabaja en ${C.b}develop/feature${C.x}${C.d}; el merge a ${C.x}main${C.d} = aprobación.${C.x}`,
    `${C.d}Reabrir:${C.x} ${destino}`,
  ]);
  mostrarPermisos(ctx && ctx.perfil, ruta());
  p.outro(`${C.g}✅  Repositorio listo${C.x}`);
  process.exit(0);
}

// Paso NATURALEZA (2 niveles: grupo → tipo) con soporte de atrás. --naturaleza salta el prompt.
// Devuelve la clave de naturaleza, o BACK para volver al paso anterior (área).
async function pasoNaturaleza(catalogo, natFlag, { atras }) {
  if (natFlag) return natFlag;   // ya validado arriba
  const grupos = [...new Set(Object.values(catalogo.naturalezas).map((n) => n.grupo || 'codigo'))];
  const g1 = Object.fromEntries(grupos.map((g) => [g, GRUPOS[g] || { etiqueta: g, explica: '' }]));
  for (;;) {
    const grupo = grupos.length === 1 ? grupos[0] : await eligePaso('¿Qué quieres hacer?', g1, { atras });
    if (grupo === BACK) return BACK;   // atrás desde el 1er menú de naturaleza → paso anterior
    const enGrupo = Object.entries(catalogo.naturalezas).filter(([, n]) => (n.grupo || 'codigo') === grupo);
    if (enGrupo.length === 1) return enGrupo[0][0];
    const tipo = await eligePaso('¿Dónde va a correr?', Object.fromEntries(enGrupo), { atras: true });
    if (tipo === BACK) { if (grupos.length === 1) return BACK; continue; }   // atrás → re-elige grupo
    return tipo;
  }
}

// Paso PLANTILLA (nivel 3, solo si la naturaleza declara `plantillas`): QUE STACK ya montado corre
// sobre esa infraestructura. Se auto-salta cuando la naturaleza no tiene plantillas — no es que se
// omita una pregunta, es que ahi no hay nada que elegir. --plantilla la salta en no interactivo.
// Devuelve la clave de plantilla (null si la naturaleza no tiene), o BACK.
async function pasoPlantilla(nat, plantillaFlag, { atras }) {
  const pl = nat && nat.plantillas;
  if (!pl || !Object.keys(pl).length) {
    if (plantillaFlag) warn(`La plantilla '${plantillaFlag}' no está disponible: sigo con el esqueleto.`);
    return undefined;
  }
  if (plantillaFlag) {
    if (!pl[plantillaFlag]) { fail(`Plantilla '${plantillaFlag}' no válida para esta naturaleza. Opciones: ${Object.keys(pl).join(', ')}.`); return null; }
    return plantillaFlag;
  }
  // La lista se ENSEÑA aunque hoy solo haya una: el usuario debe VER de que parte su repo (y que el
  // catalogo ira creciendo), no recibir un stack por sorpresa. Es una confirmacion, no un tramite.
  return await eligePaso('¿De qué plantilla partimos?', pl, { atras });   // puede ser BACK; lo gestiona correrPasos
}

// Paso ESTRUCTURA (#5): ¿una sola app o un monorepo? Solo se pregunta si la naturaleza tiene alguna
// plantilla instanciable como app de monorepo; si no, no hay nada que elegir. --monorepo lo salta.
async function pasoEstructura(nat, { atras }) {
  if (!Object.keys(plantillasMonorepo(nat)).length) return 'unica';
  if (argFlag('monorepo')) return 'monorepo';
  // No interactivo SIN --monorepo (--plantilla o --yes): app única, como antes de existir la pregunta —
  // un script de CI que ya pasaba --plantilla no puede quedarse colgado en un menú nuevo.
  if (argVal('plantilla') || YES) return 'unica';
  return await eligePaso('¿Una sola app o un monorepo?', {
    unica: { etiqueta: 'Una sola app', explica: 'El repo ES la app: parte de una plantilla de stack.' },
    monorepo: { etiqueta: 'Monorepo (varias apps)', explica: 'Workspace pnpm con cada app en apps/<id>, creadas desde plantilla.' },
  }, { atras });
}

// Paso APPS del monorepo: por cada app, plantilla (solo las `monorepo: true`), id y rol; luego
// "¿otra?". Con --plantilla (no interactivo) una sola app con el id por defecto de la plantilla.
// Devuelve [{id, rol, plantilla, repo, url}], null si --plantilla no vale, o BACK.
async function pasoAppsMonorepo(nat, plantillaFlag, { atras }) {
  const pls = plantillasMonorepo(nat);
  if (plantillaFlag) {
    const a = appsDesdeFlags(nat, plantillaFlag);
    if (!a) fail(`Plantilla '${plantillaFlag}' no válida para un monorepo. Opciones: ${Object.keys(pls).join(', ')}.`);
    return a;
  }
  const apps = [];
  for (;;) {
    const key = await eligePaso(apps.length ? '¿De qué plantilla parte la siguiente app?' : '¿De qué plantilla parte la app?', pls, { atras: atras || apps.length > 0 });
    if (key === BACK) { if (!apps.length) return BACK; apps.pop(); continue; }   // atrás → deshace la última app
    const pl = pls[key];
    const usados = apps.map((a) => a.id);
    const defId = usados.includes(pl.id) ? `${pl.id}-${apps.length + 1}` : pl.id;
    const id = await pregunta('Id de la app (será la carpeta apps/<id>)', defId, (v) => validarIdApp(v || defId, usados));
    const rol = await pregunta('¿Qué hace esta app? (una frase)', pl.etiqueta);
    apps.push({ id, rol, plantilla: key, repo: pl.repo, url: pl.url });
    if (YES || !(await confirma('¿Añadir otra app al monorepo?', 'n'))) return apps;
  }
}

export { flujoCrear };
