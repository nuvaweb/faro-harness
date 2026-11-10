/**
 * FARO · remoto al arrancar — al empezar cada sesion, VALIDA que lo local coincide con el remoto (#106).
 *
 * Antes el vigilante hacia 'git fetch origin' (sin --all ni --prune) y solo comparaba main/develop:
 * las ramas remotas borradas seguian pareciendo vivas, tu rama de trabajo podia ir por detras de su
 * remoto sin que nadie lo dijera, y el trabajo de otros esperando en el remoto pasaba desapercibido.
 *
 * Que hace (en el vigilante, en segundo plano: el fetch es RED y no puede retrasar el arranque):
 *   1. 'git fetch --all --prune': estado real de todos los remotos, sin refs de ramas ya borradas.
 *   2. Pone al dia main/master/develop SOLO si es seguro (misma frontera que 'sincronizar'): avance
 *      rapido, sin fusionar nada; la rama con checkout solo con el arbol limpio.
 *   3. Avisa si tu rama de trabajo va por DETRAS de su remoto (alguien subio cambios). Ir por DELANTE
 *      es trabajo tuyo sin subir: lo normal, no se avisa.
 *   4. Lista las ramas remotas con trabajo que aun NO esta en develop (pendientes de validar),
 *      reconociendo tambien las integradas por squash (su contenido ya esta en la base).
 *   Sin red: lo DICE. "No pude comprobar" no es "estas al dia".
 */
const { crearGit, intento, estadoRama } = require('./sincronizar.js');
const { desfaseIntegracion } = require('./git.js');

const INTEGRACION = ['main', 'master', 'develop'];
const MAX_LISTADAS = 5;

/** Contenido de `ref` ya presente en `base` (merge normal, squash o rebase). */
function integrada(t, base, ref) {
  if (t(['merge-base', '--is-ancestor', ref, base]) !== null) return true;
  // Squash/rebase: ningun commit es ancestro, pero fusionarla no cambiaria nada en la base.
  const arbolBase = t(['rev-parse', `${base}^{tree}`]);
  const fusion = t(['merge-tree', '--write-tree', base, ref]);   // null si hay conflicto o git < 2.38
  return !!fusion && fusion.split(/\r?\n/)[0].trim() === arbolBase;
}

function ponerAlDia(t, actual, sucio) {
  const avanzadas = [], detras = [], divergidas = [], sinRemota = [];
  for (const rama of INTEGRACION) {
    if (t(['rev-parse', '--verify', '--quiet', `refs/heads/${rama}`]) === null) continue;
    const e = estadoRama(null, t, rama);
    if (e.situacion === 'solo-local') { sinRemota.push(rama); continue; }
    if (e.situacion === 'divergida') { divergidas.push(e); continue; }
    if (e.situacion !== 'detras') continue;
    const ok = rama === actual
      ? (!sucio && t(['merge', '--ff-only', '--quiet', `origin/${rama}`]) !== null)
      : t(['fetch', '.', `origin/${rama}:${rama}`]) !== null;   // git rechaza solo lo que no es avance
    if (ok) avanzadas.push({ rama, commits: e.detras });
    else detras.push({ rama, detras: e.detras, motivo: rama === actual && sucio ? 'cambios sin commitear' : null });
  }
  return { avanzadas, detras, divergidas, sinRemota };
}

function pendientesEnRemoto(t, actual) {
  const base = ['develop', 'main', 'master'].map((b) => `origin/${b}`)
    .find((r) => t(['rev-parse', '--verify', '--quiet', `refs/remotes/${r}`]) !== null);
  if (!base) return { base: null, ramas: [] };
  const excluir = new Set(['origin/HEAD', 'origin', ...INTEGRACION.map((b) => `origin/${b}`), `origin/${actual}`]);
  const filas = (t(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)|%(committerdate:short)|%(authorname)', 'refs/remotes/origin']) || '')
    .split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => { const [ref, fecha, autor] = l.split('|'); return { ref, fecha, autor }; })
    .filter((r) => !excluir.has(r.ref));
  return { base, ramas: filas.filter((r) => !integrada(t, base, r.ref)) };
}

