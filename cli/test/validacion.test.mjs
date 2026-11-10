// #289 US-3: el wizard pregunta dónde se validan los PR/MR (CI de la forja, local o los dos).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  recomendarValidacion, opcionesValidacion, rutaCi, generarCi, guardarValidacion, consultaCi, modoDesdeFlag, rutaHarnessCache, exigirPipeline,
} from '../bin/lib/validacion.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'faro-validacion-'));

test('recomienda local en un repo privado con plan gratuito y explica que el CI sería solo informativo', () => {
  const r = recomendarValidacion({ publico: false, dePago: false });
  assert.equal(r.modo, 'local');
  assert.match(r.motivo, /informativo/i);
  assert.match(r.motivo, /minutos/i);
});

test('recomienda el CI de la forja si el repo es público o el plan es de pago', () => {
  assert.equal(recomendarValidacion({ publico: true, dePago: false }).modo, 'ci');
  assert.equal(recomendarValidacion({ publico: false, dePago: true }).modo, 'ci');
});

test('las opciones ponen la recomendada primero y explican los minutos y qué pasa si se agotan', () => {
  const ops = opcionesValidacion({ publico: false, dePago: false });
  const claves = Object.keys(ops);
  assert.equal(claves[0], 'local');
  assert.deepEqual([...claves].sort(), ['ambos', 'ci', 'local']);
  assert.match(ops.local.etiqueta, /Recomendado/);
  assert.match(ops.ci.explica, /minutos/i);
  assert.match(ops.ci.explica, /agot/i);
  assert.ok(!/Recomendado/.test(ops.ci.etiqueta));
});

test('rutaCi por forja', () => {
  assert.equal(rutaCi('gitlab'), '.gitlab-ci.yml');
  assert.equal(rutaCi('github'), '.github/workflows/ci.yml');
  assert.equal(rutaCi('otra'), null);
});

test('modoDesdeFlag acepta ci/local/ambos y rechaza lo demás', () => {
  assert.equal(modoDesdeFlag('CI'), 'ci');
  assert.equal(modoDesdeFlag('ambos'), 'ambos');
  assert.equal(modoDesdeFlag('nube'), null);
  assert.equal(modoDesdeFlag(undefined), null);
  assert.equal(consultaCi('local'), false);
  assert.equal(consultaCi('ambos'), true);
});

test('generarCi: CI ya existente -> no se sobrescribe ni se llama al motor', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(d, '.github', 'workflows', 'ci.yml'), 'mio\n');
  let llamado = false;
  const r = generarCi(d, { forja: 'github', harness: path.join(d, 'h.js'), ejecutar: () => { llamado = true; } });
  assert.equal(r.estado, 'existe');
  assert.equal(r.ruta, '.github/workflows/ci.yml');
  assert.equal(llamado, false);
  assert.equal(fs.readFileSync(path.join(d, '.github', 'workflows', 'ci.yml'), 'utf8'), 'mio\n');
});

test('generarCi: en GitLab el motor escribe .gitlab-ci.yml -> creado', () => {
  const d = tmp();
  const harness = path.join(d, 'harness.js'); fs.writeFileSync(harness, '');
  const r = generarCi(d, {
    forja: 'gitlab', harness,
    ejecutar: (h, args, cwd) => { assert.equal(h, harness); assert.deepEqual(args, ['ci']); fs.writeFileSync(path.join(cwd, '.gitlab-ci.yml'), 'stages: [test]\n'); },
  });
  assert.equal(r.estado, 'creado');
  assert.equal(r.ruta, '.gitlab-ci.yml');
});

test('generarCi: sin gates el motor no escribe nada -> sin-gates; sin motor -> sin-motor', () => {
  const d = tmp();
  const harness = path.join(d, 'harness.js'); fs.writeFileSync(harness, '');
  assert.equal(generarCi(d, { forja: 'gitlab', harness, ejecutar: () => {} }).estado, 'sin-gates');
  assert.equal(generarCi(d, { forja: 'gitlab', harness: path.join(d, 'no-existe.js'), ejecutar: () => {} }).estado, 'sin-motor');
  assert.equal(generarCi(d, { forja: 'gitlab', harness, ejecutar: () => { throw new Error('boom'); } }).estado, 'sin-gates');
});

