// forja-propia.mjs — SERVIDOR PROPIO: qué forja hay detrás de un host que no es github.com ni gitlab.com.
//
// No se adivina por el nombre: se declara en git config y se respeta.
//   git config faro.forja gitlab|github                  -> este repo (manda)
//   git config --global faro.<host>.forja gitlab|github  -> todo ese servidor
// Si no hay declaración y hay alguien a quien preguntar, se pregunta y se guarda la respuesta en la
// clave del servidor. Sin terminal queda 'desconocida': mejor no operar que mandar un token a ciegas.
import { execFileSync } from 'node:child_process';
import { detectarForja, hostDe } from './forja.mjs';

const FORJAS = ['github', 'gitlab'];
const low = (s) => String(s || '').trim().toLowerCase();
const PUBLICOS = ['github.com', 'gitlab.com'];

// git(args) -> stdout recortado, o null si git falla (clave ausente incluida).
function gitConfig(args) {
  try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); } catch { return null; }
}

const claveServidor = (host) => `faro.${low(host)}.forja`;

function leerForjaDeclarada(host, { dir = null, git = gitConfig } = {}) {
  const valida = (v) => (FORJAS.includes(low(v)) ? low(v) : null);
  const delRepo = dir ? valida(git(['-C', dir, 'config', '--get', 'faro.forja'])) : null;
  return delRepo || (host ? valida(git(['config', '--global', '--get', claveServidor(host)])) : null);
}

function declararForja(host, forja, { git = gitConfig } = {}) {
  if (!FORJAS.includes(forja)) throw new Error(`La forja de ${host} tiene que ser github o gitlab.`);
  git(['config', '--global', claveServidor(host), forja]);
}

// Opciones para preguntar. `elegir(host, ops)` devuelve una clave.
const opcionesForja = (host) => ({
  github: { etiqueta: 'GitHub Enterprise', explica: host },
  gitlab: { etiqueta: 'GitLab propio', explica: host },
  __ninguna: { etiqueta: 'Ninguna de las dos / no lo sé', explica: 'no se conecta con este servidor' },
});

// detectarForja con la declaración aplicada, sin preguntar nunca.
function detectarDeclarada(remote, { dir = null, perfiles = [], git = gitConfig } = {}) {
  const hd = hostDe(remote);
  const host = hd ? low(hd.host) : null;
  if (!host || PUBLICOS.includes(host)) return detectarForja(remote, perfiles);
  return detectarForja(remote, perfiles, leerForjaDeclarada(host, { dir, git }));
}

// Igual, pero si el host es propio y no consta, pregunta y declara.
async function forjaDeRemoto(remote, { dir = null, perfiles = [], git = gitConfig, elegir = null } = {}) {
  const hd = hostDe(remote);
  const host = hd ? low(hd.host) : null;
  if (!host || PUBLICOS.includes(host)) return detectarForja(remote, perfiles);
  let declarada = leerForjaDeclarada(host, { dir, git });
  const previo = detectarForja(remote, perfiles, declarada);
  if (previo.forja !== 'desconocida' || !elegir || !previo.path) return previo;
  const r = await elegir(host, opcionesForja(host));
  if (!FORJAS.includes(r)) return previo;
  declararForja(host, r, { git });
  declarada = r;
  return detectarForja(remote, perfiles, declarada);
}

export { FORJAS, detectarDeclarada, leerForjaDeclarada, declararForja, forjaDeRemoto, opcionesForja, claveServidor };