/** Parte con RED y efectos (fetch + avance seguro). Devuelve los hechos; no decide que decir. */
function revisarRemoto(cwd) {
  const t = intento(crearGit(cwd));
  if (t(['rev-parse', '--is-inside-work-tree']) === null) return { sinGit: true };
  if (!t(['remote', 'get-url', 'origin'])) return { sinRemoto: true };
  if (t(['fetch', '--all', '--prune', '--quiet', '--no-tags'], { timeout: 60000 }) === null) return { fetchFallido: true };

  const actual = t(['rev-parse', '--abbrev-ref', 'HEAD']) || '';
  const sucio = (t(['status', '--porcelain']) || '') !== '';
  const integracion = ponerAlDia(t, actual, sucio);

  let trabajo = null;
  if (actual && !INTEGRACION.includes(actual) && t(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${actual}`]) !== null) {
    const e = estadoRama(null, t, actual);
    if (e.situacion === 'detras' || e.situacion === 'divergida') trabajo = e;
  }
  return { actual, ...integracion, trabajo, pendientes: pendientesEnRemoto(t, actual) };
}

/**
 * Parte PURA: de los hechos a los avisos, CLASIFICADOS (#124).
 *   accion: algo que el agente debe atender antes de seguir (base movida, rama por detras o divergida,
 *           no se pudo comprobar). Despierta al agente (exit 2).
 *   info:   lo que conviene que el HUMANO sepa pero no le toca resolver al agente ahora (ramas de otros
 *           pendientes de validar en el remoto). Va por systemMessage, sin bloquear ni despertar.
 */
function clasificarAvisos(r) {
  const vacio = { accion: [], info: [] };
  if (!r || r.sinGit || r.sinRemoto) return vacio;
  if (r.fetchFallido) {
    return { accion: ['No pude validar con el remoto (sin red o sin credenciales): no se si local y remoto coinciden. Compruebalo con harness.js sincronizar.'], info: [] };
  }
  const avisos = [];
  const info = [];
  for (const a of r.avanzadas || []) {
    avisos.push(`'${a.rama}' puesta al dia con el remoto (+${a.commits} commit(s); solo avance, sin fusionar nada).`);
  }
  for (const d of r.detras || []) {
    for (const txt of desfaseIntegracion([d])) avisos.push(d.motivo ? `${txt} No la he avanzado: tienes ${d.motivo}.` : txt);
  }
  avisos.push(...desfaseIntegracion((r.sinRemota || []).map((rama) => ({ rama, detras: null, motivo: 'sin rama remota' }))));
  for (const d of r.divergidas || []) {
    avisos.push(`'${d.rama}' ha DIVERGIDO de origin/${d.rama} (${d.delante} commit(s) locales sin subir y ${d.detras} del remoto): no la toco, decide tu — harness.js sincronizar.`);
  }
  const w = r.trabajo;
  if (w) {
    avisos.push(w.situacion === 'divergida'
      ? `Tu rama '${w.rama}' y origin/${w.rama} han divergido (${w.delante} tuyo(s), ${w.detras} del remoto): integra lo del remoto antes de seguir — git pull --rebase (o merge).`
      : `Tu rama '${w.rama}' va ${w.detras} commit(s) por detras de origin/${w.rama} (alguien subio cambios): traelos antes de seguir — git pull --ff-only.`);
  }
  const p = r.pendientes;
  if (p && p.ramas && p.ramas.length) {
    const lista = p.ramas.slice(0, MAX_LISTADAS).map((x) => `${x.ref.replace(/^origin\//, '')} (${x.fecha}, ${x.autor})`).join(' · ');
    const resto = p.ramas.length > MAX_LISTADAS ? ` (+${p.ramas.length - MAX_LISTADAS} mas)` : '';
    info.push(`${p.ramas.length} rama(s) en el remoto con trabajo que aun no esta en ${p.base.replace(/^origin\//, '')}: ${lista}${resto}. Revisalas: si estan listas, /faro:consolidar; si estan abandonadas, /faro:ramas.`);
  }
  return { accion: avisos, info };
}

/** Todos los avisos en una lista (accion primero). Lista vacia = local y remoto coinciden (silencio). */
function avisosArranque(r) {
  const c = clasificarAvisos(r);
  return [...c.accion, ...c.info];
}

module.exports = { revisarRemoto, avisosArranque, clasificarAvisos, integrada };
