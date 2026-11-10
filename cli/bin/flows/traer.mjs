// flows/traer.mjs — TRAER un repositorio que ya existe: la carpeta actual (adoptar, o revisar si ya
// es FARO) o un repo de la forja (clonarlo). Si se pide, lo MIGRA antes a otra forja o cuenta: crea
// el destino, sube todas las ramas y tags, cambia origin y ofrece archivar el viejo (nunca lo borra).
import path from 'node:path';
import * as p from '@clack/prompts';
import { argVal, YES, DRY, C, ok, warn, fail, caja, elige, confirma, spinner } from '../lib/core.mjs';
import { hostDe } from '../lib/forja.mjs';
import { detectarDeclarada } from '../lib/forja-propia.mjs';
import { perfilesConocidos } from '../lib/perfil.mjs';
import { tokenPara } from '../lib/credenciales.mjs';
import { usuarioHttp } from '../lib/gitcred.mjs';
import { migrarRepo, archivarRepo, sanear } from '../lib/migrar.mjs';
import { remotoActual, interactivo } from './login.mjs';
import { prepararSesion, mostrarPermisos } from './preparar.mjs';
import { flujoAbrir } from './abrir.mjs';
import { flujoAdoptar } from './adoptar.mjs';
import { flujoCheck } from './check.mjs';

const esUrl = (x) => !!hostDe(x);

// Org y nombre del destino de una migración dada por URL. GitLab anida subgrupos: todo menos el último.
function destinoDeUrl(f) {
  const segs = String(f.path || '').split('/');
  return { org: f.forja === 'gitlab' ? segs.slice(0, -1).join('/') : f.owner, nombre: f.project };
}

// Ofrece archivar el repo viejo. Solo con un token propio de ese host (nunca uno de otra forja).
async function ofrecerArchivar(cfg, dir, remotoViejo, rutaNueva) {
  const fv = detectarDeclarada(remotoViejo, { dir, perfiles: perfilesConocidos(cfg) });
  if (!['github', 'gitlab'].includes(fv.forja) || !fv.path) return;
  if (YES || !(await confirma(`¿Archivar el repo viejo ${fv.host}/${fv.path}? Queda en solo lectura; no se borra.`, 'n'))) return;
  const r = await archivarRepo({ forja: fv.forja, host: fv.host, ruta: fv.path, token: tokenPara(fv.host, cfg) });
  if (r.ok) ok(`Repo viejo archivado. El trabajo sigue en ${rutaNueva}.`);
  else warn(`No pude archivar ${fv.host}/${fv.path}${r.status ? ` (HTTP ${r.status})` : ' (sin sesión en esa forja)'}: hazlo desde su configuración.`);
}

