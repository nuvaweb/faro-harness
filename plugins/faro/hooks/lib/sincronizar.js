#!/usr/bin/env node
/**
 * FARO · sincronizar — pone el LOCAL al dia con el remoto, con criterio y sin perder trabajo.
 *
 * El motor ya sabia COMPARAR ramas (gitFlow, ramas.js), pero siempre contra refs locales cacheadas:
 * sin `fetch` previo puede decirte "estas al dia" cuando llevas doce commits de retraso. Y no habia
 * ningun comando que TRAJERA el estado del remoto — las unicas menciones a `git fetch` en el motor
 * eran mensajes mandando al usuario a hacerlo a mano. Esto cierra ese hueco.
 *
 * FRONTERA DE SEGURIDAD (el corazon del comando). Solo se aplica lo que NO puede perder trabajo:
 *   - fetch            : SIEMPRE. Solo trae informacion a refs remotas; no toca tu arbol ni tus ramas.
 *   - fast-forward     : solo si el arbol esta LIMPIO y la rama NO ha divergido. Avanza el puntero a
 *                        algo que ya contiene todo lo tuyo: git no fusiona nada, no hay conflicto posible.
 *   - merge / rebase   : NUNCA automatico. Se PROPONE y decide el usuario.
 * Los conflictos se detectan EN SECO con `merge-tree` (fusion de prueba, sin tocar el arbol de
 * trabajo): asi se puede responder "¿mi rama choca con develop?" ANTES de abrir la peticion de
 * integracion, que es justo cuando sirve de algo.
 *
 * NO borra ramas: la poda es competencia de `ramas.js` (--purge). Aqui solo se INFORMA de cuantas
 * muertas hay y se remite alli — un solo sitio que borra, no dos.
 *
 * Uso:
 *   node .claude/hooks/harness.js sincronizar                 # fetch + fast-forward seguro + informe
 *   node .claude/hooks/harness.js sincronizar --solo-informe  # fetch + informe, sin tocar nada
 *   node .claude/hooks/harness.js sincronizar --json          # idem, salida legible por maquina
 */
const { execFileSync } = require('child_process');

const PROTEGIDAS = ['main', 'master'];
const BASES = ['develop', 'main', 'master'];

function crearGit(cwd) {
  return (args, { timeout = 15000 } = {}) =>
    execFileSync('git', args, {
      cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout,
    }).trim();
}

// Variante tolerante: devuelve null en vez de lanzar. Un fallo puntual de git (ref rara, permisos)
// no debe tumbar un informe cuyo valor es, precisamente, verse entero.
const intento = (git) => (args, opts) => { try { return git(args, opts); } catch { return null; } };

/** Ficheros que chocarian al fusionar `otra` en `base`, calculado SIN tocar el arbol de trabajo. */
function conflictosEnSeco(git, base, otra) {
  // `merge-tree --write-tree` hace la fusion en el almacen de objetos y sale con 1 si hay conflicto,
  // listando los ficheros afectados tras el hash del arbol. Requiere git >= 2.38; en versiones
  // anteriores no se puede saber en seco, y decirlo es mejor que inventar un "sin conflictos".
  try {
    git(['merge-tree', '--write-tree', '--name-only', base, otra]);
    return { soportado: true, ficheros: [] };            // exit 0 = fusiona limpio
  } catch (e) {
    const salida = `${e.stdout || ''}`;
    const err = `${e.stderr || ''}`;
    if (/unknown option|usage: git merge-tree/i.test(err)) return { soportado: false, ficheros: [] };
    if (e.status !== 1) return { soportado: false, ficheros: [] };
    // Formato: <hash-arbol>\n<fichero>\n<fichero>...\n\n<mensajes informativos>
    const [bloque] = salida.split(/\r?\n\r?\n/);
    const ficheros = bloque.split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean);
    return { soportado: true, ficheros };
  }
}

/** Estado de una rama local frente a su homologa en el remoto. */
function estadoRama(git, t, rama) {
  const remota = `origin/${rama}`;
  if (t(['rev-parse', '--verify', '--quiet', `refs/remotes/${remota}`]) === null) {
    return { rama, seguimiento: false, detras: 0, delante: 0, situacion: 'solo-local' };
  }
  const cuenta = t(['rev-list', '--left-right', '--count', `${rama}...${remota}`]);
  if (cuenta === null) return { rama, seguimiento: true, situacion: 'indeterminada' };
  const [delante, detras] = cuenta.split(/\s+/).map(Number);
  const situacion = delante && detras ? 'divergida'
    : detras ? 'detras'
    : delante ? 'delante'
    : 'al-dia';
  return { rama, seguimiento: true, delante, detras, situacion };
}

