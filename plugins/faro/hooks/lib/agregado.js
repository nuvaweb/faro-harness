// lib/agregado.js — RESUMEN AGREGADO de sesion (0.30.0): una foto compacta de "como esta este repo"
// (ramas vivas/muertas, tus tareas abiertas), cacheada en ~/.faro.json y refrescada en SEGUNDO PLANO
// — mismo patron que gh_resumen en github-tareas.js: la sesion LEE sin red y sin lanzar procesos git
// de mas; el refresco lo hace un proceso hijo desacoplado cuando el dato caduca.
//
// Por que: el contexto de sesion obliga a leer ESTADO.md/listar ramas/consultar issues cada vez que
// se quiere saber "el estado general" de un repo. Un numero agregado que se auto-actualiza da esa
// vista de un vistazo, sin gastar turno ni llamadas en reconstruirla.
//
// V1 deliberadamente acotado a lo que YA se calcula en otro sitio, sin abrir dependencias nuevas sin
// validar: ramas (ramas.js --json, local, sin red) + tus issues abiertos (ya en gh_resumen). Repo-wide
// open/closed (no solo los tuyos) y ClickUp quedan fuera — piden una llamada paginada nueva o que
// exista ESTADO.md con clickup_list; ver gestion/cambios/changes/resumen-agregado-sesion/proposal.md.
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = function (ctx) {
  const { ROOT } = ctx;
  const CRED = require(path.join(__dirname, 'credenciales.js'))();
  const RESUMEN_MIN = 10; // ramas cambian menos que issues (gh_resumen usa 5 min) -> menos refrescos

  // Misma clave que gh_resumen (github-tareas.js): la URL de origin. Sin remoto, cae a la ruta local
  // (repo sin publicar aun, o sesion de pruebas) para no reventar el cacheo.
  const repoKey = () => {
    try {
      const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, windowsHide: true, encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return url || ROOT;
    } catch { return ROOT; }
  };

  // Lectura SINCRONA (no red, no spawn): -> {ramas, tus_issues_abiertos, ts} o null.
  function agregadoCache() {
    const k = repoKey();
    const cfg = CRED.leerCfg();
    return (cfg.resumen_agregado || {})[k] || null;
  }

  function agregadoFresco(nowMs) {
    const c = agregadoCache();
    if (!c || !c.ts) return false;
    return (nowMs - c.ts) < RESUMEN_MIN * 60000;
  }

  // Ramas vivas/muertas: reutiliza la clasificacion YA probada de ramas.js (squash/merge-tree
  // incluido) via su modo --json, en vez de duplicar esa logica aqui.
  function ramasConteo() {
    try {
      const out = execFileSync(process.execPath, [path.join(__dirname, 'ramas.js'), '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8', timeout: 15000 });
      const j = JSON.parse(out);
      return { vivas: j.vivas, muertas: j.muertas };
    } catch { return null; }
  }

  // Refresco: lo llama un proceso YA en segundo plano (spawn detached, ver harness.js), nunca la
  // sesion interactiva directamente. Compone el conteo de ramas (local) con lo que gh_resumen ya
  // tenga cacheado (tus issues) — sin llamada de red PROPIA nueva.
  function refrescarAgregado(nowMs) {
    const k = repoKey();
    const cfg = CRED.leerCfg();
    const gh = (cfg.gh_resumen || {})[k] || null;
    // gh_resumen.mis_tareas ya es un NUMERO (total_count de la API de busqueda, ver
    // github-tareas.js:refrescarResumen) — no un array; no se le aplica .length.
    // plan_sin_hito/plan_sin_hito_estancadas: MISMO patron — la vigilancia del anclaje al ciclo
    // (0.31.1) ya la calculo gh_resumen con total_count; aqui solo se compone, sin red propia.
    const numO = (v) => typeof v === 'number' ? v : null;
    const snap = {
      ramas: ramasConteo(),
      tus_issues_abiertos: gh && typeof gh.mis_tareas === 'number' ? gh.mis_tareas : null,
      plan_sin_hito: gh ? numO(gh.plan_sin_hito) : null,
      plan_sin_hito_estancadas: gh ? numO(gh.plan_sin_hito_estancadas) : null,
      ts: nowMs,
    };
    cfg.resumen_agregado = cfg.resumen_agregado || {};
    cfg.resumen_agregado[k] = snap;
    CRED.escribirCfg(cfg);
    return snap;
  }

  return { agregadoCache, agregadoFresco, refrescarAgregado, repoKey, RESUMEN_MIN };
};