// Migra la carpeta `dir`. migrar = URL de destino, o true (destino desde --perfil o la sesión elegida).
// Devuelve { org, nombre, url } del destino, o null si no se migró.
async function migrarCarpeta(cfg, dir, migrar) {
  p.log.step('Migrar a otra forja o cuenta');
  const url = typeof migrar === 'string' ? migrar : null;
  if (url && !esUrl(url)) { fail(`--migrar necesita la URL del repo destino (p. ej. https://gitlab.com/grupo/app.git), no '${url}'.`); return null; }
  const s = await prepararSesion(cfg, { remoto: url, preguntarDestino: !url });
  if (!s) return null;
  const f = s.ctx.forjaDetectada || {};
  const viejo = remotoActual(dir) || null;
  const deUrl = url ? destinoDeUrl(f) : null;
  if (url && (!deUrl.org || !deUrl.nombre)) { fail(`No reconozco la forja de ${url}. Declárala con git config --global faro.<host>.forja github|gitlab.`); return null; }
  if (url) await s.fijarDestino(false).catch(() => {});
  const org = deUrl ? deUrl.org : s.org;
  const nombre = (deUrl && deUrl.nombre) || (viejo && detectarDeclarada(viejo, { dir }).project) || path.basename(dir);
  const { perfil, auth } = s;
  const ruta = `${org}/${nombre}`;
  caja([`${C.d}Desde${C.x}  ${viejo || dir}`, `${C.d}Hacia${C.x}  ${C.g}${perfil.host}/${ruta}${C.x}`, `${C.d}Sube todas las ramas y tags y cambia origin.${C.x}`], { titulo: 'Migración' });
  if (DRY) { ok('(dry-run) No se migra nada.'); return null; }
  if (!YES && !(await confirma('¿Migrar?'))) return null;
  const spin = spinner(`Subiendo ramas y tags a ${perfil.host}`);
  try {
    const r = await migrarRepo({
      dir, alta: s.ctx.forja.alta, sesion: { host: perfil.host, token: auth.token },
      cuenta: { org, personal: org.toLowerCase() === String(auth.login || '').toLowerCase() }, nombre, ruta,
      url: `https://${perfil.host}/${ruta}.git`, usuario: usuarioHttp(perfil.forja), remotoViejo: viejo,
    });
    spin(`${r.creado ? 'Repo creado y migrado' : 'Migrado al repo existente'}: ${perfil.host}/${ruta}`);
  } catch (e) { spin('La migración no terminó'); fail(sanear(e.message, auth.token, usuarioHttp(perfil.forja))); return null; }
  if (viejo) await ofrecerArchivar(cfg, dir, viejo, `${perfil.host}/${ruta}`);
  return { org, nombre, url: `https://${perfil.host}/${ruta}.git` };
}

// pedido = leerModo(): { origen, repo, revisar, migrar }. catalogo: naturalezas y dominios.
// Devuelve 'CREAR' si quien abre no tiene repos y quiere crear uno.
async function flujoTraer(cfg, pedido, catalogo) {
  let { origen, migrar } = pedido;
  const { repo, revisar } = pedido;
  if (!origen) {
    origen = YES ? 'carpeta' : await elige('¿Qué traes?', {
      carpeta: { etiqueta: 'Esta carpeta', explica: path.resolve(argVal('dir') || process.cwd()) },
      repo: { etiqueta: 'Un repositorio de la forja', explica: 'Lo eliges de tu cuenta o pegas su URL.' },
    });
  }
  let dir = path.resolve(argVal('dir') || process.cwd());
  if (origen === 'repo') {
    const s = await prepararSesion(cfg, { remoto: repo && esUrl(repo) ? repo : null, preguntarDestino: false });
    if (!s) return null;
    const ruta = repo && esUrl(repo) ? s.ctx.forjaDetectada.path : repo;
    const r = await flujoAbrir(s.auth, s.org, cfg, s.ctx, ruta);
    if (r === 'CREAR' || !r) return r || null;
    if (!migrar && interactivo() && await confirma('¿Moverlo además a otra forja o cuenta?', 'n')) migrar = true;
    if (!migrar) { mostrarPermisos(s.perfil, r.ruta); p.outro(`${C.g}✅ Traído${C.x}`); return null; }
    dir = r.destino;
  } else if (!migrar && !revisar && interactivo() && remotoActual(dir)) {
    if (await confirma('¿Moverlo a otra forja o cuenta antes de seguir?', 'n')) migrar = true;
  }
  const migrado = migrar ? await migrarCarpeta(cfg, dir, migrar) : null;
  if (migrar && !migrado) return null;
  // Adoptar o revisar con la sesión del remoto: tras migrar, la del destino, con su cuenta y su nombre.
  const s = migrado
    ? await prepararSesion(cfg, { dir, remoto: migrado.url, perfilFlag: null, org: migrado.org, preguntarDestino: false })
    : await prepararSesion(cfg, { dir, usarRemoto: true, preguntarDestino: !revisar });
  if (!s) return null;
  s.ctx.dir = dir;
  if (migrado) s.ctx.repoNombre = migrado.nombre;
  if (revisar) { await flujoCheck(s.auth, s.org, cfg, catalogo, s.esOwner, s.ctx); return null; }
  await flujoAdoptar(s.auth, s.org, cfg, catalogo, s.esOwner, s.ctx);
  return null;
}

export { flujoTraer, destinoDeUrl };
