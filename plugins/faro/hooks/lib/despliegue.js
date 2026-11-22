'use strict';
// Núcleo agnóstico de despliegue: configuración, registro de adaptadores y diagnóstico agregado.
// FARO solo valida: el despliegue, los secretos y los entornos los pone devops en la forja.
// Los adaptadores (Cloudflare, Terraform...) implementan el contrato { id, detectar, diagnostico,
// gates, comandoLocal }. Este módulo no sabe nada de ninguno en concreto.
const fs = require('node:fs');
const path = require('node:path');

const cadena = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Lee faro/config.json > despliegue con valores por defecto; lo inválido cae al defecto y avisa. */
function config(cfgRepo) {
  const raw = cfgRepo && typeof cfgRepo === 'object' && cfgRepo.despliegue && typeof cfgRepo.despliegue === 'object' && !Array.isArray(cfgRepo.despliegue)
    ? cfgRepo.despliegue : {};
  const avisos = [];
  const out = {
    terraform: { dir: null, binario: null }, avisos,
  };

  if (raw.terraform && typeof raw.terraform === 'object') {
    out.terraform = { dir: cadena(raw.terraform.dir), binario: cadena(raw.terraform.binario) };
  }
  return out;
}

// ---------- registro de adaptadores (carga perezosa; tolera los que aún no existen) ----------

const MODULOS = ['./despliegue-cloudflare.js', './despliegue-terraform.js'];

function cargar(modulo) {
  // Solo se tolera que el fichero del adaptador no exista; un fallo dentro de él se propaga.
  try { require.resolve(modulo); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') return null;
    throw e;
  }
  return require(modulo);
}

/** Lista registrada de adaptadores disponibles, cargada al pedirla (array real). */
function adaptadores() { return MODULOS.map(cargar).filter(Boolean); }

// ---------- diagnóstico agregado ----------

const ORDEN = { error: 0, aviso: 1, info: 2 };

function diagnosticar(ctx, lista) {
  const detectados = [];
  const hallazgos = [];
  const devops = [];
  for (const ad of lista || adaptadores()) {
    const det = ad.detectar(ctx);
    if (!det) continue;
    detectados.push({ id: ad.id, det });
    hallazgos.push(...(ad.diagnostico(ctx, det) || []));
    if (typeof ad.paraDevops === 'function') devops.push(...(ad.paraDevops(ctx, det) || []).map((x) => ({ adaptador: ad.id, ...x })));
  }
  if (!detectados.length) {
    return { detectados: [], hallazgos: [{ nivel: 'info', codigo: 'sin-despliegue', mensaje: 'Sin despliegue detectado en este repo.' }] };
  }
  hallazgos.sort((a, b) => (ORDEN[a.nivel] ?? 3) - (ORDEN[b.nivel] ?? 3));
  return { detectados, hallazgos, devops };
}

// ---------- contexto desde disco (el único sitio que toca fs) ----------

function ctxDesdeDisco(root, cfgRepo) {
  const abs = (rel) => path.join(root, rel);
  const leer = (rel) => { try { return fs.readFileSync(abs(rel), 'utf8'); } catch { return null; } };
  const existe = (rel) => { try { return fs.existsSync(abs(rel)); } catch { return false; } };
  const listar = (dirRel) => { try { return fs.readdirSync(abs(dirRel)); } catch { return []; } };

  // ¿Está el comando en el PATH? Lo usan los adaptadores para gates opcionales (tflint, checkov).
  const enPath = (cmd) => {
    const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').concat('') : [''];
    return String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
      .some((d) => exts.some((x) => { try { return fs.statSync(path.join(d, cmd + x)).isFile(); } catch { return false; } }));
  };

  let forja = null;
  try {
    const r = require('node:child_process').spawnSync('git', ['remote', 'get-url', 'origin'], {
      cwd: root, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' },
    });
    const f = r.status === 0 ? require('./forge.js').detect(r.stdout.trim()).forge : null;
    forja = f === 'github' || f === 'gitlab' ? f : null;
  } catch { forja = null; }

  let apps = [];
  let monorepo = false;
  try {
    const A = require('./apps.js');
    monorepo = A.esMonorepo(root);
    if (monorepo) apps = A.apps(root).filter((a) => a.existe && a.ruta).map((a) => ({ id: a.id, dir: a.ruta }));
  } catch { /* sin apps */ }

  return { root, leer, existe, listar, enPath, cfg: config(cfgRepo), forja, monorepo, apps };
}

module.exports = { config, diagnosticar, ctxDesdeDisco, adaptadores };
