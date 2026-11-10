// lib/github-gestion.js — PARIDAD de GitHub con el adaptador de GitLab en lo que GitHub SI permite:
// hitos (fase = milestone), miembros (colaboradores), peticiones por intencion (ver/aprobar/mergear),
// renombrar, y la deteccion HONESTA de lo que el plan no da.
//
// LIMITE DE PLAN, verificado en la documentacion (feb 2026): en GitHub FREE con repositorio PRIVADO
// **no hay proteccion de ramas** — ni reglas clasicas ni rulesets — ni revisiones requeridas. Eso
// exige GitHub Team o superior. Consecuencia honesta: 'proteger' y 'exigir-pipeline' NO pueden
// funcionar ahi, y el harness debe DECIRLO en vez de fallar con un error tecnico: si no, el usuario
// cree que 'main' esta protegida cuando cualquiera puede escribir en ella.
//
// Lo que GitHub NO tiene de ninguna manera, y por eso no se emula: tiempo/estimacion nativos por
// incidencia, y enlaces de BLOQUEO entre tareas. En GitLab si existen (ver forge-gitlab-gestion.js).
'use strict';

module.exports = function (g) {
  const { ghApi, ghRepo, sinToken, git } = g;
  const argv = () => process.argv.slice(3);
  const flag = (a, k) => { const i = a.indexOf(k); return i >= 0 ? (a[i + 1] || '') : null; };
  const sinFlags = (a) => { const out = []; for (let i = 0; i < a.length; i++) { if (/^--/.test(a[i])) { i++; continue; } out.push(a[i]); } return out; };
  const R = () => { const r = ghRepo(); if (!r) { console.log('No detecto un remoto de GitHub.'); process.exit(1); } return r; };
  const salir = (r) => { if (r && r.sinToken) { console.log(sinToken()); process.exit(2); } };

  // ¿El fallo viene del PLAN y no de un permiso? GitHub responde 403 con un mensaje explicito.
  const esLimitePlan = (r) => r && (r.status === 403 || r.status === 404) &&
    /upgrade|not available|only available|public repositor/i.test(String((r.body && r.body.message) || ''));
  function avisoPlan(que) {
    console.log(`ℹ ${que}: tu plan de GitHub NO lo permite en un repositorio PRIVADO.`);
    console.log('   En GitHub Free, la proteccion de ramas y las revisiones requeridas solo aplican a repos PUBLICOS;');
    console.log('   en privado exigen GitHub Team o superior. Es un limite del plan, no un fallo del harness.');
    console.log('   MIENTRAS TANTO el unico gobierno real son los gates LOCALES del harness (bloquean el commit');
    console.log('   directo a main antes de salir de tu maquina) y la revision del agente. El servidor NO impide');
    console.log('   que alguien con permiso de escritura empuje a main saltandose el plugin. Tenlo presente.');
  }

  // ---- HITOS (GitHub SI los tiene, y son gratuitos) ----
  async function hitos(estado) {
    const { org, repo } = R();
    const r = await ghApi(`repos/${org}/${repo}/milestones?state=${estado || 'all'}&per_page=100`);
    salir(r);
    return (r.ok && Array.isArray(r.body)) ? r.body : [];
  }
  const buscarHito = (lista, ref) => lista.find((m) => String(m.number) === String(ref) || String(m.title).toLowerCase() === String(ref).toLowerCase()) || null;
  async function crearHito(titulo, extra = {}) {
    const { org, repo } = R();
    const ya = buscarHito(await hitos('all'), titulo);
    if (ya) return { hito: ya, creado: false };
    const r = await ghApi(`repos/${org}/${repo}/milestones`, { method: 'POST', body: { title: titulo, ...extra } });
    salir(r);
    return r.ok ? { hito: r.body, creado: true } : { error: r };
  }
  async function estadoHito(numero, estado) {
    const { org, repo } = R();
    const r = await ghApi(`repos/${org}/${repo}/milestones/${numero}`, { method: 'PATCH', body: { state: estado } });
    salir(r);
    const v = await ghApi(`repos/${org}/${repo}/milestones/${numero}`);   // relectura: el efecto real
    return v.ok && v.body ? v.body.state : null;
  }
  const tituloFase = (f) => `Fase ${f.num} — ${f.nombre}`;
  async function syncHitos() {
    const lista = g.fases ? g.fases() : [];
    if (!lista.length) return [];
    const existentes = await hitos('all');
    const out = [];
    // BACKLOG siempre presente: es la sala de espera del trabajo aceptado sin fecha. Si solo naciera
    // cuando alguien usa '--hito backlog', no estaria cuando hace falta ofrecerlo. Es el UNICO hito
    // que no caduca (por eso no se le pone fecha ni se cierra nunca); los demas son fases.
    if (!buscarHito(existentes, 'Backlog')) {
      const cr = await crearHito('Backlog', { description: 'Trabajo aceptado sin fase asignada todavia. No caduca: de aqui solo se sale a una fase.' });
      if (!cr.error) { existentes.push(cr.hito); out.push('  + Backlog: creado (sala de espera del trabajo sin fecha)'); }
    }
    for (const f of lista) {
      const titulo = tituloFase(f);
      // FECHA OBJETIVO: ESTADO.md manda. La fase ya trae 'objetivo' parseado (lib/estado.js), y el
      // hito lo refleja en due_on -> la forja muestra el vencimiento y avisa de hitos pasados de
      // fecha, sin mantener la fecha en dos sitios. Si la fase NO tiene objetivo no se inventa
      // ninguna, y quitar el objetivo del fichero TAMPOCO borra la del hito: omitir no es ordenar
      // borrar, y destruir un dato por omision seria peor que dejarlo desactualizado.
      const vence = f.objetivo ? `${f.objetivo}T00:00:00Z` : null;
      let m = buscarHito(existentes, titulo);
      if (!m) { const r = await crearHito(titulo, vence ? { due_on: vence } : {}); if (r.error) { out.push(`  ✗ ${titulo}: no se pudo crear (HTTP ${r.error.status})`); continue; } m = r.hito; out.push(`  + ${titulo}: creado (#${m.number})${vence ? ` · vence ${f.objetivo}` : ''}`); }
      else if (vence && String(m.due_on || '').slice(0, 10) !== f.objetivo) {
        const { org, repo } = R();
        const pr = await ghApi(`repos/${org}/${repo}/milestones/${m.number}`, { method: 'PATCH', body: { due_on: vence } });
        out.push(`  📅 ${titulo}: ${pr.ok ? `fecha objetivo actualizada a ${f.objetivo}` : `NO se pudo actualizar la fecha (HTTP ${pr.status})`}`);
      }
      const debeCerrado = g.isDone ? g.isDone(f.estado) : false;
      // CIERRE FORZOSO: una fase 'done' no puede cerrar su hito con tareas SUYAS abiertas dentro —
      // se perderian de vista (el open_issues del hito ya viene en la respuesta de milestones, sin
      // llamada extra). El motor DETECTA y avisa cuantas quedan; NUNCA las mueve ni las cierra por
      // su cuenta (mover una tarea de fase es un cambio de alcance, decision de gestion, no del
      // harness) — mismo principio que 'validate' ya aplica al ciclo spec<->tasks<->fase.
      if (debeCerrado && m.open_issues > 0) {
        // Cubre los dos casos: el hito que ibamos a cerrar, y el que YA esta cerrado (p. ej. a mano
        // desde la web) pero dejo tareas abiertas dentro. En ambos el aviso salta SOLO, sin pedirlo.
        const yaCerrado = m.state === 'closed';
        out.push(`  ⚠ ${titulo}: ${yaCerrado ? `CERRADO pero con ${m.open_issues} tarea(s) abierta(s) dentro (¿cerrado a mano?)` : `NO se cierra — ${m.open_issues} tarea(s) abierta(s) en el hito`}. Comprueba si ya estan hechas:  harness.js hito verificar "${titulo}"  · luego cerrar-tarea <N> / mover-tarea <N> --hito <M> / descartar-tarea <N>.`);
      } else if (debeCerrado && m.state !== 'closed') { const st = await estadoHito(m.number, 'closed'); out.push(`  ✓ ${titulo}: ${st === 'closed' ? 'cerrado (fase terminada)' : 'NO se pudo cerrar'}`); }
      else if (!debeCerrado && m.state === 'closed') { const st = await estadoHito(m.number, 'open'); out.push(`  ↺ ${titulo}: ${st === 'open' ? 'reabierto (la fase no esta terminada)' : 'NO se pudo reabrir'}`); }
      else out.push(`  = ${titulo}: ya coherente (${m.state})`);
    }
    return out;
  }
  async function cmdHito() {
    const a = argv(); const sub = a[0] || 'listar';
    if (sub === 'listar' || sub === 'ver') {
      const lista = await hitos(a.includes('--all') ? 'all' : 'open');
      if (!lista.length) { console.log('Sin hitos. Crea uno por fase: harness.js hito crear "Fase 1 — <nombre>" [--vence AAAA-MM-DD]  ·  o sincroniza desde ESTADO.md: harness.js hito sync'); return; }
      const { org, repo } = R();
      console.log(`Hitos de ${org}/${repo} (${lista.length}):`);
      for (const m of lista) {
        const total = (m.open_issues || 0) + (m.closed_issues || 0);
        console.log(`  #${m.number} [${m.state}] ${m.title}${m.due_on ? ` · vence ${String(m.due_on).slice(0, 10)}` : ''} · tareas ${m.closed_issues || 0}/${total}  ·  ${m.html_url}`);
      }
      console.log('  (GitHub NO tiene estimacion ni horas consumidas: eso es nativo solo en GitLab.)');
      return;
    }
    if (sub === 'crear') {
      const titulo = sinFlags(a.slice(1)).join(' ').trim();
      if (!titulo) { console.log('Uso: harness.js hito crear "<titulo>" [--vence AAAA-MM-DD] [--desc "<texto>"]'); process.exit(1); }
      const extra = {}; const v = flag(a, '--vence'), d = flag(a, '--desc');
      if (v) extra.due_on = `${v}T00:00:00Z`; if (d) extra.description = d;
      const r = await crearHito(titulo, extra);
      if (r.error) { console.log(`No pude crear el hito (HTTP ${r.error.status})${r.error.body && r.error.body.message ? `: ${r.error.body.message}` : ''}.`); return; }
      console.log(r.creado ? `✅ Hito creado: #${r.hito.number} "${r.hito.title}" · ${r.hito.html_url}` : `Ya existia: #${r.hito.number} "${r.hito.title}" (no se duplica).`);
      return;
    }
    // hito verificar <titulo>: ¿el cierre de esta fase fue ADECUADO? No impide nada —cerrar desde la
    // web puede ser legitimo—, pero nada queda sin comprobar. Por cada tarea del hito busca evidencia
    // DETERMINISTA (un PR fusionado que la referencie), y dice cual la tiene y cual no:
    //   - abierta CON PR fusionado -> se hizo, solo falto cerrarla (ofrece cerrar-tarea)
    //   - abierta SIN PR           -> quedo colgando de verdad
    //   - cerrada CON PR           -> cierre correcto
    //   - cerrada SIN PR           -> cerrada a mano, sin respaldo: que alguien lo confirme
    //   - descartada (not_planned) -> decision explicita, no se le pide evidencia
    // hito auditar: BARRIDO GLOBAL — recorre TODOS los issues abiertos del repo (paginando) y lista
    // los que no tienen hito. Distinto de 'verificar' (que mira UN hito) y de la vigilancia de fondo
    // (que solo da un numero barato): esto cubre el PASADO — issues creados antes del anclaje
    // (0.35.0) o desde la web sin pasar por el harness. Critico: nada mas ve el conjunto entero.
    // Los de tipo CIERRE (duplicado/descartado) NO cuentan como huerfanos: cerrar no es planificar.
    if (sub === 'auditar') {
      const { org, repo } = R();
      // ciclo:'cierre' del schema (duplicado/descartado) sin pasar faroSchema: este modulo no lo
      // recibe, y los NOMBRES son estables (nativos de GitHub + su faro:<slug> equivalente).
      const LABELS_CIERRE = ['duplicate', 'wontfix', 'faro:duplicado', 'faro:descartado'];
      const esCierre = (i) => (i.labels || []).some((l) => LABELS_CIERRE.includes(String(l.name).toLowerCase()));
      const DIAS_ESTANCADO = 30;
      const huerfanos = [], olvidados = [];
      for (let page = 1; page <= 20; page++) {
        const r = await ghApi(`repos/${org}/${repo}/issues?state=open&per_page=100&page=${page}`);
        salir(r);
        if (!r.ok || !Array.isArray(r.body) || !r.body.length) break;
        for (const i of r.body) {
          if (i.pull_request) continue;          // los PRs vienen mezclados en /issues
          if (esCierre(i)) continue;
          const dias = Math.round((Date.now() - new Date(i.updated_at)) / 86400000);
          if (!i.milestone) huerfanos.push({ ...i, dias });
          // OLVIDADOS: un issue con hito (bien anclado) puede seguir sin cerrarse durante semanas —
          // "se debe cerrar, no olvidarse". Sin hito ya sale en huerfanos; aqui es el caso simetrico.
          else if (dias >= DIAS_ESTANCADO) olvidados.push({ ...i, dias });
        }
        if (r.body.length < 100) break;
      }
      huerfanos.sort((x, y) => x.number - y.number);
      olvidados.sort((x, y) => x.number - y.number);
      if (!huerfanos.length && !olvidados.length) { console.log('Auditoria de hitos: 0 issue(s) sin hito. Todo el trabajo abierto esta anclado a una fase o al Backlog.'); return; }
      if (huerfanos.length) {
        console.log(`Auditoria de hitos: ${huerfanos.length} issue(s) SIN hito (huerfanos):`);
        for (const i of huerfanos) {
          const tipos = (i.labels || []).map((l) => l.name).join(', ');
          console.log(`  #${i.number} ${i.title}${tipos ? ` [${tipos}]` : ''} · sin tocar hace ${i.dias}d`);
          console.log(`     harness.js mover-tarea ${i.number} --hito <N|backlog>`);
        }
      }
      if (olvidados.length) {
        console.log(`${huerfanos.length ? '\n' : ''}Auditoria de hitos: ${olvidados.length} issue(s) OLVIDADOS (con hito, pero sin tocarse hace >=${DIAS_ESTANCADO}d):`);
        for (const i of olvidados) {
          console.log(`  #${i.number} ${i.title} — hito "${i.milestone.title}" · sin tocar hace ${i.dias}d`);
          console.log(`     ¿sigue vigente? cierrala si esta hecha: harness.js cerrar-tarea ${i.number}  ·  si no se hara: harness.js descartar-tarea ${i.number} "<motivo>"`);
        }
      }
      return;
    }
    if (sub === 'verificar') {
      const { org, repo } = R();
      const m = buscarHito(await hitos('all'), a.slice(1).join(' ').trim());
      if (!m) { console.log('No encuentro ese hito. Lista: harness.js hito listar --all'); process.exit(1); }
      const ri = await ghApi(`repos/${org}/${repo}/issues?milestone=${m.number}&state=all&per_page=100`);
      salir(ri);
      const tareas = (ri.ok && Array.isArray(ri.body)) ? ri.body.filter((i) => !i.pull_request) : [];
      if (!tareas.length) { console.log(`Hito "${m.title}" [${m.state}]: sin tareas abiertas ni cerradas dentro — cierre limpio, nada que verificar.`); return; }
      console.log(`Verificando "${m.title}" [${m.state}] — ${tareas.length} tarea(s):`);
      // MISMA regla que consolidar y publicar (lib/tarea.js, #71): evidencia = un PR que la referencia
      // (numero de rama o 'Closes #N') fusionado en develop/main. Antes se buscaba el numero como texto
      // libre en los PRs, y una mencion cualquiera contaba como respaldo.
      const tarea = require('./tarea.js');
      const prs = [];
      for (let p = 1; p <= 3; p++) {
        const rp = await ghApi(`repos/${org}/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${p}`);
        if (!rp.ok || !Array.isArray(rp.body)) break;
        prs.push(...rp.body);
        if (rp.body.length < 100) break;
      }
      let sinRespaldo = 0, hechasSinCerrar = 0;
      for (const t of tareas) {
        const e = tarea.evaluarTarea(t, prs);
        const pr = e.evidencia && e.evidencia.pr;
        if (e.estado === 'descartada') console.log(`  · #${t.number} ${t.title} — DESCARTADA (decision explicita, no necesita evidencia)`);
        else if (e.accion) { hechasSinCerrar++; console.log(`  ⚠ #${t.number} ${t.title} — ABIERTA pero con PR #${pr} integrado: el trabajo entro, falto cerrarla. La cierra el proximo 'consolidar', o ya: harness.js cerrar-tarea ${t.number}`); }
        else if (t.state === 'open') { sinRespaldo++; console.log(`  ✗ #${t.number} ${t.title} — ABIERTA y SIN EVIDENCIA de estar hecha (${e.estado}).`); }
        else if (e.estado === 'hecha') console.log(`  ✓ #${t.number} ${t.title} — cerrada, respaldada por el PR #${pr}.`);
        else { sinRespaldo++; console.log(`  ⚠ #${t.number} ${t.title} — cerrada SIN PR que la respalde: confirma que se hizo de verdad.`); }
      }
      console.log(sinRespaldo || hechasSinCerrar
        ? `\nResultado: ${hechasSinCerrar} hecha(s) sin cerrar · ${sinRespaldo} sin evidencia. El cierre de esta fase NO esta limpio.`
        : '\nResultado: todas las tareas tienen respaldo. El cierre fue correcto.');
      return;
    }
    if (sub === 'cerrar' || sub === 'reabrir') {
      const m = buscarHito(await hitos('all'), a.slice(1).join(' ').trim());
      if (!m) { console.log('No encuentro ese hito. Lista: harness.js hito listar --all'); process.exit(1); }
      // CIERRE FORZOSO, tambien por esta puerta: 'hito sync' ya lo aplicaba, pero 'hito cerrar' se lo
      // saltaba. Si queda trabajo abierto dentro, la fase no se cierra — y se dice como resolverlo.
      if (sub === 'cerrar' && m.open_issues > 0) {
        console.log(`NO cierro "${m.title}": tiene ${m.open_issues} tarea(s) abierta(s) dentro — se perderian de vista.`);
        console.log(`   Comprueba si ya estan hechas:  harness.js hito verificar "${m.title}"`);
        console.log(`   Luego, por cada una:  cerrar-tarea <N>  (hecha) · mover-tarea <N> --hito <M>  (va a otra fase) · descartar-tarea <N> "<motivo>"  (no se hara)`);
        process.exit(1);
      }
      const st = await estadoHito(m.number, sub === 'cerrar' ? 'closed' : 'open');
      console.log(st === (sub === 'cerrar' ? 'closed' : 'open') ? `✅ Hito #${m.number} "${m.title}" ${sub === 'cerrar' ? 'cerrado' : 'reabierto'}.` : `⚠ GitHub acepto la peticion pero el hito sigue en '${st}'.`);
      return;
    }
    if (sub === 'sync') {
      const out = await syncHitos();
      console.log(out.length ? `Hitos sincronizados con las fases de ESTADO.md:\n${out.join('\n')}` : 'ESTADO.md sin fases: nada que sincronizar.');
      return;
    }
    console.log('Uso: harness.js hito [listar [--all] | crear "<titulo>" [--vence F] | cerrar <hito> | reabrir <hito> | sync | verificar <hito> | auditar]'); process.exit(1);
  }

  // ---- MIEMBROS (colaboradores del repo; gratuitos) ----
  const ROLES = { read: 'pull', triage: 'triage', write: 'push', maintain: 'maintain', admin: 'admin', developer: 'push', maintainer: 'maintain', owner: 'admin' };
  async function cmdMiembro() {
    const [sub, quien, rol] = argv();
    const uso = 'Uso: harness.js miembro [listar | anadir <usuario> <developer|maintainer|owner|read|triage|write|maintain|admin> | quitar <usuario>]';
    const { org, repo } = R();
    if (!sub || sub === 'listar') return g.cmdEquipo();
    if (!quien) { console.log(uso); process.exit(1); }
    const login = String(quien).replace(/^@/, '');
    if (sub === 'anadir') {
      const permiso = ROLES[String(rol || '').toLowerCase()];
      if (!permiso) { console.log(`Rol invalido '${rol || ''}'. Usa: developer · maintainer · owner (o los nombres de GitHub: read/triage/write/maintain/admin)\n${uso}`); process.exit(1); }
      const r = await ghApi(`repos/${org}/${repo}/collaborators/${encodeURIComponent(login)}`, { method: 'PUT', body: { permission: permiso } });
      salir(r);
      if (!r.ok) { console.log(`No pude anadir a ${login} (HTTP ${r.status})${r.body && r.body.message ? `: ${r.body.message}` : ''}. Hace falta permiso admin en el repo.`); process.exit(1); }
      // 201 = invitacion pendiente de que la acepte; 204 = ya era colaborador y se actualizo el permiso.
      console.log(r.status === 201
        ? `✅ Invitacion enviada a ${login} como ${rol} (${permiso}). Contara como miembro cuando la ACEPTE.`
        : `✅ ${login} es colaborador de ${org}/${repo} con permiso ${permiso}.`);
      return;
    }
    if (sub === 'quitar') {
      const r = await ghApi(`repos/${org}/${repo}/collaborators/${encodeURIComponent(login)}`, { method: 'DELETE' });
      salir(r);
      console.log(r.ok ? `✅ ${login} ya no es colaborador directo (puede conservar acceso por su equipo de la organizacion).` : `No pude quitarlo (HTTP ${r.status}).`);
      return;
    }
    console.log(uso); process.exit(1);
  }

  // ---- PETICIONES por INTENCION (ver / aprobar / mergear) ----
  async function estadoPr(n) {
    const { org, repo } = R();
    const [pr, rev] = await Promise.all([ghApi(`repos/${org}/${repo}/pulls/${n}`), ghApi(`repos/${org}/${repo}/pulls/${n}/reviews?per_page=100`)]);
    salir(pr);
    if (!pr.ok || !pr.body) return null;
    const revisiones = (rev.ok && Array.isArray(rev.body)) ? rev.body : [];
    const porUsuario = new Map();
    for (const v of revisiones) if (v.user && v.state !== 'COMMENTED') porUsuario.set(v.user.login, v.state);
    const aprobado = [...porUsuario.entries()].filter(([, s]) => s === 'APPROVED').map(([u]) => u);
    const cambios = [...porUsuario.entries()].filter(([, s]) => s === 'CHANGES_REQUESTED').map(([u]) => u);
    return { pr: pr.body, aprobado, cambios };
  }
  const pintarPr = (e) => {
    const p = e.pr;
    console.log(`#${p.number} ${p.head && p.head.ref} -> ${p.base && p.base.ref} · ${p.title}`);
    console.log(`   estado: ${p.state}${p.draft ? ' (borrador)' : ''} · fusionable: ${p.mergeable === null ? 'calculando' : p.mergeable ? 'si' : 'NO'} · estado de fusion: ${p.mergeable_state || '?'}`);
    console.log(`   aprobaciones: ${e.aprobado.length ? e.aprobado.join(', ') : 'ninguna'}${e.cambios.length ? ` · CAMBIOS PEDIDOS por ${e.cambios.join(', ')}` : ''}`);
    console.log(`   ${p.html_url}`);
  };
  async function cmdPrVer(n) {
    const e = await estadoPr(n);
    if (!e) { console.log(`No encuentro la peticion #${n}.`); process.exit(1); }
    pintarPr(e);
  }
  async function cmdPrAprobar(n) {
    const { org, repo } = R();
    const r = await ghApi(`repos/${org}/${repo}/pulls/${n}/reviews`, { method: 'POST', body: { event: 'APPROVE' } });
    salir(r);
    if (!r.ok) {
      console.log(`No pude aprobar #${n} (HTTP ${r.status})${r.body && r.body.message ? `: ${r.body.message}` : ''}.`);
      console.log('   Causa tipica: GitHub NO deja aprobar tu propia peticion. Si trabajas solo, no necesitas la aprobacion: fusiona con  harness.js pr mergear <n> --confirmo');
      process.exit(1);
    }
    const e = await estadoPr(n);
    console.log(`✅ Aprobacion registrada en #${n}.`); if (e) pintarPr(e);
  }
  async function cmdPrMergear(n, args) {
    if (!args.includes('--confirmo')) { console.log(`Fusionar #${n} es la APROBACION: requiere --confirmo (el usuario debe haberlo confirmado en esta conversacion). Antes: harness.js pr ver ${n}`); process.exit(1); }
    const ri = g.roleInfo ? await g.roleInfo() : null;
    if (ri && ri.sinToken) { console.log(sinToken()); process.exit(2); }
    if (ri && ri.perm && !ri.puedeAprobar) { console.log(`Tu permiso (${ri.perm}) no puede fusionar. Lo aplica alguien con admin/maintain.`); process.exit(1); }
    const antes = await estadoPr(n); if (!antes) { console.log(`No encuentro la peticion #${n}.`); process.exit(1); }
    const { org, repo } = R();
    const metodo = args.includes('--squash') ? 'squash' : args.includes('--rebase') ? 'rebase' : 'merge';
    // #262: el SHA de cabeza que se acaba de leer; si la rama cambio entre medias, GitHub responde 409.
    const sha = antes.pr.head && antes.pr.head.sha;
    const r = await ghApi(`repos/${org}/${repo}/pulls/${n}/merge`, { method: 'PUT', body: { merge_method: metodo, ...(sha ? { sha } : {}) } });
    if (!r.ok) { console.log(`GitHub NO fusiono #${n} (HTTP ${r.status})${r.body && r.body.message ? `: ${r.body.message}` : ''}.${r.status === 409 ? ` La rama cambio despues de leerla (alguien subio commits): revisala con  harness.js pr ver ${n}  y vuelve a intentarlo.` : ''}`); pintarPr(antes); process.exit(1); }
    const v = await ghApi(`repos/${org}/${repo}/pulls/${n}`);
    const fusionada = v.ok && v.body && v.body.merged;
    console.log(fusionada ? `✅ #${n} FUSIONADA en ${antes.pr.base.ref} (commit ${String(r.body && r.body.sha || '').slice(0, 7)}).` : `⚠ GitHub acepto la fusion pero la peticion no figura como fusionada.`);
    if (fusionada) {
      const d = await ghApi(`repos/${org}/${repo}/git/refs/heads/${antes.pr.head.ref}`, { method: 'DELETE' });   // el ref lleva barras: NO se codifica
      console.log(d.ok ? `   Rama '${antes.pr.head.ref}' borrada.` : `   (La rama '${antes.pr.head.ref}' sigue ahi: borrala cuando quieras.)`);
    }
  }

  // ---- EXIGIR PIPELINE: en GitHub son 'required status checks' DENTRO de la proteccion de rama ----
  async function cmdExigirPipeline() {
    const { org, repo } = R();
    const rama = (argv().find((a) => !/^--/.test(a))) || 'main';
    const apagar = argv().includes('--no');
    const actual = await ghApi(`repos/${org}/${repo}/branches/${encodeURIComponent(rama)}/protection`);
    salir(actual);
    if (esLimitePlan(actual) || (!actual.ok && actual.status === 404)) {
      if (esLimitePlan(actual)) { avisoPlan(`Exigir que pase el pipeline en '${rama}'`); return; }
      console.log(`'${rama}' no tiene proteccion de rama, y en GitHub el "pipeline obligatorio" vive DENTRO de ella.`);
      console.log(`   Protegela primero:  node .claude/hooks/harness.js proteger ${rama}`);
      return;
    }
    if (!actual.ok) { console.log(`No pude leer la proteccion de '${rama}' (HTTP ${actual.status}).`); return; }
    // Los "checks" son los NOMBRES de los jobs del workflow. Se leen de las ultimas ejecuciones.
    let contexts = [];
    if (!apagar) {
      const runs = await ghApi(`repos/${org}/${repo}/commits/${encodeURIComponent(rama)}/check-runs?per_page=50`);
      contexts = (runs.ok && runs.body && Array.isArray(runs.body.check_runs)) ? [...new Set(runs.body.check_runs.map((c) => c.name))] : [];
      if (!contexts.length) { console.log(`No encuentro ninguna comprobacion ejecutada en '${rama}'. Genera el pipeline y dejalo correr una vez:  harness.js ci`); return; }
    }
    const p = actual.body || {};
    const r = await ghApi(`repos/${org}/${repo}/branches/${encodeURIComponent(rama)}/protection`, {
      method: 'PUT',
      body: {
        required_status_checks: apagar ? null : { strict: true, contexts },
        enforce_admins: !!(p.enforce_admins && p.enforce_admins.enabled),
        required_pull_request_reviews: p.required_pull_request_reviews ? { required_approving_review_count: p.required_pull_request_reviews.required_approving_review_count || 1 } : null,
        restrictions: null,
      },
    });
    if (esLimitePlan(r)) { avisoPlan(`Exigir que pase el pipeline en '${rama}'`); return; }
    if (!r.ok) { console.log(`No pude cambiarlo (HTTP ${r.status})${r.body && r.body.message ? `: ${r.body.message}` : ''}.`); return; }
    const v = await ghApi(`repos/${org}/${repo}/branches/${encodeURIComponent(rama)}/protection`);
    const real = v.ok && v.body && v.body.required_status_checks;
    if (apagar) console.log(real ? '⚠ GitHub acepto la peticion pero el pipeline sigue siendo obligatorio.' : '✅ El pipeline ya NO es obligatorio para fusionar.');
    else console.log(real ? `✅ Pipeline OBLIGATORIO en '${rama}': ${(real.contexts || []).join(', ')}. Con el en rojo, la peticion no se puede fusionar.` : '⚠ GitHub acepto la peticion pero no veo las comprobaciones requeridas.');
  }

  // ---- RENOMBRAR (GitHub mantiene REDIRECCIONES) ----
  async function cmdRenombrar() {
    const nombre = argv().filter((a) => !/^--/.test(a)).join(' ').trim();
    if (!nombre) { console.log('Uso: node .claude/hooks/harness.js renombrar "<nombre-nuevo>"'); process.exit(1); }
    const { org, repo } = R();
    const r = await ghApi(`repos/${org}/${repo}`, { method: 'PATCH', body: { name: nombre } });
    salir(r);
    if (!r.ok) { console.log(`No pude renombrar (HTTP ${r.status})${r.body && r.body.message ? `: ${r.body.message}` : ''}. Hace falta permiso admin.`); process.exit(1); }
    const nuevo = r.body && r.body.name;
    const remoto = git('remote', 'get-url', 'origin') || '';
    const nuevoRemoto = remoto.replace(new RegExp(`${repo}(\\.git)?$`), `${nuevo}$1`);
    if (nuevoRemoto !== remoto) git('remote', 'set-url', 'origin', nuevoRemoto);
    console.log(`✅ Renombrado: ${org}/${repo} -> ${org}/${nuevo}.`);
    console.log(`   GitHub mantiene REDIRECCIONES desde el nombre viejo; el origin local ya apunta al nuevo: ${nuevoRemoto}`);
  }

  // publicarRelease: crea el Release de la forja para un tag ya creado, con las notas que recibe
  // (extraidas del CHANGELOG por release.js). SOLO hacia adelante: publica el tag que se acaba de
  // crear, nunca recrea los anteriores — un release es un hecho publicado en un momento, y
  // reconstruirlo despues pondria fechas falsas. Si falla, se informa pero NO se lanza: el tag ya
  // esta creado y subido, que es lo que de verdad importa.
  async function publicarRelease(tag, notas) {
    const { org, repo } = R();
    const ya = await ghApi(`repos/${org}/${repo}/releases/tags/${encodeURIComponent(tag)}`);
    if (ya.ok && ya.body && ya.body.id) return { ok: true, yaExistia: true, url: ya.body.html_url };
    const r = await ghApi(`repos/${org}/${repo}/releases`, { method: 'POST', body: { tag_name: tag, name: tag, body: notas || '' } });
    if (!r.ok) return { ok: false, msg: `HTTP ${r.status}${r.body && r.body.message ? `: ${r.body.message}` : ''}` };
    return { ok: true, url: r.body && r.body.html_url };
  }

  // hitos/buscarHito/crearHito/tituloFase se exportan ademas de syncHitos: 'asignar-tarea --hito' los
  // reusa para resolver o crear el hito de UNA fase concreta (sin repetir la logica de arriba).
  return { cmdHito, cmdMiembro, cmdPrVer, cmdPrAprobar, cmdPrMergear, cmdExigirPipeline, cmdRenombrar, syncHitos, esLimitePlan, avisoPlan, hitos, buscarHito, crearHito, tituloFase, publicarRelease };
};
