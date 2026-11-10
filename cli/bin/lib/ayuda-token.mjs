// ayuda-token.mjs — qué token crear para conectar con una forja y dónde. Puro: devuelve líneas.

function urlTokens(forja, host) {
  return forja === 'gitlab' ? `https://${host}/-/user_settings/personal_access_tokens` : `https://${host}/settings/tokens`;
}

function ayudaToken(forja, host) {
  const scopes = forja === 'gitlab'
    ? ['Scope: api.']
    : ['Scopes: repo y read:org; workflow es opcional (solo si vas a tocar GitHub Actions).'];
  return [
    `Crea un token personal en ${urlTokens(forja, host)}`,
    ...scopes,
    'El SSH solo mueve el código: crear el repo, proteger ramas o poner topics usa la API, y la API necesita el token.',
  ];
}

export { urlTokens, ayudaToken };
