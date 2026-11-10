// forjas/index.mjs — selector de adaptador por perfil. Import perezoso: un usuario de GitLab nunca
// carga el código de GitHub (y al revés). Ambos adaptadores exponen la MISMA interfaz.
export async function forjaDe(perfil) {
  if (perfil.forja === 'gitlab') return (await import('./gitlab.mjs')).FORJA_GITLAB;
  if (perfil.forja === 'github') return (await import('./github.mjs')).FORJA_GITHUB;
  throw new Error(`Forja '${perfil.forja}' no soportada (perfil ${perfil.id}).`);
}
