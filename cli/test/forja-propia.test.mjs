// Servidor propio: la forja no se adivina por el nombre del host; se declara en git config, por repo
// (faro.forja) o por servidor (faro.<host>.forja, global), y si falta se pregunta y se declara.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leerForjaDeclarada, declararForja, forjaDeRemoto, detectarDeclarada } from '../bin/lib/forja-propia.mjs';

// git config simulado: `valores` = { 'clave': 'valor' } con prefijo 'repo:' o 'global:'.
function gitSimulado(valores = {}) {
  const escritos = [];
  const git = (args) => {
    const global = args.includes('--global');
    const clave = args[args.length - 1];
    if (args.includes('--get')) return valores[`${global ? 'global' : 'repo'}:${clave}`] ?? null;
    escritos.push(args);
    return '';
  };
  return { git, escritos };
}
const noPreguntes = async () => { throw new Error('no debe preguntar'); };

test('leerForjaDeclarada: faro.forja del repo manda sobre la del servidor', () => {
  const { git } = gitSimulado({ 'repo:faro.forja': 'github', 'global:faro.git.empresa.com.forja': 'gitlab' });
  assert.equal(leerForjaDeclarada('git.empresa.com', { dir: '/repo', git }), 'github');
});

test('leerForjaDeclarada: sin clave en el repo, vale la del servidor', () => {
  const { git } = gitSimulado({ 'global:faro.git.empresa.com.forja': 'GitLab' });
  assert.equal(leerForjaDeclarada('Git.Empresa.com', { dir: '/repo', git }), 'gitlab');
});

test('leerForjaDeclarada: un valor que no es una forja se ignora', () => {
  const { git } = gitSimulado({ 'repo:faro.forja': 'bitbucket' });
  assert.equal(leerForjaDeclarada('git.empresa.com', { dir: '/repo', git }), null);
});

test('declararForja: escribe la clave global del servidor', () => {
  const { git, escritos } = gitSimulado();
  declararForja('Git.Empresa.com', 'gitlab', { git });
  assert.deepEqual(escritos, [['config', '--global', 'faro.git.empresa.com.forja', 'gitlab']]);
  assert.throws(() => declararForja('git.empresa.com', 'otra', { git }), /github o gitlab/);
});

test('forjaDeRemoto: un host público no lee ni pregunta nada', async () => {
  const git = () => { throw new Error('no debe leer git config'); };
  const f = await forjaDeRemoto('git@gitlab.com:grupo/app.git', { git, elegir: noPreguntes });
  assert.equal(f.forja, 'gitlab');
  assert.equal(f.selfHosted, false);
});

test('forjaDeRemoto: un servidor declarado se reconoce sin preguntar', async () => {
  const { git } = gitSimulado({ 'global:faro.git.empresa.com.forja': 'github' });
  const f = await forjaDeRemoto('https://git.empresa.com/equipo/app.git', { dir: '/repo', git, elegir: noPreguntes });
  assert.equal(f.forja, 'github');
  assert.equal(f.selfHosted, true);
  assert.equal(f.declarada, true);
});

test('forjaDeRemoto: un servidor sin declarar se pregunta y queda declarado', async () => {
  const { git, escritos } = gitSimulado();
  let opciones = null;
  const f = await forjaDeRemoto('https://gitlab.evil.com/equipo/sub/app.git', { git, elegir: async (host, ops) => { opciones = Object.keys(ops); return 'gitlab'; } });
  assert.deepEqual(opciones, ['github', 'gitlab', '__ninguna']);
  assert.equal(f.forja, 'gitlab');
  assert.equal(f.path, 'equipo/sub/app');
  assert.deepEqual(escritos, [['config', '--global', 'faro.gitlab.evil.com.forja', 'gitlab']]);
});

test('forjaDeRemoto: sin terminal o si no se elige, queda desconocida y no se declara nada', async () => {
  const { git, escritos } = gitSimulado();
  assert.equal((await forjaDeRemoto('https://git.x.com/a/b.git', { git })).forja, 'desconocida');
  assert.equal((await forjaDeRemoto('https://git.x.com/a/b.git', { git, elegir: async () => '__ninguna' })).forja, 'desconocida');
  assert.deepEqual(escritos, []);
});

test('detectarDeclarada: aplica la declaración sin preguntar nunca', () => {
  const { git } = gitSimulado({ 'repo:faro.forja': 'gitlab' });
  assert.equal(detectarDeclarada('https://git.empresa.com/g/app.git', { dir: '/repo', git }).forja, 'gitlab');
  assert.equal(detectarDeclarada('https://git.otra.com/g/app.git', { git: gitSimulado().git }).forja, 'desconocida');
});
