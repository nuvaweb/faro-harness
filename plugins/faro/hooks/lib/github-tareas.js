// lib/github-tareas.js — TAREAS (issues) y RESUMEN de sesion en GitHub. Extraido de github.js por
// atomicidad (~400 lineas por modulo).
//
// Una "Tarea" de FARO es un issue de GitHub (en GitLab, una incidencia). Todo issue lleva etiqueta de
// TIPO: se reutiliza la nativa equivalente (bug, enhancement...) o se crea 'faro:<tipo>'.
// El RESUMEN se cachea en el almacen del harness y lo refresca un proceso en SEGUNDO PLANO: la sesion
// lo lee sin pagar llamadas. GitHub no tiene tiempo ni horas, asi que aqui no hay nada de eso.
'use strict';

module.exports = function (g) {
  const { ROOT, ghApi, ghRepo, git, faroSchema, specBase, ensureUser, cachedUser, collaborators, CRED, ghHost, ghToken, readCfg, writeCfg, labelsCatalogo, resolverLabel, fases, hitos, buscarHito, crearHito, tituloFase, planificacion = null } = g;

  // CICLO de un tipo (schema, determinista): 'plan' = pertenece a una fase (--hito OBLIGATORIA),
  // 'surge' = nace fuera del plan (sin --hito se propone la fase ACTIVA), 'entrada' = llega de fuera sin decidir (reporte:
  // va SIN hito, a la bandeja de entrada, hasta el triaje), 'cierre' = duplicado/descartado (no aplica).
  // Ver faro-schema.json > enums._nota_labels. Sin 'ciclo' en el label, se trata como 'surge' (no
  // bloquea) — mas seguro que exigir fase por un dato que podria faltar en un schema custom viejo.
  const cicloDe = (def) => (def && def.ciclo) || 'surge';

  // TIPO DE GITHUB (#196): el campo Type del issue (tipos de la ORGANIZACION), ademas de la etiqueta.
  // bug -> Bug; requerimiento y mejora -> Feature; el resto -> Task. OBLIGATORIO para TODO issue
  // (#213): tambien reporte, duplicado y descartado (Task), para que el filtro por tipo no tenga huecos.
  const TIPO_FORJA = { bug: 'Bug', requerimiento: 'Feature', mejora: 'Feature' };
  const _tiposOrg = new Map();
  /** Nombre del tipo de GitHub para el slug, si la organizacion lo tiene. -> {tipo} | {sinTipos}. */
  async function tipoForja(org, slug) {
    const quiero = TIPO_FORJA[slug] || 'Task';
    if (!_tiposOrg.has(org)) {
      const r = await ghApi(`orgs/${org}/issue-types`);
      _tiposOrg.set(org, r.ok && Array.isArray(r.body) ? r.body.map((t) => String(t.name)) : null);
    }
    const lista = _tiposOrg.get(org);
    if (!lista || !lista.length) return { sinTipos: true };
    const nombre = lista.find((n) => n.toLowerCase() === quiero.toLowerCase());
    return nombre ? { tipo: nombre } : { sinTipos: true };
  }

  // CAMPOS DE ISSUE de la organizacion (#215): Target date, Priority... Logica en lib/campos-issue.js.
  const CI = require('./campos-issue.js');
  const FH = require('./flag-hito.js');
  // Reglas de hito compartidas con GitLab (#254).
  const HD = require('./hito-destino.js');
  const { hitoPorTitulo, noExiste } = HD;
  const campos = CI.crear(ghApi);

  async function cmdAsignarTarea() {
    // Parseo tolerante: --tipo <slug> puede ir en cualquier posicion; el resto son posicionales.
    // Los campos (--campo "Nombre=valor", --fecha-objetivo...) se sacan primero.
    const pc = CI.parsearArgs(process.argv.slice(3));
    if (pc.error) { console.log(pc.error); process.exit(1); }
    // --hito (#217; --hito queda como alias con aviso) tambien se saca antes.
    const ph = FH.extraer(pc.resto);
    if (ph.alias) console.log(FH.AVISO_ALIAS);
    const raw = ph.resto;
    let tipo = null;
    let faseArg = ph.valor;
    let origenFaseArg = null;
    let appArg = null;    // --app (#211): lista; acumulable y con comas (a,b)
    let repoArg = null;   // --repo <org/repo> (#150): abrir el issue en OTRO repo de la misma organizacion
    const extras = [];
    const subtareas = [];
    const argv = [];
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '--tipo' || raw[i] === '--label') { tipo = (raw[i + 1] || '').toLowerCase(); i++; continue; }
      const mEq = raw[i].match(/^--(?:tipo|label)=(.+)$/); if (mEq) { tipo = mEq[1].toLowerCase(); continue; }
      if (raw[i] === '--extra') { (raw[i + 1] || '').toLowerCase().split(',').forEach((x) => x.trim() && extras.push(x.trim())); i++; continue; }
      // --subtarea, acumulable: la ESTRUCTURA del issue amplio. Van como checkboxes en su cuerpo,
      // no como issues hermanos (ver lib/ciclo.js).
      if (raw[i] === '--subtarea') { const s = (raw[i + 1] || '').trim(); if (s) subtareas.push(s); i++; continue; }
      const mSub = raw[i].match(/^--subtarea=(.+)$/); if (mSub) { subtareas.push(mSub[1].trim()); continue; }
      const mX = raw[i].match(/^--extra=(.+)$/); if (mX) { mX[1].toLowerCase().split(',').forEach((x) => x.trim() && extras.push(x.trim())); continue; }
      // --origen-fase: DOCUMENTA de que fase viene un hallazgo (p.ej. un bug de la Fase 1 que aparece
      // trabajando en la Fase 3), SIN anclar el issue a ella — una fase ya cerrada no se vuelve a
      // revisar, asi que colgarlo ahi lo dejaria tan invisible como no ponerle fase. Es independiente
      // de --hito (donde SE ATIENDE): pueden coincidir, pero casi nunca es lo mismo.
      if (raw[i] === '--origen-fase') { origenFaseArg = raw[i + 1] || ''; i++; continue; }
      const mO = raw[i].match(/^--origen-fase=(.+)$/); if (mO) { origenFaseArg = mO[1]; continue; }
      // --app <id> (#134): en un monorepo, a que app pertenece el issue -> etiqueta 'app:<id>'.
      if (raw[i] === '--app') { (appArg = appArg || []).push((raw[i + 1] || '').trim()); i++; continue; }
      const mA = raw[i].match(/^--app=(.+)$/); if (mA) { (appArg = appArg || []).push(mA[1].trim()); continue; }
      if (raw[i] === '--repo') { repoArg = (raw[i + 1] || '').trim(); i++; continue; }
      const mR = raw[i].match(/^--repo=(.*)$/); if (mR) { repoArg = mR[1].trim(); continue; }
      argv.push(raw[i]);
    }
    const titulo = argv[0], quien = (argv[1] || '').replace(/^@/, ''), slug = argv[2] || '', cuerpo = argv[3] || '';
    const cat = labelsCatalogo();
    const esTransversal = (l) => l && l.transversal === true;
    const tipos = cat.filter((l) => !esTransversal(l));
    const transv = cat.filter(esTransversal);
    const tiposMsg = tipos.length ? tipos.map((l) => `${l.slug} (${l.descripcion})`).join('\n     · ') : '(faro-schema.json sin enums.labels)';
    const extrasMsg = transv.length ? transv.map((l) => l.slug).join(' · ') : '(ninguno)';
    const uso = `Uso: node .claude/hooks/harness.js asignar-tarea "<titulo>" <login> [<slug-del-change>] ["<cuerpo>"] --tipo <tipo> [--hito <N|backlog|titulo>] [--origen-fase <N>] [--extra <slug[,slug]>] [--app <app[,app]>] [--repo <org/repo>]\n   --repo <org/repo>: abre el issue en OTRO repo de la MISMA organizacion (el agente nunca edita un repo ajeno: pide el cambio asi). Sin hito de esta sesion; otra organizacion se rechaza.\n   El --tipo es OBLIGATORIO (todo issue lleva un label). Elige el que mejor encaje:\n     · ${tiposMsg}\n   --hito <N|backlog|titulo>: OBLIGATORIO en un tipo de PLAN (ancla el issue a su hito, donde SE ATIENDE: la fase N de ESTADO.md, el Backlog o el titulo de un hito que ya exista, p.ej. un sprint; un hito no siempre es una fase); si el tipo SURGE fuera del plan (bug/infra/pregunta) se propone la fase ACTIVA: todo issue cuelga de un hito. Un 'reporte' va al Backlog hasta el triaje.\n   --origen-fase <N>: documenta de que fase VIENE un hallazgo (p.ej. un bug de la Fase 1 encontrado en la Fase 3) SIN anclarlo a ella — una fase ya cerrada no se vuelve a revisar. Independiente de --hito.\n   --extra (opcional, acumulable) para dimensiones transversales: ${extrasMsg}
   --app <app[,app]> (monorepo, acumulable): una etiqueta 'app:<app>' por cada app a la que afecta el issue (decide sus gates y revisores). Valida que cada app existe.
   En el MOTOR (sin ESTADO.md) el issue se ancla solo al hito de la version en curso; --hito X.Y fuerza otro hito de version.
   CAMPOS DE ISSUE de la organizacion (opcionales, acumulables): --campo "Nombre=valor" para cualquiera, o los atajos
   --fecha-objetivo AAAA-MM-DD · --inicio AAAA-MM-DD · --prioridad <opcion> · --esfuerzo <opcion>. Se validan ANTES de crear.
   Sin --fecha-objetivo, el issue HEREDA la fecha de su hito (sea fase, version o el que sea) si la tiene. Lista: harness.js campos-tarea.

   GRANULARIDAD — un issue es un ENTREGABLE DE VALOR, no un paso suelto. NO ATOMICES.
   Un issue agrupa todo lo que hace falta para entregar algo con sentido propio y sus subtareas van
   DENTRO (checkboxes del cuerpo, o del tasks.md del cambio), no como issues hermanos:
     SI  -> "Personalizacion e identidad del portal" (marca, colores, traducciones, favicon...)
     NO  -> "Renombrar la marca" + "Traducir subtitle" + "Poner el favicon" como 3 issues
   Regla practica: si se hace en un rato y no entrega valor por si solo, es SUBTAREA. Si necesita su
   propia rama y su PR para tener sentido, es ISSUE. Ante la duda, agrupa: un issue amplio se amplia
   despues; tres issues atomizados ya han ensuciado el hito y generado ramas que nadie cierra.
   Si el trabajo nuevo encaja en un issue ABIERTO, AMPLIA ese (anade la subtarea a su cuerpo) en vez
   de crear otro — sobre todo cuando solo cambia quien lo hace.
   --subtarea "<texto>" (acumulable) es justo eso: la estructura DENTRO del issue amplio. Van como
   checkboxes en su cuerpo y se marcan segun avanza el trabajo, sin rama ni issue propios.
     asignar-tarea "Personalizacion e identidad" fer --tipo tarea --hito 1 \\
       --subtarea "Marca y colores" --subtarea "Traducciones es/en/pt-BR" --subtarea "Favicon"`;
    if (!titulo || !quien) { console.log(uso); process.exit(1); }
    // LABEL OBLIGATORIO: sin --tipo (o con un tipo invalido) NO se crea el issue. Si dudas, el agente
    // debe preguntar al usuario (AskUserQuestion) y reintentar con el tipo elegido.
    if (!tipo) { console.log(`FALTA --tipo: todo issue DEBE llevar un label.\n${uso}`); process.exit(1); }
    // --repo (#150): se valida ANTES de tocar nada. Si es el propio repo de la sesion no cambia nada.
    let ajeno = null;
    if (repoArg !== null) {
      const pr = require('./alcance.js').parsearRepoArg(repoArg, ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd());
      if (pr.error) { console.log(pr.error); process.exit(1); }
      if (!pr.esSesion) ajeno = { org: pr.org, repo: pr.repo };
    }
    // Un transversal (urgente, riesgo...) NO describe QUE trabajo es: no vale como tipo, va en --extra.
    if (cat.some((l) => l.slug === tipo && esTransversal(l))) { console.log(`'${tipo}' es una dimension TRANSVERSAL, no un tipo de trabajo: acompana al tipo, no lo sustituye.\n   Reejecuta con el tipo real y anade --extra ${tipo}. Ej: --tipo bug --extra ${tipo}\n   Tipos validos:\n     · ${tiposMsg}`); process.exit(1); }
    if (cat.length && !tipos.some((l) => l.slug === tipo)) { console.log(`Tipo '${tipo}' no esta en el catalogo. Tipos validos:\n     · ${tiposMsg}`); process.exit(1); }
    const extraDefs = [];
    for (const x of extras) {
      const d = cat.find((l) => l.slug === x);
      if (!d) { console.log(`--extra '${x}' no esta en el catalogo. Transversales validos: ${extrasMsg}`); process.exit(1); }
      if (!esTransversal(d)) { console.log(`--extra '${x}' es un TIPO de trabajo, no una dimension transversal. Un issue lleva UN solo tipo (--tipo). Transversales validos: ${extrasMsg}`); process.exit(1); }
      extraDefs.push(d);
    }
    // APP (#134): se valida ANTES de crear nada. En un monorepo sin --app solo se avisa, proponiendola.
    const af = require('./apps-forja.js');
    const raiz = ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const esquema = faroSchema ? faroSchema() : undefined;
    let appDefs = [];
    if (ajeno) {
      if (appArg !== null) { console.log('--app es una app de ESTE monorepo: no se combina con --repo.'); process.exit(1); }
    } else if (appArg !== null) {
      const v = af.validarApps(raiz, appArg, { schema: esquema });
      if (v.error) { console.log(v.error); process.exit(1); }
      appDefs = v.apps;
    } else if (require('./apps.js').esMonorepo(raiz)) {
      const tocados = [];
      try {
        for (const l of String(git('status', '--porcelain') || '').split(/\r?\n/)) { const f = l.slice(3).trim().replace(/^.* -> /, ''); if (f) tocados.push(f); }
        for (const f of String(git('diff', '--name-only', 'develop...HEAD') || '').split(/\r?\n/)) if (f.trim()) tocados.push(f.trim());
      } catch { /* sin git: se propone la lista */ }
      const av = af.avisoSinApp(raiz, tocados, { schema: esquema });
      if (av) console.log(av);
    }
    // CAMPOS (#215): se validan contra los de la organizacion ANTES de crear nada (ni hito ni label).
    let camposValores = [];
    let defsCampos = null;
    const Rc = ajeno || ghRepo();
    if (Rc) defsCampos = await campos.defsOrg(Rc.org);
    if (pc.pedidos.length) {
      if (!defsCampos || !defsCampos.length) { console.log(`La organizacion ${Rc ? Rc.org : '(sin repo)'} no tiene campos de issue: quita --campo/--fecha-objetivo/... o definelos en la organizacion de GitHub.`); process.exit(1); }
      const rc = CI.resolver(defsCampos, pc.pedidos);
      if (rc.error) { console.log(rc.error); process.exit(1); }
      camposValores = rc.valores;
    }
    const hv = require('./hito-version.js');
    const esMotor = hv.esMotor(raiz);
    // ANCLAJE AL CICLO (determinista, leido del schema): un tipo de PLAN no puede nacer sin fase, o
    // se pierde de vista en cuanto se cierra el ciclo que la contenia — el backlog zombi. Un tipo que
    // SURGE (bug/infra/pregunta) no estaba planificado, pero TAMBIEN cuelga de un hito: sin --hito se
    // propone la fase ACTIVA, que es donde aparecio.
    // Sin ESTADO.md (repo nivel 0, sin faseo) no hay fases que exigir: no se bloquea.
    const def0 = tipos.find((l) => l.slug === tipo);
    const ciclo = cicloDe(def0);
    const listaFases = (fases ? fases() : []) || [];
    let hitoNumero;
    // 'entrada' (reporte): llega de fuera y nadie ha decidido nada — va SIN hito, a la bandeja de entrada
    // (#84). El hito es la fase, y decidirla es el triaje: no se le pone ni el Backlog.
    const esBacklog = faseArg && faseArg.toLowerCase() === 'backlog';
    if (ajeno) {
      // REPO AJENO: el hito de la sesion no aplica. Solo se usa si el otro repo tiene uno con ese nombre.
      if (faseArg) {
        const cand = [faseArg];
        const fx = listaFases.find((x) => x.num === Number(faseArg));
        if (fx && tituloFase) cand.push(tituloFase(fx));
        const rm = await ghApi(`repos/${ajeno.org}/${ajeno.repo}/milestones?state=open&per_page=100`);
        const m = (rm.ok && Array.isArray(rm.body) ? rm.body : []).find((x) => cand.some((c) => String(x.title).toLowerCase() === String(c).toLowerCase()));
        if (m) hitoNumero = m.number;
        else console.log(`ⓘ ${ajeno.org}/${ajeno.repo} no tiene un hito '${faseArg}': el issue se abre SIN hito.`);
      }
    } else if (esBacklog) {
      // BACKLOG: un requerimiento real (ya decidido que se hara) pero que aun no se sabe CUANDO —
      // no es lo mismo que "sin fase" (que para un tipo de PLAN queda bloqueado mas abajo). Vive en
      // un hito UNICO 'Backlog', no ligado a ninguna fase de ESTADO.md: visible y contado igual que
      // cualquier otro hito, hasta que se decide su fase de verdad (edita el milestone del issue, o
      // reejecuta asignar-tarea --hito <N> en un fork; no hay comando de "mover" aun).
      if (hitos && buscarHito && crearHito) {
        let m = buscarHito(await hitos('all'), 'Backlog');
        if (!m) { const cr = await crearHito('Backlog', { description: 'Sala de espera: requerimientos ACEPTADOS sin fase asignada todavia, y reportes que llegan de fuera (label "reporte") que aun NADIE ha decidido — los juzga /faro:triaje. No ligado a ninguna fase de ESTADO.md.' }); if (cr.error) { console.log(`No pude crear el hito Backlog (HTTP ${cr.error.status}).`); return; } m = cr.hito; }
        hitoNumero = m.number;
      }
    } else if (faseArg && esMotor && hv.RE_VERSION.test(faseArg) && !listaFases.length) {
      // MOTOR: '--hito 1.0' = el hito de esa version (lo crea si falta).
      if (hitos && buscarHito && crearHito) {
        let m = buscarHito(await hitos('all'), faseArg);
        if (!m) { const cr = await crearHito(faseArg); if (cr.error) { console.log(`No pude crear el hito '${faseArg}' (HTTP ${cr.error.status}).`); return; } m = cr.hito; }
        hitoNumero = m.number;
        console.log(`ⓘ Motor: hito '${m.title}' (indicado con --hito).`);
      }
    } else if (esMotor && !listaFases.length && !faseArg && ciclo !== 'cierre' && ciclo !== 'entrada') {
      // MOTOR (sin ESTADO.md): el hito es la VERSION en curso, no una fase. Criterio en lib/hito-version.js.
      const ver = hv.versionMotor(raiz);
      if (ver && hitos && buscarHito && crearHito) {
        const e = hv.elegirHitoVersion(ver, await hitos('all'));
        if (e) {
          let numero = e.numero;
          if (e.crear) {
            const cr = await crearHito(e.titulo);
            if (cr.error) { console.log(`No pude crear el hito '${e.titulo}' (HTTP ${cr.error.status}).`); return; }
            numero = cr.hito.number;
            if (cr.hito.state === 'closed') console.log(`⚠ El hito '${e.titulo}' existe pero esta CERRADO: el issue cuelga de el igual; reabrelo o pasa --hito <X.Y>.`);
          }
          hitoNumero = numero;
          console.log(`ⓘ Motor: hito '${e.titulo}' — ${e.motivo}. Otro hito: --hito <X.Y>.`);
          if (e.olvidados.length) console.log(`   Hitos abiertos por debajo de la version en curso (¿olvidados?): ${e.olvidados.join(', ')}.`);
        }
      }
    } else if (faseArg) {
      const fnum = Number(faseArg);
      const f = listaFases.find((x) => x.num === fnum);
      const literal = !f && hitos ? hitoPorTitulo(await hitos('all'), faseArg) : null;
      if (!f && !literal) { console.log(noExiste(faseArg, listaFases)); process.exit(1); }
      if (literal) hitoNumero = literal.number;
      else if (hitos && buscarHito && crearHito && tituloFase) {
        const titulo = tituloFase(f);
        let m = buscarHito(await hitos('all'), titulo);
        if (!m) { const cr = await crearHito(titulo); if (cr.error) { console.log(`No pude crear el hito de la Fase ${f.num} (HTTP ${cr.error.status}).`); return; } m = cr.hito; }
        hitoNumero = m.number;
      }
    } else if (ciclo !== 'cierre' && ciclo !== 'entrada' && listaFases.length) {
      // REGLA DURA: TODO issue cuelga de un hito, tambien los que SURGEN (bug/infra/pregunta). Un
      // bug sin hito no cuenta en ninguna fase, no sale en los informes y nadie lo mira al cerrar el
      // ciclo. Lo que cambia segun el ciclo no es SI lleva fase, sino CUAL se propone: un tipo de
      // PLAN se decide; uno que SURGE va a la fase ACTIVA, que es donde aparecio.
      // (Solo se exige si HAY faseo: un repo nivel 0, sin ESTADO.md, no puede cumplirlo.)
      const activa = listaFases.find((x) => x.estado === 'in_progress' || x.estado === 'testing');
      const sugerida = ciclo === 'surge' && activa ? activa.num : null;
      const porQue = ciclo === 'surge'
        ? `'${tipo}' aparece mientras se trabaja${activa ? `, asi que va a la fase ACTIVA (Fase ${activa.num} · ${activa.nombre})` : ''}`
        : `'${tipo}' es trabajo PLANIFICADO: decide en que fase entra`;
      console.log(`FALTA --hito: TODO issue cuelga de un hito — sin el no cuenta en ninguna fase ni sale en los informes.\n   ${porQue}.\n   Fases disponibles:\n${listaFases.map((x) => `  · Fase ${x.num} · ${x.nombre}${x === activa ? '   <- activa' : ''}`).join('\n')}\n   · backlog (aceptado, pero aun sin decidir CUANDO)\n   Reejecuta con --hito ${sugerida ? sugerida : '<N|backlog>'}.`);
      process.exit(1);
    }
    const R = ajeno || ghRepo();
    if (!R) { console.log('No detecto el repo remoto (origin).'); return; }
    let existe, equipoMsg;
    if (ajeno) {
      // Asignable en ESE repo (204), no en el de la sesion.
      const ra = await ghApi(`repos/${R.org}/${R.repo}/assignees/${encodeURIComponent(quien)}`);
      if (ra.sinToken) { console.log('SIN_TOKEN: conectate con  node .claude/hooks/harness.js auth.'); return; }
      existe = ra.ok; equipoMsg = `${R.org}/${R.repo}`;
    } else {
      const cs = await collaborators();
      existe = cs.some((c) => c.login.toLowerCase() === quien.toLowerCase());
      equipoMsg = `la repo (${cs.map((c) => c.login).join(', ') || 'vacio'})`;
    }
    if (!existe) { console.log(`⚠ '${quien}' NO esta en el equipo de ${equipoMsg}. Revisa el login o añadelo en GitHub. NO asigno.`); return; }
    // 'ctx' no existe en este submodulo: specBase llega ya inyectado desde github.js (y redeclararlo
    // con el mismo nombre hacia shadowing del const de arriba).
    const base = specBase || 'gestion/cambios';
    const origenLine = origenFaseArg && !ajeno ? `\n\nOrigen: Fase ${origenFaseArg} (hallado despues, no se reabre esa fase para esto).` : '';
    // En un repo AJENO el cuerpo no cita rutas internas de esta sesion (gestion/cambios/...): alli no significan nada.
    const slugCuerpo = ajeno ? '' : slug;
    const cuerpoBase = (slugCuerpo ? `${cuerpo}\n\nCambio spec-driven: \`${base}/changes/${slugCuerpo}/\`.`.trim() : cuerpo) + origenLine;
    // Las subtareas viven DENTRO del issue amplio, no como issues hermanos.
    const cl = require('./ciclo.js');
    let cuerpoFull = cl.subtareasEnCuerpo(cuerpoBase, subtareas);
    // ESTRUCTURA: una tarea la puede coger una persona o un AGENTE, y un agente no pregunta — lee lo
    // que hay y supone el resto. Si el cuerpo no es autocontenido se avisa (no se bloquea: a veces se
    // crea la tarea primero y se detalla despues) y se da la plantilla de su tipo para rellenarla.
    // El TITULO dice QUE ENTREGA (general); el detalle de QUE HACER va dentro. Un titulo que es un
    // paso suelto delata que se ha troceado de mas: se avisa, no se bloquea.
    if (cl.tituloAtomico(titulo, tipo)) {
      console.log(`⚠ '${titulo}' parece un PASO, no un entregable. El titulo debe ser GENERAL ("Personalizacion e identidad") y el detalle ir DENTRO como subtareas.`);
      console.log('   Si es parte de algo mayor, AMPLIA esa tarea (--subtarea) en vez de crear una hermana.');
    }
    // ═══ FORMATO OBLIGATORIO: el issue es DONDE VIVE el trabajo ══════════════
    // En FARO el detalle —contexto, alcance, subtareas, criterios— vive en el ISSUE;
    // ESTADO.md solo lleva el checkbox de una linea. Un issue sin estructura deja el
    // trabajo sin definir en el UNICO sitio donde deberia estar definido, y quien lo
    // coja (persona o AGENTE) rellena los huecos suponiendo — un agente no pregunta.
    //
    // Antes esto solo AVISABA y creaba el issue igual: por eso hay issues vivos con
    // dos lineas y nadie volvio a completarlos. Ahora es RIGIDO.
    const huecos = cl.huecosDeIssue(cuerpoFull, tipo);
    if (huecos.length) {
      // NINGUN issue nace sin estructura. Da igual si no se paso cuerpo o si se paso
      // uno breve: en los dos casos falta lo mismo, asi que se trata igual — el issue
      // se crea CON la plantilla de su tipo puesta, y lo que se hubiera escrito se
      // CONSERVA dentro (bajo 'Contexto', que es lo que suele ser).
      //
      // No se bloquea la creacion a proposito: obligar a redactar 5 secciones antes de
      // poder anotar un bug que acaba de aparecer haria que la gente deje de usar el
      // comando. Lo que se garantiza es que el issue nunca aparente estar completo con
      // dos lineas: los marcadores <...> dicen a la cara lo que falta.
      const previo = String(cuerpo || '').trim();
      let base0 = cl.plantillaIssue(tipo);
      if (previo) {
        base0 = base0.replace(/^(## Contexto\n\n)(.*)$/m, (_m, cab) => cab + previo);
        if (!base0.includes(previo)) base0 += `\n\n## Notas previas\n\n${previo}\n`;
      }
      cuerpoFull = cl.subtareasEnCuerpo(base0 + (slugCuerpo ? `\n\nCambio spec-driven: \`${base}/changes/${slugCuerpo}/\`.` : '') + origenLine, subtareas);
      console.log(`ⓘ El cuerpo no era autocontenido (${huecos.join(' · ')}): la tarea se crea CON la plantilla de '${tipo}' puesta${previo ? ' y lo que escribiste dentro' : ''}.`);
      console.log('   COMPLETA los marcadores <...> en la forja antes de que nadie la empiece: el issue es donde vive el detalle del trabajo, y quien lo coja (persona o AGENTE) rellenara los huecos suponiendo.');
    }
    // Resuelve el label (hibrido) y lo adjunta. Si no se pudo crear/resolver, NO se crea el issue (label obligatorio).
    const def = tipos.find((l) => l.slug === tipo);
    // REPO AJENO: nunca se crean labels alli (seria escribir en un repo que no es el de la sesion). Solo se
    // usan los que YA existen (el nativo o faro:<tipo>); si no hay ninguno el issue se abre sin label.
    let existentesAjeno = null;
    if (ajeno) {
      existentesAjeno = new Map();
      for (let pagina = 1; pagina <= 5; pagina++) {
        const rl = await ghApi(`repos/${R.org}/${R.repo}/labels?per_page=100&page=${pagina}`);
        if (!rl.ok || !Array.isArray(rl.body) || !rl.body.length) break;
        for (const l of rl.body) existentesAjeno.set(String(l.name).toLowerCase(), String(l.name));
        if (rl.body.length < 100) break;
      }
    }
    const resolverAjeno = (d) => (d && [d.github, `faro:${String(d.slug).toLowerCase()}`].filter(Boolean).map((n) => existentesAjeno.get(String(n).toLowerCase())).find(Boolean)) || null;
    const labelAplicar = ajeno ? resolverAjeno(def) : await resolverLabel(R.org, R.repo, def);
    if (ajeno && !labelAplicar) console.log(`ⓘ ${R.org}/${R.repo} no tiene un label para '${tipo}': el issue se abre sin label (no se crean labels en repos ajenos).`);
    if (!ajeno && !labelAplicar) { console.log(`No pude crear/resolver el label para '${tipo}' en ${R.org}/${R.repo} (¿permiso de labels?). El issue NO se crea sin label.`); return; }
    // Los transversales son OPCIONALES: si alguno no se puede resolver, se avisa pero el issue SI se crea
    // (el label obligatorio -el tipo- ya esta garantizado arriba).
    const labels = labelAplicar ? [labelAplicar] : [];
    for (const d of extraDefs) {
      const n = ajeno ? resolverAjeno(d) : await resolverLabel(R.org, R.repo, d);
      if (n && !labels.includes(n)) labels.push(n);
      else if (!n) console.log(`⚠ No pude resolver el label transversal '${d.slug}'; sigo sin el.`);
    }
    for (const appDef of appDefs) {
      const n = await af.asegurarEtiquetaGithub(ghApi, R.org, R.repo, appDef.id, appDef.rol ? `App ${appDef.id}: ${appDef.rol}`.slice(0, 100) : null);
      if (n) labels.push(n);
      else console.log(`⚠ No pude crear/resolver la etiqueta 'app:${appDef.id}' (¿permiso de labels?); el issue se crea sin ella.`);
    }
    const body = { title: titulo, body: cuerpoFull, assignees: [quien], labels };
    if (hitoNumero != null) body.milestone = hitoNumero;
    // Tambien en un repo ajeno (#213): el control de alcance lo limita a la misma organizacion.
    const tf = await tipoForja(R.org, tipo);
    if (tf.tipo) body.type = tf.tipo;
    else if (tf.sinTipos) console.log(`ⓘ La organizacion ${R.org} no tiene tipos de issue (Bug/Feature/Task): el issue lleva solo la etiqueta '${tipo}'.`);
    // El POST a un repo ajeno pasa por el MISMO control de alcance que `harness.js gh` (solo crear issues, misma org).
    if (ajeno) {
      let motivo;
      try {
        const AL = require('./alcance.js');
        motivo = AL.evaluarGh(`repos/${R.org}/${R.repo}/issues`, 'POST', ghRepo(), { permitidos: AL.leerAlcance(raiz).repos_permitidos, cuerpo: JSON.stringify(body) });
      } catch (e) { motivo = `error interno del control de alcance (${(e && e.message) || e})`; }
      if (motivo) { console.log(`BLOQUEADO: ${motivo}.`); process.exit(2); }
    }
    // FECHA OBJETIVO heredada del HITO (#215), sea fase, version o cualquier otro: solo si no se dio a mano.
    let heredada = null;
    const defFecha = defsCampos && defsCampos.length ? CI.defDeAlias(defsCampos, 'fecha-objetivo') : null;
    if (defFecha && hitoNumero != null && !camposValores.some((v) => v.field_id === defFecha.id)) {
      const f = await campos.fechaHitoNumero(R.org, R.repo, hitoNumero);
      if (f) { heredada = f; camposValores.push({ field_id: defFecha.id, value: f, nombre: defFecha.name }); }
    }
    const r = await ghApi(`repos/${R.org}/${R.repo}/issues`, { method: 'POST', body });
    if (r.sinToken) { console.log('SIN_TOKEN: conectate con  node .claude/hooks/harness.js auth.'); return; }
    const j = r.body || {};
    if (!(r.ok && j.number)) { console.log(`No pude crear la tarea (HTTP ${r.status})${j.message ? `: ${j.message}` : ''}.`); return; }
    console.log(`✅ Tarea #${j.number} asignada a ${quien} · tipo: ${tipo}${extraDefs.length ? ` · ${extraDefs.map((d) => d.slug).join(', ')}` : ''}${appDefs.length ? ` · ${appDefs.map((x) => `app:${x.id}`).join(', ')}` : ''} — ${j.html_url}\n   Le llega un email de aviso ("se te ha asignado una tarea"). (En GitHub, una Tarea es un "Issue".)`);
    const epica = planificacion ? planificacion.lineaEpica(j.milestone) : '';
    if (epica) console.log(`   ${epica}`);
    // Los valores de los campos se escriben DESPUES de crear el issue (la API no los admite en el POST).
    if (camposValores.length) {
      const rv = await campos.escribir(R.org, R.repo, j.number, camposValores);
      const txt = camposValores.map((v) => `${v.nombre} = ${Array.isArray(v.value) ? v.value.join(', ') : v.value}${heredada && v.field_id === defFecha.id ? ' (la del hito)' : ''}`).join(' · ');
      if (rv.ok) console.log(`   Campos: ${txt}.`);
      else console.log(`   ⚠ El issue se creo pero no pude fijar los campos (HTTP ${rv.status}): ${txt}. Reintenta con  harness.js campos-tarea ${j.number} --campo "Nombre=valor".`);
    }
    if (ajeno) console.log(`   Abierto en ${R.org}/${R.repo} (repo ajeno a esta sesion): el seguimiento lo lleva su equipo; aqui no se crea rama ni cambio.`);
    else console.log(`   Trabajala con: harness.js rama <tipo> "<tema>" --issue ${j.number}  ->  harness.js terminar (abre la peticion con "Closes #${j.number}": la Tarea se cierra sola al integrarse).`);
    // LIGADURA cambio <-> tarea: si esta tarea ejecuta un cambio spec-driven, se anota en su
    // proposal.md. Sin esto los dos mundos quedan sueltos y se puede archivar un cambio cuya tarea
    // sigue abierta. Es anotacion, no gate: si el fichero no esta o no se puede escribir, se avisa.
    if (slug && !ajeno) {
      try {
        const prop = require('path').join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), base, 'changes', slug, 'proposal.md');
        const fs = require('fs');
        const txt = fs.readFileSync(prop, 'utf8');
        if (!/^issue:\s*\d+\s*$/m.test(txt) && /^---\r?\n/.test(txt)) {
          const i = txt.indexOf('\n---', 4);
          if (i > 0) {
            fs.writeFileSync(prop, `${txt.slice(0, i)}\nissue: ${j.number}${txt.slice(i)}`);
            console.log(`   Anotada en el cambio '${slug}' (issue: ${j.number} en su proposal.md): quedan ligados.`);
          }
        }
      } catch { console.log(`   ⚠ No pude anotar 'issue: ${j.number}' en el cambio '${slug}': hazlo a mano en su proposal.md para ligarlos.`); }
    }
    invalidarResumen(); // refresco: tu propio cambio se ve YA (no esperar al TTL)
  }

  // cmdDescartarTarea: cierra un issue como DESCARTADO (state_reason: not_planned) — para propuestas
  // que el admin NO aprueba. Distinto de "completado". Uso: harness.js descartar-tarea <numero> ["<motivo>"]
  async function cmdDescartarTarea() {
    const num = process.argv[3], motivo = process.argv[4] || '';
    if (!num) { console.log('Uso: node .claude/hooks/harness.js descartar-tarea <numero-issue> ["<motivo>"]'); process.exit(1); }
    const R = ghRepo();
    if (!R) { console.log('No detecto el repo remoto (origin).'); return; }
    if (motivo) await ghApi(`repos/${R.org}/${R.repo}/issues/${num}/comments`, { method: 'POST', body: { body: `Descartado: ${motivo}` } });
    const r = await ghApi(`repos/${R.org}/${R.repo}/issues/${num}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'not_planned' } });
    if (r.sinToken) { console.log('SIN_TOKEN: conectate con  node .claude/hooks/harness.js auth.'); return; }
    console.log(r.ok ? `✅ Tarea #${num} descartada (no se hará)${motivo ? ` — ${motivo}` : ''}.` : `No pude descartar la tarea #${num} (HTTP ${r.status}).`);
    if (r.ok) invalidarResumen();
  }

  // --- BACKLOG y movimiento entre fases ---
  // El Backlog es la SALA DE ESPERA: ahi aterriza lo ya aceptado pero sin decidir CUANDO se hace.
  // Regla dura: del Backlog solo se SALE a una fase. Una tarea no se completa estando en espera —
  // si se hizo, es que pertenecia a alguna fase. (Descartarla si vale: es "no se hara", no "hecha".)
  const NOMBRE_BACKLOG = 'Backlog';

  // Resuelve el hito destino: un numero de fase de ESTADO.md, o 'backlog'. Devuelve {numero,titulo}
  // o null con el motivo ya impreso.
  const hitoDestino = HD.crear({ hitos, buscarHito, crearHito, fases, tituloFase, idDe: (m) => m.number });

  const tipoActual = (issue) => (issue && issue.type && issue.type.name) || null;
  const enBacklog = (issue) => !!(issue && issue.milestone && String(issue.milestone.title).toLowerCase() === NOMBRE_BACKLOG.toLowerCase());

  // cmdMoverTarea: cambia la fase (hito) de una tarea. Mover trabajo entre fases es un CAMBIO DE
  // ALCANCE, no un ajuste silencioso: SIEMPRE deja constancia en el issue de donde venia y a donde va.
  // Uso: harness.js mover-tarea <numero> --hito <N|backlog> ["<motivo>"]
  //      harness.js mover-tarea --listar backlog
  async function cmdMoverTarea() {
    const raw = process.argv.slice(3);
    const ph = FH.extraer(raw);
    if (ph.alias) console.log(FH.AVISO_ALIAS);
    let faseArg = ph.valor, listar = null;
    const argv = [];
    for (let i = 0; i < ph.resto.length; i++) {
      const a = ph.resto[i];
      if (a === '--listar') { listar = ph.resto[i + 1] || 'backlog'; i++; continue; }
      const mL = a.match(/^--listar=(.+)$/); if (mL) { listar = mL[1]; continue; }
      argv.push(a);
    }
    const uso = 'Uso: node .claude/hooks/harness.js mover-tarea <numero> --hito <N|backlog> ["<motivo>"]\n     node .claude/hooks/harness.js mover-tarea --listar backlog   (que espera sin fase)';
    const R = ghRepo();
    if (!R) { console.log('No detecto el repo remoto (origin).'); return; }

    if (listar) {
      const destino = await hitoDestino(listar);
      if (!destino) return;
      const r = await ghApi(`repos/${R.org}/${R.repo}/issues?milestone=${destino.numero}&state=open&per_page=100`);
      if (r.sinToken) { console.log('SIN_TOKEN: conectate con  node .claude/hooks/harness.js auth.'); return; }
      const items = (r.ok && Array.isArray(r.body)) ? r.body.filter((i) => !i.pull_request) : [];
      if (!items.length) { console.log(`'${destino.titulo}' esta vacio: no hay nada esperando.`); return; }
      console.log(`'${destino.titulo}' — ${items.length} tarea(s) esperando fase:`);
      for (const i of items) {
        const dias = Math.round((Date.now() - new Date(i.updated_at)) / 86400000);
        const tipos = (i.labels || []).map((l) => l.name).join(', ');
        console.log(`  #${i.number} ${i.title}${tipos ? ` [${tipos}]` : ''} · sin tocar hace ${dias}d`);
      }
      console.log('Saca una a su fase con:  harness.js mover-tarea <numero> --hito <N> ["<motivo>"]');
      return;
    }

    const num = argv[0], motivo = argv[1] || '';
    if (!num || !faseArg) { console.log(uso); process.exit(1); }
    const actual = await ghApi(`repos/${R.org}/${R.repo}/issues/${num}`);
    if (actual.sinToken) { console.log('SIN_TOKEN: conectate con  node .claude/hooks/harness.js auth.'); return; }
    if (!actual.ok || !actual.body) { console.log(`No pude leer la tarea #${num} (HTTP ${actual.status}).`); return; }
    const origen = actual.body.milestone ? actual.body.milestone.title : '(sin fase)';
    const destino = await hitoDestino(faseArg);
    if (!destino) return;
    if (actual.body.milestone && actual.body.milestone.number === destino.numero) {
      console.log(`La tarea #${num} ya esta en '${destino.titulo}'. Nada que mover.`);
      return;
    }
    // SALIR DEL BACKLOG = entrar al trabajo (#72). El Backlog es la unica sala sin formato; una fase no:
    // la tarea tiene que llegar con la estructura de SU tipo. Un 'reporte' aun no es trabajo — se tria
    // antes (/faro:triaje) y pasa a su tipo real.
    // Lo mismo al salir de la BANDEJA DE ENTRADA (#84, sin hito): es lo que llego de fuera sin triar.
    const cambio = { milestone: destino.numero };
    const cl = require('./ciclo.js');
    const tipo = cl.tipoDeEtiquetas(actual.body.labels, labelsCatalogo());
    if ((!actual.body.milestone || enBacklog(actual.body)) && destino.titulo !== NOMBRE_BACKLOG) {
      const bloqueo = HD.bloqueoAlEntrarEnFase({ num, tipo, cuerpo: actual.body.body, tieneHito: !!actual.body.milestone, destino: destino.titulo, comoCompletar: `Ponle la plantilla:  harness.js reparar-tarea ${num} --confirmo  — rellenala y repite el mover.` });
      if (bloqueo) { console.log(bloqueo.join('\n')); process.exit(1); }
    }
    // Cada movimiento reconcilia el tipo de GitHub con la etiqueta (#196, #213): nunca queda sin tipo.
    const tf = await tipoForja(R.org, tipo || 'tarea');
    if (tf.tipo && tipoActual(actual.body) !== tf.tipo) cambio.type = tf.tipo;
    const r = await ghApi(`repos/${R.org}/${R.repo}/issues/${num}`, { method: 'PATCH', body: cambio });
    if (!r.ok) { console.log(`No pude mover la tarea #${num} (HTTP ${r.status}).`); return; }
    // La constancia va DESPUES del cambio: si el PATCH falla, no queda un comentario mintiendo.
    await ghApi(`repos/${R.org}/${R.repo}/issues/${num}/comments`, { method: 'POST', body: { body: `Movida de **${origen}** a **${destino.titulo}**.${motivo ? ` Motivo: ${motivo}` : ''}` } });
    console.log(`✅ Tarea #${num} movida de '${origen}' a '${destino.titulo}'${motivo ? ` — ${motivo}` : ''}.`);
    const epica = planificacion ? planificacion.lineaEpica(r.body && r.body.milestone) : '';
    if (epica) console.log(`   ${epica}`);
    // La fecha objetivo HEREDADA del hito sigue al hito nuevo; una puesta a mano no se toca (#215).
    const lineaFecha = await campos.seguirHito(R.org, R.repo, num, actual.body.milestone, destino.numero);
    if (lineaFecha) console.log(lineaFecha);
    invalidarResumen();
  }

  // cmdCerrarTarea: cierra una tarea como COMPLETADA. Guarda dura: lo que sigue en el Backlog NO se
  // puede dar por hecho — del Backlog solo se sale a una fase. Uso: harness.js cerrar-tarea <numero>
  async function cmdCerrarTarea() {
    const num = process.argv[3];
    if (!num) { console.log('Uso: node .claude/hooks/harness.js cerrar-tarea <numero-issue>'); process.exit(1); }
    const R = ghRepo();
    if (!R) { console.log('No detecto el repo remoto (origin).'); return; }
    const actual = await ghApi(`repos/${R.org}/${R.repo}/issues/${num}`);
    if (actual.sinToken) { console.log('SIN_TOKEN: conectate con  node .claude/hooks/harness.js auth.'); return; }
    if (!actual.ok || !actual.body) { console.log(`No pude leer la tarea #${num} (HTTP ${actual.status}).`); return; }
    if (enBacklog(actual.body)) {
      console.log(`La tarea #${num} sigue en '${NOMBRE_BACKLOG}': una tarea NO se completa desde la sala de espera.`);
      console.log(`   Si se ha hecho, pertenecia a alguna fase: muevela primero —  harness.js mover-tarea ${num} --hito <N>  — y cierrala despues.`);
      console.log(`   Si NO se va a hacer, no es un cierre por completado:  harness.js descartar-tarea ${num} "<motivo>"`);
      process.exit(1);
    }
    const r = await ghApi(`repos/${R.org}/${R.repo}/issues/${num}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
    if (!r.ok) { console.log(`No pude cerrar la tarea #${num} (HTTP ${r.status}).`); return; }
    console.log(`✅ Tarea #${num} cerrada como completada.`);
    invalidarResumen();
  }

  // misTareas: issues de GitHub ASIGNADOS al usuario autenticado en esta repo -> [{number,title,state,url}].
  // Para que cada uno sepa QUE TIENE PENDIENTE sin salir del harness. state='open' por defecto.
  async function misTareas(state = 'open') {
    const R = ghRepo();
    if (!R) return null;
    const meR = await ghApi('user');
    const me = meR.body;
    if (!me || !me.login) return null;
    const r = await ghApi(`repos/${R.org}/${R.repo}/issues?assignee=${me.login}&state=${state}&per_page=50`);
    if (!r.ok || !Array.isArray(r.body)) return null;
    // Excluir PRs (la API de issues los incluye; los PRs traen pull_request). Solo tareas puras.
    return { login: me.login, tareas: r.body.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, state: i.state, url: i.html_url })) };
  }
  // misTareasOrg: lo MISMO pero en TODA la organizacion, no solo en la repo actual. Un issue
  // asignado en otro repo era invisible desde aqui: para saber "que tengo pendiente" hacia falta
  // entrar repo por repo. La API de busqueda lo resuelve en UNA llamada (assignee:@me + org:<ORG>).
  // Devuelve {login, org, tareas:[{repo,number,title,state,url,actualizado}]} o null.
  async function misTareasOrg(state = 'open') {
    const meR = await ghApi('user');
    const me = meR.body;
    if (!me || !me.login) return null;
    // La org sale del remoto; si el repo no tiene remoto, del ~/.faro.json (el CLI la guarda).
    const R = ghRepo();
    const org = (R && R.org) || readCfg().org || null;
    if (!org) return null;
    const q = encodeURIComponent(`assignee:${me.login} org:${org} is:issue${state === 'open' ? ' is:open' : ''}`);
    const r = await ghApi(`search/issues?q=${q}&per_page=50&sort=updated`);
    if (!r.ok || !r.body || !Array.isArray(r.body.items)) return null;
    return {
      login: me.login, org,
      tareas: r.body.items.filter((i) => !i.pull_request).map((i) => ({
        // repository_url = https://api.github.com/repos/<org>/<repo> -> nos quedamos con <repo>
        repo: String(i.repository_url || '').split('/').pop() || '?',
        number: i.number, title: i.title, state: i.state, url: i.html_url, actualizado: i.updated_at,
      })),
    };
  }

  async function cmdMisTareas() {
    if (!ghToken()) { console.log('SIN_TOKEN: conectate con  node .claude/hooks/harness.js auth.'); process.exit(2); }
    const all = process.argv.includes('--all');
    // Por defecto MIRA TODA LA ORG (es lo que la gente espera de "mis tareas"); --repo lo acota
    // a la repo actual (comportamiento anterior, util cuando trabajas en un solo proyecto).
    const soloRepo = process.argv.includes('--repo');
    const verTodas = process.argv.includes('--todas');   // detalle de las de OTRAS repos (por defecto solo el recuento)
    if (!soloRepo) {
      const o = await misTareasOrg(all ? 'all' : 'open');
      if (o) {
        if (!o.tareas.length) { console.log(`No tienes tareas ${all ? '' : 'abiertas '}asignadas en ${o.org} (${o.login}).`); return; }
        // PRIORIDAD AL REPO ACTUAL: es donde el usuario puede actuar YA, sin cambiar de contexto.
        // Lo de otros repos NO se lista entero (ruido, y no es accionable desde aqui): se resume
        // por repo y se indica adonde ir. Asi la respuesta es corta y dice que hacer.
        const aqui = ghRepo();
        const propias = aqui ? o.tareas.filter((t) => t.repo === aqui.repo) : [];
        const otras = aqui ? o.tareas.filter((t) => t.repo !== aqui.repo) : o.tareas;
        if (aqui) {
          if (propias.length) {
            console.log(`Tus tareas en ESTA repo (${aqui.repo}) — ${propias.length}:`);
            for (const t of propias) console.log(`  #${t.number} [${t.state}] ${t.title}  ·  ${t.url}`);
          } else {
            console.log(`No tienes tareas ${all ? '' : 'abiertas '}asignadas en esta repo (${aqui.repo}).`);
          }
        }
        if (otras.length) {
          const porRepo = new Map();
          for (const t of otras) porRepo.set(t.repo, (porRepo.get(t.repo) || 0) + 1);
          if (verTodas) {
            console.log(`\nEn otras repos de ${o.org} — ${otras.length}:`);
            for (const [r] of [...porRepo.entries()].sort((a, b) => b[1] - a[1])) {
              console.log(`  ${r}:`);
              for (const t of otras.filter((t) => t.repo === r)) console.log(`    #${t.number} [${t.state}] ${t.title}  ·  ${t.url}`);
            }
            console.log(`  Trabájalas ABRIENDO esa repo (una sesión por proyecto): el harness gobierna la carpeta en la que estás.`);
          } else {
            const resumen = [...porRepo.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} (${n})`).join(' · ');
            console.log(`\nEn otras repos de ${o.org} tienes ${otras.length} tarea(s): ${resumen}`);
            console.log(`  Para trabajarlas, abre esa repo (una sesión por proyecto). Ver el detalle sin salir de aquí: harness.js mis-tareas --todas`);
          }
        }
        return;
      }
      // Sin org resoluble o busqueda no disponible: se cae a la consulta por repo (no se pierde nada).
    }
    const r = await misTareas(all ? 'all' : 'open');
    if (!r) { console.log('No pude leer tus tareas (¿sin token o repo sin remoto?).'); return; }
    if (!r.tareas.length) { console.log(`No tienes tareas ${all ? '' : 'abiertas '}asignadas en esta repo (${r.login}).`); return; }
    console.log(`Tus tareas asignadas en esta repo (${r.login}) — ${r.tareas.length}:`);
    for (const t of r.tareas) console.log(`  #${t.number} [${t.state}] ${t.title}  ·  ${t.url}`);
  }

  // --- Resumen GitHub CACHEADO (para inyectar en sesion sin latencia) ---
  // Guarda en ~/.faro.json un pequeño snapshot por repo: tareas (Issues) abiertas asignadas a ti,
  // y PRs abiertos que esperan TU revision. Se lee SINCRONO en sesion; se refresca en BACKGROUND si esta caduco.
  const GH_CACHE_MIN = 5; // frescura del cache en minutos (bajo: los cambios de otros aparecen pronto)
  const cacheKey = () => { const R = ghRepo(); return R ? `${R.org}/${R.repo}` : null; };
  // Lectura SINCRONA del cache (no red): -> {mis_tareas, prs_por_revisar, ts} o null.
  function ghResumenCache() {
    const k = cacheKey(); if (!k) return null;
    const cfg = readCfg(); const c = (cfg.gh_resumen || {})[k];
    return c || null;
  }
  // ¿el cache esta fresco? (para decidir si refrescar en background). now se pasa desde el harness (Date).
  function ghResumenFresco(nowMs) {
    const c = ghResumenCache(); if (!c || !c.ts) return false;
    return (nowMs - c.ts) < GH_CACHE_MIN * 60000;
  }
  // invalidarResumen: marca el cache como caduco (ts=0) tras una accion propia (crear/descartar tarea, aprobar)
  // -> el proximo arranque lo refresca solo. Asi tu propio cambio no se muestra desfasado. La VERDAD siempre
  // es GitHub (el cache es solo un espejo rapido); nunca guardamos "tareas hechas" a mano — se recuentan de GitHub.
  function invalidarResumen() {
    try { const k = cacheKey(); if (!k) return; const cfg = readCfg(); if (cfg.gh_resumen && cfg.gh_resumen[k]) { cfg.gh_resumen[k].ts = 0; writeCfg(cfg); } } catch {}
  }
  // Refresco (ASYNC, red): un SNAPSHOT del usuario en la repo, con los 4 datos (assignee=lo que HACES,
  // review-requested=lo que APRUEBAS, author=lo tuyo en el aire, mentions=donde te citan). Guarda con timestamp.
  async function refrescarResumen(nowMs) {
    const R = ghRepo(); if (!R || !ghToken()) return null;
    const meR = await ghApi('user'); const me = meR.body; if (!me || !me.login) return null;
    const repoQ = `repo:${R.org}/${R.repo}`;
    // search/issues devuelve total_count sin traer todo -> barato. Un query por dato.
    const count = async (q) => { const r = await ghApi('search/issues?q=' + encodeURIComponent(`${repoQ} ${q}`)); return (r.ok && r.body && typeof r.body.total_count === 'number') ? r.body.total_count : 0; };
    // VIGILANCIA del anclaje al ciclo (mismo patron barato: total_count, sin traer los issues).
    // Solo los tipos de PLAN (ciclo:'plan' del schema) pueden estar "sin hito" de forma anormal —
    // un tipo que SURGE (bug/infra/pregunta) sin hito es normal y no cuenta como zombi.
    const cat = labelsCatalogo();
    const labelsPlan = cat.filter((l) => !l.transversal && l.ciclo === 'plan').map((l) => l.github || `faro:${l.slug}`);
    const ESTANCADA_DIAS = 30;
    let plan_sin_hito = 0, plan_sin_hito_estancadas = 0;
    if (labelsPlan.length) {
      const labelQ = `label:${labelsPlan.map((l) => `"${l}"`).join(',')}`;
      const fechaLimite = new Date(nowMs - ESTANCADA_DIAS * 86400000).toISOString().slice(0, 10);
      [plan_sin_hito, plan_sin_hito_estancadas] = await Promise.all([
        count(`is:issue is:open no:milestone ${labelQ}`),
        count(`is:issue is:open no:milestone ${labelQ} updated:<${fechaLimite}`),
      ]);
    }
    const [mis_tareas, prs_por_revisar, mis_prs, menciones, sin_label] = await Promise.all([
      count(`is:issue is:open assignee:${me.login}`),      // tareas que TENGO QUE HACER
      count(`is:pr is:open review-requested:${me.login}`), // PRs que TENGO QUE APROBAR
      count(`is:pr is:open author:${me.login}`),           // MIS PRs (esperando que me aprueben)
      count(`is:open mentions:${me.login}`),               // donde me MENCIONAN
      count('is:issue is:open no:label'),                  // issues SIN clasificar (entrados por la web)
    ]);
    // Planificador externo (#218, #277): se lee aqui, en segundo plano, y el arranque lo pinta desde la cache.
    const plan = planificacion ? await planificacion.leerRelacion(ghApi, { forge: 'github', owner: R.org, project: R.repo, path: `${R.org}/${R.repo}` }) : null;
    const snap = { mis_tareas, prs_por_revisar, mis_prs, menciones, sin_label, plan_sin_hito, plan_sin_hito_estancadas, planificacion: plan, login: me.login, ts: nowMs };
    try { const cfg = readCfg(); cfg.gh_resumen = cfg.gh_resumen || {}; cfg.gh_resumen[cacheKey()] = snap; writeCfg(cfg); } catch {}
    return snap;
  }
  // CLI oculto para refrescar en background (lo dispara el harness): harness.js gh-refresh <nowMs>
  async function cmdGhRefresh() {
    const nowMs = Number(process.argv[3]) || 0;
    if (!nowMs) return;
    await refrescarResumen(nowMs);
  }

  // ═══ REPARAR el formato de un issue que ya existe ══════════════════════════
  // Los issues creados antes de que el formato fuera obligatorio viven con dos lineas
  // y nadie volvio a completarlos. Esto les PONE la estructura CONSERVANDO lo que
  // hubiera: nada se pierde, lo que habia queda bajo 'Contexto' y el resto nace con
  // sus marcadores <...> a rellenar.
  //
  // No inventa contenido: pone el esqueleto y senala que falta. Rellenarlo con lo que
  // el issue deberia decir es trabajo de quien lo conoce, no del harness.
  async function cmdRepararTarea() {
    const cl = require('./ciclo.js');
    const args = process.argv.slice(3).filter((a) => !/^--/.test(a));
    const soloVer = process.argv.includes('--ver') || !process.argv.includes('--confirmo');
    const R = ghRepo();
    if (!R) { console.log('No detecto el repo remoto (origin).'); return; }

    // Sin numero: AUDITA todos los issues abiertos y dice cuales no cumplen.
    if (!args.length) {
      const r = await ghApi(`repos/${R.org}/${R.repo}/issues?state=open&per_page=100`);
      if (r.sinToken) { console.log('SIN_TOKEN: conectate con  node .claude/hooks/harness.js auth.'); return; }
      const issues = (r.body || []).filter((i) => !i.pull_request);
      const catA = labelsCatalogo();
      const tipoDe = (i) => cl.tipoDeEtiquetas(i.labels, catA);
      const malos = [];
      for (const i of issues) {
        const h = cl.huecosDeIssue(i.body || '', tipoDe(i));
        // Tipo de GitHub OBLIGATORIO (#213): falta o no cuadra con su etiqueta.
        const tf = await tipoForja(R.org, tipoDe(i) || 'tarea');
        if (tf.tipo && tipoActual(i) !== tf.tipo) h.push(tipoActual(i) ? `tipo de GitHub '${tipoActual(i)}' no cuadra (deberia ser ${tf.tipo})` : `sin tipo de GitHub (deberia ser ${tf.tipo})`);
        if (h.length) malos.push({ i, h });
      }
      if (!malos.length) { console.log(`✅ Los ${issues.length} issue(s) abiertos tienen el formato completo y su tipo de GitHub.`); return; }
      console.log(`${malos.length} de ${issues.length} issue(s) abiertos SIN formato completo o sin su tipo de GitHub:\n`);
      for (const { i, h } of malos) console.log(`  #${i.number}  ${String(i.title).slice(0, 60)}\n      ${h.join(' · ')}`);
      console.log(`\nRepara uno:  harness.js reparar-tarea <N> --confirmo     (sin --confirmo solo MUESTRA como quedaria)`);
      return;
    }

    const num = String(args[0]).replace(/^#/, '');
    if (!/^\d+$/.test(num)) { console.log('Uso: harness.js reparar-tarea <numero> [--confirmo]   ·   sin numero audita todos los abiertos.'); return; }
    const r = await ghApi(`repos/${R.org}/${R.repo}/issues/${num}`);
    if (r.sinToken) { console.log('SIN_TOKEN: conectate con  node .claude/hooks/harness.js auth.'); return; }
    if (!r.ok || !r.body) { console.log(`No pude leer el issue #${num} (HTTP ${r.status}).`); return; }
    const iss = r.body;
    const viejo = String(iss.body || '').trim();
    // El tipo sale de su label, para usar la plantilla que le toca (un bug pide pasos
    // para reproducir; un requerimiento, a quien sirve) y exigir sus secciones.
    const tipo = cl.tipoDeEtiquetas(iss.labels, labelsCatalogo()) || 'tarea';
    const huecos = cl.huecosDeIssue(viejo, tipo);
    // Tipo de GitHub OBLIGATORIO (#213): se repara junto al formato, o solo, si es lo unico que falta.
    const tf = await tipoForja(R.org, tipo);
    const tipoNuevo = tf.tipo && tipoActual(iss) !== tf.tipo ? tf.tipo : null;
    if (!huecos.length && !tipoNuevo) { console.log(`#${num} '${iss.title}' ya tiene el formato completo y su tipo de GitHub. Nada que reparar.`); return; }
    if (!huecos.length) {
      console.log(`#${num} · ${iss.title}   [tipo: ${tipo}]\nFormato completo; le falta el tipo de GitHub: ${tipoActual(iss) || '(ninguno)'} -> ${tipoNuevo}.`);
      if (soloVer) { console.log(`(solo vista previa — nada escrito). Aplicalo con:  harness.js reparar-tarea ${num} --confirmo`); return; }
      const up = await ghApi(`repos/${R.org}/${R.repo}/issues/${num}`, { method: 'PATCH', body: { type: tipoNuevo } });
      if (!up.ok) { console.log(`No pude fijar el tipo de GitHub (HTTP ${up.status}).`); return; }
      console.log(`✅ #${num} con tipo de GitHub ${tipoNuevo}.`);
      return;
    }

    // Lo que ya habia NO se pierde. Si trae secciones de FARO (lo que llega de Userback), se COMPLETA
    // sin reescribir: se conservan y solo se anaden las que faltan (#84). Si no trae ninguna, plantilla
    // entera y lo anterior entra como Contexto (que es lo que suele ser).
    let nuevo = cl.completarPlantilla(viejo, tipo);
    if (nuevo === null) {
      nuevo = cl.plantillaIssue(tipo);
      if (viejo) {
        nuevo = nuevo.replace(/^(## Contexto\n\n)(.*)$/m, (_m, cab) => cab + viejo);
        if (!nuevo.includes(viejo)) nuevo += `\n\n## Notas previas\n\n${viejo}\n`;
      }
    }

    console.log(`#${num} · ${iss.title}   [tipo: ${tipo}]`);
    console.log(`Le falta: ${huecos.join(' · ')}${tipoNuevo ? ` · tipo de GitHub ${tipoNuevo}` : ''}\n`);
    console.log('--- COMO QUEDARIA ---');
    console.log(nuevo.split('\n').map((l) => '  ' + l).join('\n'));
    if (soloVer) { console.log(`\n(solo vista previa — nada escrito). Aplicalo con:  harness.js reparar-tarea ${num} --confirmo`); return; }

    const up = await ghApi(`repos/${R.org}/${R.repo}/issues/${num}`, { method: 'PATCH', body: { body: nuevo, ...(tipoNuevo ? { type: tipoNuevo } : {}) } });
    if (!up.ok) { console.log(`No pude actualizar el issue (HTTP ${up.status}).`); return; }
    console.log(`\n✅ #${num} reparado — ${iss.html_url}`);
    console.log('   El esqueleto esta puesto: COMPLETA los marcadores <...> con lo que el trabajo necesita. El harness no inventa el contenido.');
  }

  // ampliar-tarea: el issue AMPLIO crece con lo que aparece por el camino, en vez de partirse en
  // hermanos. Las subtareas nuevas van a SU seccion (lib/ciclo.js ampliarCuerpo), sin repetir las que
  // ya estaban. La skill /faro:migrar-tareas lo citaba, pero no habia comando (#74).
  async function cmdAmpliarTarea() {
    const cl = require('./ciclo.js');
    const raw = process.argv.slice(3);
    const subs = [];
    let num = null;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '--subtarea') { const s = (raw[i + 1] || '').trim(); if (s) subs.push(s); i++; continue; }
      const m = raw[i].match(/^--subtarea=(.+)$/); if (m) { subs.push(m[1].trim()); continue; }
      if (!num) num = String(raw[i]).replace(/^#/, '');
    }
    if (!num || !/^\d+$/.test(num) || !subs.length) { console.log('Uso: harness.js ampliar-tarea <numero> --subtarea "<texto>" [--subtarea "<texto>" ...]'); process.exit(1); }
    const R = ghRepo();
    if (!R) { console.log('No detecto el repo remoto (origin).'); return; }
    const r = await ghApi(`repos/${R.org}/${R.repo}/issues/${num}`);
    if (r.sinToken) { console.log('SIN_TOKEN: conectate con  node .claude/hooks/harness.js auth.'); return; }
    if (!r.ok || !r.body) { console.log(`No pude leer el issue #${num} (HTTP ${r.status}).`); return; }
    const viejo = String(r.body.body || '');
    const nuevo = cl.ampliarCuerpo(viejo, subs);
    if (nuevo === viejo) { console.log(`#${num} ya tenia esas subtareas: nada que anadir.`); return; }
    const up = await ghApi(`repos/${R.org}/${R.repo}/issues/${num}`, { method: 'PATCH', body: { body: nuevo } });
    if (!up.ok) { console.log(`No pude actualizar el issue (HTTP ${up.status}).`); return; }
    console.log(`✅ #${num} ampliado con ${subs.length} subtarea(s) — ${r.body.html_url}`);
  }

  const cmdCamposTarea = () => CI.cmdCamposTarea({ ghApi, ghRepo }, process.argv.slice(3));

  return { cmdAsignarTarea, cmdAmpliarTarea, cmdCamposTarea, cmdDescartarTarea, cmdMoverTarea, cmdCerrarTarea, cmdRepararTarea, misTareas, misTareasOrg, cmdMisTareas, ghResumenCache, ghResumenFresco, refrescarResumen, cmdGhRefresh, invalidarResumen };
};
