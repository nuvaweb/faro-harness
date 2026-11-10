// actualizar.mjs — `faro update`: refresca el plugin y dice si npm tiene un wizard más nuevo. Un wizard
// no se puede actualizar a sí mismo desde npx, así que solo enseña el comando.
import fs from 'node:fs';
import { cmpVersion, instalarPluginsClaude } from './plugin.mjs';
import { overrideMarketplace } from './gitcred.mjs';
import { say, warn } from './core.mjs';

const PAQUETE = 'faro-harness';
const instaladaAhora = () => JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

async function versionPublicada({ fetchImpl = fetch, limiteMs = 3000 } = {}) {
  try {
    const r = await fetchImpl(`https://registry.npmjs.org/${PAQUETE}/latest`, { signal: AbortSignal.timeout(limiteMs) });
    if (!r.ok) return null;
    return (await r.json()).version || null;
  } catch { return null; }
}

const avisoVersion = (instalada, publicada) => (publicada && cmpVersion(publicada, instalada) > 0
  ? `Hay un wizard nuevo (${instalada} → ${publicada}). Actualízalo con: npx ${PAQUETE}@latest update`
  : null);

async function actualizar({
  refrescar = instalarPluginsClaude, consultar = versionPublicada, instalada = instaladaAhora(), decir = say, avisar = warn,
} = {}) {
  let plugin;
  try { plugin = (await refrescar({ silencioSiOk: false, forzar: true, override: overrideMarketplace() })).estado; }
  catch (e) { plugin = 'error'; avisar(`No pude refrescar el plugin faro: ${e.message}`); }
  const aviso = avisoVersion(instalada, await consultar());
  if (aviso) decir(aviso);
  return { plugin, aviso };
}

export { versionPublicada, avisoVersion, actualizar };
