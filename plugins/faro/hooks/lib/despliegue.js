'use strict';
// Núcleo agnóstico de despliegue: configuración, registro de adaptadores y diagnóstico agregado.
// Los adaptadores (Cloudflare, Terraform...) implementan el contrato { id, detectar, diagnostico,
// gates, pasosCi, comandoLocal, secretosEsperados }. Este módulo no sabe nada de ninguno en concreto.
const fs = require('node:fs');
const path = require('node:path');

// Etapas del despliegue: convención fija, sin configurar. Solo las usa el generador de CI.
const ETAPAS = [{ fase: 'pr', entorno: 'preview' }, { fase: 'main', entorno: 'staging' }, { fase: 'tag', entorno: 'production' }];
const PUERTAS = ['tag', 'aprobacion', 'manual'];
const INFRAS = ['propia', 'externa'];

const cadena = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Lee faro/config.json > despliegue con valores por defecto; lo inválido cae al defecto y avisa. */
function config(cfgRepo) {
  const raw = cfgRepo && typeof cfgRepo === 'object' && cfgRepo.despliegue && typeof cfgRepo.despliegue === 'object' && !Array.isArray(cfgRepo.despliegue)
    ? cfgRepo.despliegue : {};
  const avisos = [];
  const out = {
    puerta_produccion: 'tag', preview: true,
    infra: null, referencia: null, salud_url: null, terraform: { dir: null, binario: null }, avisos,
  };

  if (raw.puerta_produccion !== undefined) {
    if (PUERTAS.includes(raw.puerta_produccion)) out.puerta_produccion = raw.puerta_produccion;
    else avisos.push(`despliegue.puerta_produccion debe ser ${PUERTAS.join(', ')}; se usa "tag".`);
  }
  if (raw.preview !== undefined) {
    if (typeof raw.preview === 'boolean') out.preview = raw.preview;
    else avisos.push('despliegue.preview debe ser true o false; se usa true.');
  }
  if (raw.infra !== undefined && raw.infra !== null) {
    if (INFRAS.includes(raw.infra)) out.infra = raw.infra;
    else avisos.push(`despliegue.infra debe ser ${INFRAS.join(' o ')}; se ignora.`);
  }
  out.referencia = cadena(raw.referencia);
  out.salud_url = cadena(raw.salud_url);
  if (raw.terraform && typeof raw.terraform === 'object') {
    out.terraform = { dir: cadena(raw.terraform.dir), binario: cadena(raw.terraform.binario) };
  }
  return out;
}

// ---------- registro de adaptadores (carga perezosa; tolera los que aún no existen) ----------

const MODULOS = ['./despliegue-cloudflare.js', './despliegue-terraform.js'];

function cargar(modulo) {
  try { return require(modulo); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(modulo.replace('./', ''))) return null;
    throw e;
  }
}

/** Lista registrada de adaptadores disponibles, cargada al pedirla. */
function adaptadores() { return MODULOS.map(cargar).filter(Boolean); }

const ADAPTADORES = new Proxy([], {
  get(_t, prop) { const lista = adaptadores(); const v = lista[prop]; return typeof v === 'function' ? v.bind(lista) : v; },
  has(_t, prop) { return prop in adaptadores(); },
  ownKeys() { return Reflect.ownKeys(adaptadores()); },
  getOwnPropertyDescriptor(_t, prop) { const d = Object.getOwnPropertyDescriptor(adaptadores(), prop); if (d) d.configurable = true; return d; },
});
// Array.isArray sobre un Proxy de array devuelve true.

// ---------- diagnóstico agregado ----------

const ORDEN = { error: 0, aviso: 1, info: 2 };

function diagnosticar(ctx, lista) {
  const detectados = [];
  const hallazgos = [];
  const porNombre = new Map();
  for (const ad of lista || adaptadores()) {
    const det = ad.detectar(ctx);
    if (!det) continue;
    detectados.push({ id: ad.id, det });
    hallazgos.push(...(ad.diagnostico(ctx, det) || []));
    for (const s of (ad.secretosEsperados(ctx, det) || [])) {
      if (!porNombre.has(s.nombre)) porNombre.set(s.nombre, { nombre: s.nombre, proposito: s.proposito });
    }
  }
  if (!detectados.length) {
    return { detectados: [], hallazgos: [{ nivel: 'info', codigo: 'sin-despliegue', mensaje: 'Sin despliegue detectado en este repo.' }], secretos: [] };
  }
  hallazgos.sort((a, b) => (ORDEN[a.nivel] ?? 3) - (ORDEN[b.nivel] ?? 3));
  return { detectados, hallazgos, secretos: [...porNombre.values()] };
}

// ---------- contexto desde disco (el único sitio que toca fs) ----------

function ctxDesdeDisco(root, cfgRepo) {
  const abs = (rel) => path.join(root, rel);
  const leer = (rel) => { try { return fs.readFileSync(abs(rel), 'utf8'); } catch { return null; } };
  const existe = (rel) => { try { return fs.existsSync(abs(rel)); } catch { return false; } };
  const listar = (dirRel) => { try { return fs.readdirSync(abs(dirRel)); } catch { return []; } };

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

  return { root, leer, existe, listar, cfg: config(cfgRepo), forja, monorepo, apps };
}

module.exports = { ETAPAS, config, diagnosticar, ctxDesdeDisco, adaptadores, ADAPTADORES };