function analizar(cwd) {
  const git = crearGit(cwd);
  const t = intento(git);

  if (t(['rev-parse', '--is-inside-work-tree']) === null) return { error: 'sin-git' };

  const remoto = t(['remote', 'get-url', 'origin']);
  const actual = t(['rev-parse', '--abbrev-ref', 'HEAD']) || '(sin rama)';
  const sucio = (t(['status', '--porcelain']) || '') !== '';

  const acciones = { fetch: false, avanzadas: [], omitidas: [] };
  if (!remoto) {
    return {
      error: 'sin-remoto', actual, sucio, acciones,
      ramas: [], conflictos: null, muertas: null,
    };
  }

  // FETCH: siempre. Es la unica forma de que todo lo demas hable de datos reales y no de una foto
  // vieja. --prune limpia refs remotas de ramas ya borradas en el servidor (no toca ramas locales).
  // Timeout largo: aqui SI hay red de por medio.
  const fetch = t(['fetch', '--all', '--prune', '--quiet'], { timeout: 120000 });
  acciones.fetch = fetch !== null;
  if (!acciones.fetch) {
    return {
      error: 'fetch-fallido', actual, sucio, remoto, acciones,
      ramas: [], conflictos: null, muertas: null,
    };
  }

  const locales = (t(['for-each-ref', '--format=%(refname:short)', 'refs/heads/']) || '')
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const ramas = locales.map((r) => estadoRama(git, t, r));

  // FAST-FORWARD de lo seguro. Tres condiciones, todas necesarias:
  //   1) arbol limpio         -> con cambios sin commitear cualquier movimiento puede pisarlos
  //   2) situacion 'detras'   -> NO divergida: solo avanza el puntero, git no fusiona nada
  //   3) no es la rama actual -> se trata aparte (esa si mueve el arbol de trabajo)
  const soloInforme = process.argv.includes('--solo-informe');
  for (const r of ramas) {
    if (r.situacion !== 'detras') continue;
    if (soloInforme) { acciones.omitidas.push({ rama: r.rama, motivo: 'solo-informe' }); continue; }
    if (sucio) { acciones.omitidas.push({ rama: r.rama, motivo: 'arbol-sucio' }); continue; }

    if (r.rama === actual) {
      // La rama con checkout: `merge --ff-only` mueve TAMBIEN el arbol de trabajo. Sigue siendo
      // seguro (arbol limpio + no divergida), pero si git se niega por lo que sea, se respeta.
      if (t(['merge', '--ff-only', `origin/${r.rama}`]) !== null) {
        acciones.avanzadas.push({ rama: r.rama, commits: r.detras, actual: true });
        r.situacion = 'al-dia'; r.detras = 0;
      } else acciones.omitidas.push({ rama: r.rama, motivo: 'git-rechazo-ff' });
    } else {
      // Ramas sin checkout: `fetch . origin/x:x` actualiza la ref SIN tocar el arbol, y git rechaza
      // por si mismo cualquier caso que no sea fast-forward. Doble red de seguridad.
      if (t(['fetch', '.', `origin/${r.rama}:${r.rama}`]) !== null) {
        acciones.avanzadas.push({ rama: r.rama, commits: r.detras, actual: false });
        r.situacion = 'al-dia'; r.detras = 0;
      } else acciones.omitidas.push({ rama: r.rama, motivo: 'no-fast-forward' });
    }
  }

  // CONFLICTOS EN SECO de la rama actual contra su base de integracion (a donde ira su PR).
  let conflictos = null;
  const esProtegida = PROTEGIDAS.includes(actual);
  const base = BASES.find((b) => b !== actual && t(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`]) !== null);
  if (!esProtegida && base && t(['rev-parse', '--verify', '--quiet', `refs/heads/${actual}`]) !== null) {
    const ref = `origin/${base}`;
    const r = conflictosEnSeco(git, ref, actual);
    const pendientes = Number(t(['rev-list', '--count', `${ref}..${actual}`]) || 0);
    conflictos = { base, ficheros: r.ficheros, soportado: r.soportado, commitsPropios: pendientes };
  }

  // Ramas muertas: solo el CONTEO, para remitir a `ramas`. Borrar es competencia suya, no nuestra.
  let muertas = null;
  const baseViva = BASES.find((b) => t(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]) !== null);
  if (baseViva) {
    const mergeadas = (t(['branch', '--merged', baseViva]) || '')
      .split(/\r?\n/).map((s) => s.replace(/^[*+ ]+/, '').trim())
      .filter((b) => b && b !== baseViva && !PROTEGIDAS.includes(b) && b !== actual);
    muertas = mergeadas.length;
  }

  return { actual, sucio, remoto, ramas, acciones, conflictos, muertas, soloInforme };
}

function informar(a) {
  if (a.error === 'sin-git') { console.log('No es un repositorio git: aqui no hay nada que sincronizar.'); return; }

  if (a.error === 'sin-remoto') {
    console.log('\nEste repo NO tiene remoto (origin): trabajas solo en local.');
    console.log('  No hay con que sincronizar. Si deberia tenerlo, conectalo con: git remote add origin <url>');
    return;
  }
  if (a.error === 'fetch-fallido') {
    console.log('\nNo pude contactar con el remoto (origin).');
    console.log('  Suele ser falta de red o de credenciales, NO un problema de tu repo: tu trabajo local esta intacto.');
    console.log('  Compruebalo con: git fetch origin');
    return;
  }

  console.log(`\nSincronizado con origin  ·  rama actual: ${a.actual}${a.sucio ? '  ·  tienes cambios SIN COMMITEAR' : ''}`);

  console.log('\nESTADO DE TUS RAMAS');
  const etiqueta = {
    'al-dia': 'al dia',
    'detras': (r) => `${r.detras} commit(s) por detras del remoto`,
    'delante': (r) => `${r.delante} commit(s) tuyos SIN SUBIR`,
    'divergida': (r) => `DIVERGIDA: ${r.delante} tuyo(s) sin subir y ${r.detras} del remoto sin traer`,
    'solo-local': 'solo local (nunca subida)',
    'indeterminada': 'no se pudo comparar',
  };
  for (const r of a.ramas) {
    const e = etiqueta[r.situacion];
    const marca = r.rama === a.actual ? '*' : ' ';
    console.log(`  ${marca} ${r.rama.padEnd(32)} ${typeof e === 'function' ? e(r) : e}`);
  }

  if (a.conflictos) {
    const c = a.conflictos;
    console.log(`\n¿CHOCA TU RAMA CON '${c.base}'?  (comprobado en seco, sin tocar tu trabajo)`);
    if (!c.soportado) {
      console.log('  No se pudo comprobar (tu version de git no soporta la fusion de prueba).');
    } else if (!c.ficheros.length) {
      console.log(`  Limpio: no chocan. Puedes integrar sin conflictos${c.commitsPropios ? ` (${c.commitsPropios} commit(s) tuyos a integrar)` : ''}.`);
    } else {
      console.log(`  CONFLICTO en ${c.ficheros.length} fichero(s) — chocarian al integrar:`);
      c.ficheros.forEach((f) => console.log(`     · ${f}`));
      console.log(`  Resuelvelo ANTES de abrir la peticion: git merge origin/${c.base}  (y arregla esos ficheros)`);
    }
  }

  const { avanzadas, omitidas } = a.acciones;
  console.log('\nQUE HE HECHO');
  console.log('  · Traido el estado del remoto (fetch) — no toca tu trabajo.');
  if (avanzadas.length) {
    avanzadas.forEach((x) => console.log(`  · '${x.rama}' avanzada ${x.commits} commit(s) al remoto (seguro: solo avanzar, sin fusionar).`));
  } else if (!a.soloInforme) {
    console.log('  · Nada mas: no habia ninguna rama que se pudiera avanzar sin riesgo.');
  }
  if (a.soloInforme) console.log('  · --solo-informe: NO he modificado ninguna rama.');

  const pendientes = a.ramas.filter((r) => r.situacion === 'divergida' || r.situacion === 'delante');
  const bloqueadas = omitidas.filter((o) => o.motivo === 'arbol-sucio');
  if (pendientes.length || bloqueadas.length || a.muertas) {
    console.log('\nQUE TE TOCA DECIDIR A TI');
    if (bloqueadas.length) {
      console.log(`  · Tienes cambios sin commitear: no he tocado nada. Guardalos (commit) o apartalos (git stash) y vuelve a lanzarlo.`);
    }
    for (const r of pendientes) {
      if (r.situacion === 'delante') console.log(`  · '${r.rama}': ${r.delante} commit(s) tuyos sin subir  ->  git push origin ${r.rama}`);
      else console.log(`  · '${r.rama}': ha divergido (hay trabajo por ambos lados). Fusionar es decision tuya  ->  git merge origin/${r.rama}`);
    }
    if (a.muertas) console.log(`  · ${a.muertas} rama(s) ya integradas ocupando sitio  ->  limpialas con /faro:ramas`);
  }
  console.log('');
}

function cmdSincronizar(cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd()) {
  const a = analizar(cwd);
  if (process.argv.includes('--json')) {
    const porRama = {};
    for (const r of a.ramas || []) porRama[r.rama] = r;
    console.log(JSON.stringify({
      actual: a.actual || null,
      sucio: !!a.sucio,
      error: a.error || null,
      ramas: porRama,
      acciones: a.acciones || { fetch: false, avanzadas: [], omitidas: [] },
      conflictos: a.conflictos,
      muertas: a.muertas,
    }));
    return;
  }
  informar(a);
}

module.exports = { cmdSincronizar, analizar, conflictosEnSeco, estadoRama, crearGit, intento };

if (require.main === module) cmdSincronizar();