test('guardarValidacion fusiona en .faro.json sin perder lo que había', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, '.faro.json'), JSON.stringify({ domain: 'x', teams: ['a'] }));
  guardarValidacion(d, 'ci');
  const m = JSON.parse(fs.readFileSync(path.join(d, '.faro.json'), 'utf8'));
  assert.deepEqual(m, { domain: 'x', teams: ['a'], validacion: 'ci' });
  assert.throws(() => guardarValidacion(d, 'nube'));
});

test('rutaHarnessCache: la última versión del plugin en la caché', () => {
  const home = tmp();
  const base = path.join(home, '.claude', 'plugins', 'cache', 'faro-marketplace', 'faro');
  for (const v of ['1.1.9', '1.1.27', '1.1.3']) { fs.mkdirSync(path.join(base, v, 'hooks'), { recursive: true }); fs.writeFileSync(path.join(base, v, 'hooks', 'harness.js'), ''); }
  assert.equal(rutaHarnessCache(home), path.join(base, '1.1.27', 'hooks', 'harness.js'));
  assert.equal(rutaHarnessCache(tmp()), null);
});

test('exigirPipeline: solo con CI en el repo; GitLab por API en todo plan, GitHub solo de pago o público y como paso a mano', () => {
  assert.equal(exigirPipeline({ forja: 'gitlab', ci: 'sin-gates' }).accion, null);
  assert.equal(exigirPipeline({ forja: 'gitlab', ci: 'creado' }).accion, 'api');
  assert.equal(exigirPipeline({ forja: 'github', ci: 'creado', dePago: false, publico: false }).accion, null);
  assert.match(exigirPipeline({ forja: 'github', ci: 'creado', dePago: false, publico: false }).aviso, /plan/i);
  assert.equal(exigirPipeline({ forja: 'github', ci: 'existe', dePago: true }).accion, 'indicar');
});

// Adaptadores: plan del destino y «el pipeline debe pasar».
import { FORJA_GITHUB } from '../bin/lib/forjas/github.mjs';
import { FORJA_GITLAB } from '../bin/lib/forjas/gitlab.mjs';
const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body), headers: new Map() });
const grabar = (status, body) => { const llamadas = []; return { llamadas, fetchImpl: async (url, init = {}) => { llamadas.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null }); return res(status, body); } }; };

test('GitHub alta.plan: org por /orgs, personal por /user; free no es de pago', async () => {
  const g = grabar(200, { plan: { name: 'team' } });
  assert.deepEqual(await FORJA_GITHUB.alta.plan({ host: 'github.com', token: 'T' }, { org: 'acme', personal: false }, { fetchImpl: g.fetchImpl }), { nombre: 'team', dePago: true });
  assert.equal(g.llamadas[0].url, 'https://api.github.com/orgs/acme');
  const u = grabar(200, { plan: { name: 'free' } });
  assert.deepEqual(await FORJA_GITHUB.alta.plan({ host: 'github.com', token: 'T' }, { org: 'ana', personal: true }, { fetchImpl: u.fetchImpl }), { nombre: 'free', dePago: false });
  assert.equal(u.llamadas[0].url, 'https://api.github.com/user');
  const x = grabar(404, {});
  assert.deepEqual(await FORJA_GITHUB.alta.plan({ host: 'github.com', token: 'T' }, { org: 'acme' }, { fetchImpl: x.fetchImpl }), { nombre: null, dePago: false });
});

test('GitLab alta.plan por namespace; exigirPipeline activa only_allow_merge_if_pipeline_succeeds', async () => {
  const g = grabar(200, { plan: 'premium' });
  assert.deepEqual(await FORJA_GITLAB.alta.plan({ host: 'gitlab.com', token: 'T' }, { org: 'acme/equipo' }, { fetchImpl: g.fetchImpl }), { nombre: 'premium', dePago: true });
  assert.equal(g.llamadas[0].url, 'https://gitlab.com/api/v4/namespaces/acme%2Fequipo');
  const f = grabar(200, { plan: 'free' });
  assert.equal((await FORJA_GITLAB.alta.plan({ host: 'gitlab.com', token: 'T' }, { org: 'ana' }, { fetchImpl: f.fetchImpl })).dePago, false);
  const e = grabar(200, {});
  await FORJA_GITLAB.alta.exigirPipeline({ host: 'gitlab.com', token: 'T' }, 'acme/informe', { fetchImpl: e.fetchImpl });
  assert.equal(e.llamadas[0].url, 'https://gitlab.com/api/v4/projects/acme%2Finforme');
  assert.equal(e.llamadas[0].method, 'PUT');
  assert.deepEqual(e.llamadas[0].body, { only_allow_merge_if_pipeline_succeeds: true });
});
