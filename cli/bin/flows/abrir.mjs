// flows/abrir.mjs — flujo ABRIR: clona un repo EXISTENTE (GitHub o GitLab) al que tu cuenta tiene acceso.

import path from 'node:path';
import { paso, argVal, warn, saveConfig, DRY, ok, C, elige, pregunta, spinner, caja, say, confirma } from '../lib/core.mjs';
import { cablearCredentialHelper } from '../lib/github.mjs';
import { elegirDestino, finalizarLocal } from '../lib/repo.mjs';
import { tipoDeTopics, rel, coincideRepo } from '../lib/model.mjs';

const esFaro = (r) => (r.topics || []).includes('faro');
const explicaDe = (r) => [tipoDeTopics(r.topics || []), rel(r.pushed_at)].filter(Boolean).join(' · ');

// Selector común de las dos forjas: primero los repos FARO, con «Ver todos» si hay más, y búsqueda
// siempre sobre la lista entera. repos = [{ ruta, nombre, topics, pushed_at }]. Devuelve la ruta.
async function elegirDeLista(repos, titulo, { elige: e = elige, pregunta: q = pregunta } = {}) {
  const faro = repos.filter(esFaro);
  let verTodos = false;
  for (;;) {
    const lista = !verTodos && faro.length ? faro : repos;
    const ops = {};
    lista.slice(0, 10).forEach((r) => { ops[r.ruta] = { etiqueta: r.ruta, explica: explicaDe(r) }; });
    if (!verTodos && faro.length && faro.length < repos.length) ops.__todos = { etiqueta: 'Ver todos', explica: 'Todos los repositorios a los que tu cuenta tiene acceso.' };
    ops.__buscar = { etiqueta: '🔎 Buscar por nombre…', explica: 'Filtra escribiendo parte del nombre.' };
    const sel = await e(titulo, ops);
    if (sel === '__todos') { verTodos = true; continue; }
    if (sel !== '__buscar') return sel;
    const txt = (await q('Escribe parte del nombre')).toLowerCase();
    const hits = repos.filter((r) => coincideRepo({ ...r, name: r.nombre }, txt)).slice(0, 12);
    if (!hits.length) { warn('Sin resultados, prueba otra vez.'); continue; }
    const o2 = {};
    hits.forEach((r) => { o2[r.ruta] = { etiqueta: r.ruta, explica: explicaDe(r) }; });
    return e('Resultados', o2);
  }
}

// Lista lo que la forja devuelve a la cuenta de la sesión. Devuelve la ruta, '__crear' si la cuenta no
// tiene repos y quiere crear uno, o null.
async function elegirRepoCuenta(ctx, titulo, { elige: e = elige, pregunta: q = pregunta, confirma: c = confirma } = {}) {
  const spin = spinner('Cargando tus proyectos');
  const repos = await ctx.forja.alta.accesibles({ host: ctx.perfil.host, token: ctx.auth.token });
  spin();
  if (!repos.length) {
    caja(['Tu cuenta aún no tiene repositorios.', `${C.d}Crea uno nuevo y te guío paso a paso.${C.x}`], { titulo: 'Sin proyectos (de momento)' });
    return (await c('¿Crear uno nuevo ahora?', 's')) ? '__crear' : null;
  }
  return elegirDeLista(repos, titulo, { elige: e, pregunta: q });
}

// ---------- flujo ABRIR (repo existente) ----------
// ctx = { auth, perfil, forja, destino } (sesión ya resuelta). rutaDada: el repo pedido (ruta o nombre).
// Devuelve { destino, ruta } al clonar, 'CREAR' si la cuenta no tenía repos y se eligió crear uno, o nada.
async function flujoAbrir(auth, org, cfg, ctx, rutaDada = argVal('abrir')) {
  paso('Elegir proyecto');
  const abrirFlag = rutaDada;
  // Una ruta completa puede ser de otro dueño (repo compartido) o, en GitLab, de un subgrupo.
  const rutaRepo = abrirFlag ? (abrirFlag.includes('/') ? abrirFlag : `${org}/${abrirFlag}`)
    : DRY ? `${org}/faro-analisis-de-red` : await elegirRepoCuenta(ctx, 'Elige el proyecto a abrir');
  if (rutaRepo === '__crear') return 'CREAR';
  if (!rutaRepo) { warn('No se eligió ningún proyecto.'); return; }
  const partes = rutaRepo.split('/');
  const repoName = partes.pop();
  const orgRepo = partes.join('/');
  // Sin nivel Developer no podrás empujar, y sin Reporter ni clonar: el acceso se pide en la forja.
  if (ctx.perfil.forja === 'gitlab' && !DRY) {
    const rol = await ctx.forja.rolEn(ctx.perfil.host, auth.token, rutaRepo);
    if (rol.nivel < 30) {
      warn(`No tienes nivel Developer en ${rutaRepo} (nivel actual: ${rol.nivel || 'ninguno'}): podrás ${rol.nivel >= 20 ? 'clonar pero no empujar' : 'ni clonar'}.`);
      if (rol.nivel < 20) { say(`  ${C.d}Pide acceso a quien administra el proyecto y vuelve a ejecutar: faro --abrir=${rutaRepo}${C.x}`); return; }
    }
  }
  paso('Dónde clonar');
  const destino = await elegirDestino(cfg, repoName);
  const baseDir = path.dirname(destino); cfg.workdir = baseDir; saveConfig(cfg);
  if (DRY) { ok(`(dry-run) Clonaría ${ctx.perfil.host}/${rutaRepo} en ${destino}.`); return; }
  paso('Clonar y abrir');
  // El cableado de la sesión cubre el destino; un repo de otro dueño necesita el suyo para empujar.
  if (orgRepo.toLowerCase() !== String(ctx.destino.org).toLowerCase()) cablearCredentialHelper(orgRepo, ctx.perfil.host);
  await finalizarLocal(auth, orgRepo, repoName, baseDir, destino, null, ctx);
  return { destino, ruta: rutaRepo };
}

export { flujoAbrir, elegirDeLista, elegirRepoCuenta };
