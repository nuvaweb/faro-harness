// alta.mjs — nacimiento de un repo igual en cualquier forja: repo vacío por API, contenido por git
// desde el esqueleto del paquete (más el stack si hay plantilla) y, ya con ramas, develop por defecto,
// topics y protección. Devuelve datos: los mensajes son del flujo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { copiarEsqueleto, RAIZ_ESQUELETO } from './esqueleto.mjs';
import { clonadorPublico } from './monorepo.mjs';
import { mergeGitignore } from './repo.mjs';
import { urlConToken, usuarioHttp, noreplyDe } from './gitcred.mjs';

// Autor de los commits del alta: la cuenta, con el noreply de su forja si el correo es privado.
const identidadDe = (auth, perfil) => ({ nombre: auth.name || auth.login, email: auth.email || noreplyDe(auth, perfil) });
const urlGitDe = (perfil, token, ruta) => urlConToken(`https://${perfil.host}/${ruta}.git`, usuarioHttp(perfil.forja), token);

// GitLab: quien crea mantiene (aprueba merges a main) aunque en el grupo sea Developer. 409 = ya lo era.
async function asegurarMantenedor(forja, s, destino, ruta, id) {
  if (forja.id !== 'gitlab' || destino.personal || !id) return { aplicado: false, ok: true, status: null };
  const r = await forja.anadirMiembro(s.host, s.token, ruta, id, 40);
  return { aplicado: true, ok: r.ok || r.status === 409, status: r.status };
}

const carpetaTemporal = () => fs.mkdtempSync(path.join(os.tmpdir(), 'faro-alta-'));

// La URL lleva el token: ningún error de git puede salir de aquí con ella.
function sembrarRepo({ url, identidad, preparar = () => {} }) {
  const dir = carpetaTemporal();
  const git = (...a) => execFileSync('git', ['-c', 'credential.helper=', '-c', `user.name=${identidad.nombre}`, '-c', `user.email=${identidad.email}`, '-C', dir, ...a], {
    stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  try {
    git('init', '-q', '-b', 'main');
    copiarEsqueleto(dir);
    preparar(dir);
    git('add', '-A');
    git('commit', '-q', '-m', 'chore: nace con la capa FARO');
    git('push', '-q', url, 'main:main');
    git('push', '-q', url, 'main:develop');
  } catch {
    throw new Error('no pude subir el contenido inicial al repo (¿red o permisos?)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// El stack manda sobre el esqueleto, salvo en el .gitignore, que suma los dos.
function superponerPlantilla(plantilla, raiz) {
  const dir = carpetaTemporal();
  try {
    const clon = path.join(dir, 'clon');
    try { clonadorPublico(plantilla, clon); } catch (e) { return { ok: false, motivo: e.message }; }
    fs.rmSync(path.join(clon, '.git'), { recursive: true, force: true });
    fs.cpSync(clon, raiz, { recursive: true });
    mergeGitignore(path.join(RAIZ_ESQUELETO, 'gitignore'), path.join(raiz, '.gitignore'));
    return { ok: true, motivo: null };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function altaDesdeEsqueleto({ alta, sesion, destino, nombre, descripcion, topics, urlGit, identidad, plantilla = null }) {
  const repo = await alta.crearRepo(sesion, destino, { nombre, descripcion });
  if (!repo.ok) return { ok: false, fase: 'crear', status: repo.status, mensaje: repo.mensaje };
  let plantillaError = null;
  try {
    sembrarRepo({
      url: urlGit(repo.ruta), identidad,
      preparar: (dir) => { if (plantilla) { const r = superponerPlantilla(plantilla, dir); plantillaError = r.motivo; } },
    });
  } catch (e) { return { ok: false, fase: 'contenido', ruta: repo.ruta, web: repo.web, mensaje: e.message }; }
  const develop = await alta.ramaPorDefecto(sesion, repo.ruta, 'develop');
  const tp = await alta.estamparTopics(sesion, repo.ruta, topics);
  const conf = await alta.configurar(sesion, repo.ruta, { descripcion });
  const proteccion = await alta.proteger(sesion, repo.ruta, 'main');
  return {
    ok: true, ruta: repo.ruta, web: repo.web, plantillaError,
    develop: develop.ok, topics: tp.ok, configurado: conf.ok, protegida: proteccion.ok, statusProteccion: proteccion.status,
  };
}

export { identidadDe, urlGitDe, asegurarMantenedor, sembrarRepo, superponerPlantilla, altaDesdeEsqueleto };
