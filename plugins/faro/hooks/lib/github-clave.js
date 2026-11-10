// lib/github-clave.js — CLAVE de proyecto en GitHub (topic 'clave-<clave>' del repo). Extraido de
// github.js por atomicidad (~400 lineas por modulo): el nucleo se queda con identidad, rol, equipo,
// peticiones, tareas y resumen.
//
// La clave del doc_id (CLAVE-TIPO-NNN) es UNICA en la organizacion y ESTABLE de por vida: renombrar
// el repo NO la cambia. Por eso vive en un TOPIC del repositorio y no en su nombre.
'use strict';

module.exports = function (g) {
  const { ghApi, ghRepo, git } = g;

  // ---- GESTION DOCUMENTAL de la CLAVE de proyecto (topic clave-<clave> del repo) ----
  // La clave del doc_id (CLAVE-TIPO-NNN) debe ser UNICA en la org y ESTABLE de por vida — si el
  // proyecto se renombra, la clave NO cambia (mismo principio que el renombrado de repo: el nombre
  // es cosmetico, doc_id/clave son identidad permanente). El plugin (cache local) no puede mantener
  // un registro compartido; la API de GitHub SI es la unica superficie compartida ya usada
  // (topics/teams) -> se registra como topic 'clave-<clave>' y se verifica buscando ESE topic en
  // TODA la org antes de fijarla (mismo patron que Jira: valida contra el registro central antes
  // de aceptar la clave de un proyecto nuevo).
  // 4-10 caracteres, empieza por letra. El minimo es 4 (decision 2026-08-04): con 2-3 letras las
  // siglas chocan constantemente entre proyectos de la misma org (CP, API, GUI...) y ademas no se
  // entienden al leer un doc_id suelto. La clave es UNA POR REPO — nunca compartida entre repos:
  // la numeracion de doc_id se calcula leyendo los ficheros LOCALES, asi que dos repos con la misma
  // clave emiten el MISMO id (PLANETA-GUI-101 en los dos) sin enterarse. Codigo separado, clave separada.
  const CLAVE_RE = /^[A-Z][A-Z0-9]{3,9}$/;
  function claveValida(clave) { return CLAVE_RE.test(String(clave || '').toUpperCase()); }
  // Topics ACTUALES del repo (para leer si YA tiene clave-* estampada).
  async function repoTopics(org, repo) {
    const r = await ghApi(`repos/${org}/${repo}/topics`);
    return (r.ok && r.body && Array.isArray(r.body.names)) ? r.body.names : [];
  }
  // Clave YA estampada en ESTE repo (topic clave-*), o null.
  async function claveDeEsteRepo(org, repo) {
    const t = (await repoTopics(org, repo)).find((x) => /^clave-[a-z0-9]{2,10}$/.test(x));
    return t ? t.slice('clave-'.length).toUpperCase() : null;
  }
  // ¿Esa clave ya esta en uso en OTRO repo de la org? Devuelve el nombre del repo que la tiene, o null.
  async function claveEnUso(org, clave, excluirRepo) {
    const q = `org:${org} topic:clave-${String(clave).toLowerCase()}`;
    const r = await ghApi(`search/repositories?q=${encodeURIComponent(q)}`);
    if (!r.ok || !r.body || !Array.isArray(r.body.items)) return undefined;   // busqueda no disponible -> no se puede verificar (distinto de "libre")
    const hit = r.body.items.find((x) => x.name.toLowerCase() !== String(excluirRepo || '').toLowerCase());
    return hit ? hit.name : null;
  }
  // Sugiere una clave y, si choca en la org, prueba sufijos numericos (FCP, CLV2, CLV3...).
  // Una sola palabra CORTA (<=10, ej. "Planeta") -> la palabra COMPLETA, sin acortar
  // artificialmente. Varias palabras, o una palabra larga (>10) -> siglas (FARO Control Panel -> FCP).
  async function sugerirClave(org, nombre, excluirRepo) {
    const STOP = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'o', 'u', 'a', 'e', 'en', 'para', 'por', 'con', 'sin', 'al', 'un', 'una', 'the', 'of', 'and', 'for', 'to']);
    const raw = String(nombre || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
    const words = raw.split(/[^a-zA-Z0-9]+/).filter(Boolean).filter((w) => !STOP.has(w.toLowerCase()));
    const unaPalabraLimpia = words.length === 1 ? words[0].toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
    let base = words.length >= 2
      ? words.map((w) => w[0]).join('').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10)
      : (unaPalabraLimpia && unaPalabraLimpia.length <= 10 ? unaPalabraLimpia : (unaPalabraLimpia || 'PRJ').slice(0, 10));
    if (!base) base = 'PRJ';
    if (!/^[A-Z]/.test(base)) base = 'P' + base;
    // MINIMO 4 (CLAVE_RE): las siglas puras se quedan cortas ("Faro Control Panel" -> FCP) y la
    // sugerencia seria INVALIDA. Se alarga ALARGANDO LA ULTIMA PALABRA, no repitiendo iniciales:
    // FCP -> FCPAN (Panel), OCP -> OCPAN. Queda pronunciable y se reconoce el proyecto — importa,
    // porque esta clave encabeza cada doc_id que el equipo leera a diario.
    if (base.length < 4 && words.length >= 2) {
      const ultima = words[words.length - 1].toUpperCase().replace(/[^A-Z0-9]/g, '');
      for (let i = 1; i < ultima.length && base.length < 5; i++) base += ultima[i];
    }
    if (base.length < 4) base = (base + (unaPalabraLimpia || 'PROJ')).replace(/[^A-Z0-9]/g, '').slice(0, 10);
    if (base.length < 4) base = (base + 'PROJ').slice(0, 4);   // ultimo recurso: nombre demasiado corto
    base = base.slice(0, 10);
    for (let i = 0; i < 20; i++) {
      const cand = i === 0 ? base : `${base}${i + 1}`.slice(0, 10);
      const enUso = await claveEnUso(org, cand, excluirRepo);
      if (enUso === null) return cand;          // libre, confirmado
      if (enUso === undefined) return cand;      // no se pudo verificar: mejor esfuerzo, no bloquea
    }
    return base;
  }
  // Fija (o corrige) el topic clave-<clave> del repo, PRESERVANDO el resto de topics existentes.
  async function estamparClave(org, repo, clave, topicsActuales) {
    const cur = (topicsActuales || await repoTopics(org, repo)).filter((t) => !/^clave-[a-z0-9]{2,10}$/.test(t));
    const names = [...new Set([...cur, `clave-${clave.toLowerCase()}`])];
    return ghApi(`repos/${org}/${repo}/topics`, { method: 'PUT', body: { names } });
  }
  // ¿Hay repos de la org con NOMBRE parecido (mismos tokens significativos)? Detecta el caso
  // "microservicio de un proyecto ya existente" ANTES de fijar la clave — mismo criterio de tokens
  // que usa el CLI (coincideRepo/parecidosA) para avisar de casi-duplicados al crear.
  const CLAVE_STOP = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'o', 'u', 'a', 'e', 'en', 'para', 'por', 'con', 'sin', 'al', 'un', 'una', 'the', 'of', 'and', 'for', 'to']);
  const tokensDe = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(Boolean).filter((w) => !CLAVE_STOP.has(w));
  async function reposParecidos(org, nombre, excluirRepo) {
    const toks = tokensDe(nombre);
    if (!toks.length) return [];
    const r = await ghApi(`orgs/${org}/repos?per_page=100&type=all`);
    if (!r.ok || !Array.isArray(r.body)) return [];
    const out = [];
    for (const repo of r.body) {
      if (repo.name.toLowerCase() === String(excluirRepo || '').toLowerCase()) continue;
      const rTok = tokensDe(repo.name);
      if (toks.some((t) => rTok.includes(t))) {
        const clave = (repo.topics || []).find((t) => /^clave-[a-z0-9]{2,10}$/.test(t));
        out.push({ name: repo.name, clave: clave ? clave.slice('clave-'.length).toUpperCase() : null });
      }
    }
    return out.slice(0, 5);
  }

  // --- Identidad de la cuenta autenticada del remoto (gh api user > ssh -T > email por eventos publicos) ---
  let _authId;

  async function cmdClave() {
    const repoInfo = ghRepo();
    if (!repoInfo) { process.stdout.write('Sin remoto origin de GitHub — no puedo gestionar la clave.\n'); return; }
    const { org, repo } = repoInfo;
    const arg = process.argv[3];
    if (!arg) {
      const actual = await claveDeEsteRepo(org, repo);
      if (!actual) { process.stdout.write('SIN_CLAVE: este repo no tiene clave declarada (topic clave-*). Sugiere una con: harness.js clave --sugerir "<nombre del proyecto>"\n'); return; }
      const enOtro = await claveEnUso(org, actual, repo);
      // Repos YA estampados con clave repetida: es deuda que hay que resolver, no un aviso menor.
      // Mientras dure, los dos repos emiten los mismos doc_id y nadie se entera hasta juntarlos.
      if (enOtro) process.stdout.write(`CLAVE: ${actual}\nCOLISION: la clave '${actual}' tambien es del repo '${enOtro}'. Las claves son UNA POR REPO: mientras esten duplicadas, ambos generan '${actual}-TIPO-NNN' con los MISMOS numeros y los doc_id chocan al juntar la documentacion.\n  ARREGLO: decide cual conserva '${actual}' y da clave propia al otro (harness.js clave <NUEVA>); luego renombra sus doc_id ya emitidos. Si en realidad son el mismo proyecto, documenta en uno solo.\n`);
      else process.stdout.write(`CLAVE: ${actual}\n`);
      return;
    }
    if (arg === '--sugerir') {
      const nombre = process.argv[4] || repo;
      const cand = await sugerirClave(org, nombre, repo);
      const parecidos = await reposParecidos(org, nombre, repo);
      process.stdout.write(`SUGERIDA: ${cand} (a partir de "${nombre}") — confirma con el usuario antes de fijarla: harness.js clave ${cand}\n`);
      if (parecidos.length) {
        process.stdout.write(`RELACIONADOS: encontré repo(s) con nombre parecido en la org: ${parecidos.map((p) => `${p.name}${p.clave ? ` (clave ${p.clave})` : ''}`).join(', ')}. ` +
          'PREGUNTA al usuario (AskUserQuestion) ANTES de fijar la clave: ¿es el MISMO proyecto (entonces reutiliza su clave existente, no crees una nueva) o es un microservicio/componente SEPARADO del mismo dominio (entonces clave propia está bien, pero valora enlazarlos — p. ej. mismo prefijo o una nota en ESTADO.md)?\n');
      }
      return;
    }
    const clave = String(arg).toUpperCase();
    if (!claveValida(clave)) { process.stdout.write(`INVALIDA: '${clave}' no cumple el formato (4-10 caracteres, empieza por letra, solo A-Z0-9 — estilo Jira). Con menos de 4 las siglas chocan entre proyectos (CP, API, GUI) y no se entienden al leer un doc_id suelto.\n`); return; }
    const enOtro = await claveEnUso(org, clave, repo);
    // UNA CLAVE POR REPO (decision 2026-08-04). Compartirla entre repos ROMPE la numeracion: los
    // doc_id se calculan leyendo los ficheros LOCALES, asi que dos repos con la misma clave emiten
    // el MISMO id (CLAVE-GUI-101 en ambos) sin poder detectarlo — y la colision no aparece hasta que
    // alguien junta la documentacion. Repartir rangos a mano es fragil (se olvida al crear el repo
    // siguiente, y nada impide desbordarlos). Con clave propia la colision es IMPOSIBLE por diseno.
    // Por eso aqui NO se estampa: se para y se ofrece una alternativa concreta.
    if (enOtro) {
      const alt = await sugerirClave(org, repo, repo);
      process.stdout.write(`EN_USO: la clave '${clave}' ya es del repo '${enOtro}'. Las claves son UNA POR REPO: si dos repos la comparten, ambos generarian '${clave}-TIPO-001' y los doc_id colisionarian sin aviso.\n` +
        `  Elige otra para este repo (4-10 letras, que se entienda al leerla suelta)${alt && alt !== clave ? ` — p. ej.: ${alt}` : ''}:  harness.js clave <CLAVE>\n` +
        `  Si de verdad es el MISMO proyecto que '${enOtro}', entonces no necesita clave propia: documenta alli.\n`);
      return;
    }
    if (enOtro === undefined) process.stdout.write('AVISO: no pude verificar unicidad en la org (busqueda no disponible) — fijo igualmente, pero no hay garantia de que sea unica.\n');
    const r = await estamparClave(org, repo, clave);
    if (r.ok) process.stdout.write(`FIJADA: ${clave} (topic clave-${clave.toLowerCase()} estampado en ${org}/${repo}). Escribe 'clave: ${clave}' en el frontmatter de ESTADO.md.\n`);
    else process.stdout.write(`ERROR: no pude estampar el topic (${r.status}).\n`);
  }

  return { claveValida, claveDeEsteRepo, claveEnUso, sugerirClave, estamparClave, reposParecidos, repoTopics, cmdClave };
};
