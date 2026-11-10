// Reconocer QUE ES un repo que aun no usa FARO, para poder proponer algo con criterio.
//
// Historia de esto: el harness YA analizaba el repo al arrancar, y el analisis era util. Lo que
// sobraba era DONDE se hacia — bloqueando el hilo principal — y que ademas ordenara crear ESTADO.md
// antes de cualquier otra cosa. La correccion no fue dejar de analizar: fue mover el analisis al
// vigilante en background, que ya sabia despertar al agente con exit 2.
//
// Lo que estos tests fijan es que el retrato sea DESCRIPTIVO. Su salida acaba en el contexto del
// modelo, y ahi una frase imperativa se ejecuta aunque nadie la haya pedido — que es exactamente
// como empezo el problema original.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { reconocer, retrato } = require(path.join(HOOKS, 'lib', 'reconocer.js'));

const WORKER = ['wrangler.toml', 'package.json', 'src/index.js', 'src/handlers.js',
  'test/api.test.js', '.github/workflows/ci.yml', 'README.md', 'LICENSE'];

// ---------- lo que ve ----------

test('reconoce el stack, y el mas especifico primero', () => {
  const r = reconocer(WORKER);
  // Un Worker tambien tiene package.json: decir solo "Node" seria perder la mitad del dato.
  assert.strictEqual(r.stacks[0], 'Cloudflare Workers', JSON.stringify(r.stacks));
  assert.ok(r.stacks.includes('Node'));
});

test('ve lo que el repo YA trae: adoptar uno con CI y tests no es como adoptar uno sin nada', () => {
  const r = reconocer(WORKER);
  for (const s of ['CI configurado', 'tests', 'README', 'licencia']) {
    assert.ok(r.senales.includes(s), `falta '${s}': ${JSON.stringify(r.senales)}`);
  }
});

test('la estructura de primer nivel da la FORMA mejor que cualquier heuristica', () => {
  assert.deepStrictEqual(reconocer(WORKER).carpetas, ['.github', 'src', 'test']);
});

// Contar node_modules daria "40.000 ficheros" y el retrato no diria nada de nadie.
test('no cuenta dependencias ni artefactos de build', () => {
  const r = reconocer([...WORKER, 'node_modules/x/index.js', 'dist/bundle.js', '.git/config']);
  assert.strictEqual(r.ficheros, WORKER.length, 'se colo basura en la cuenta');
});

test('un repo sin marcadores no se inventa un stack', () => {
  const r = reconocer(['notas.txt', 'fotos/a.png']);
  assert.deepStrictEqual(r.stacks, []);
});

// ---------- lo que dice ----------

test('el retrato cuenta stack, tamano e historia', () => {
  const t = retrato(reconocer(WORKER, { commits: 412, autores: 3, desde: '2024-01-15' }));
  assert.match(t, /Cloudflare Workers/);
  assert.match(t, /412 commit/);
  assert.match(t, /2024-01-15/, 'un repo con anos de historia no se adopta igual que uno de ayer');
});

// Esto es lo que NO puede volver a pasar: el problema original fue una directiva imperativa
// inyectada en el contexto, que el agente ejecutaba aunque el usuario viniera a otra cosa.
test('es DESCRIPTIVO: no ordena, no da nada por pendiente', () => {
  const t = retrato(reconocer(WORKER));
  assert.ok(!/OBLIGATORIO/i.test(t), t);
  assert.ok(!/antes de cualquier otra tarea/i.test(t), t);
  assert.match(t, /NO hay que arreglarlo/, 'tiene que decir explicitamente que no es una tarea');
  assert.match(t, /NO crees nada/, t);
});

test('deja claro que no ha tocado nada (es lo que el usuario necesita saber)', () => {
  assert.match(retrato(reconocer(WORKER)), /sin tocar nada/i);
});

test('ofrece /faro:adoptar UNA vez, como camino, no como deber', () => {
  const t = retrato(reconocer(WORKER));
  assert.match(t, /faro:adoptar/);
  assert.match(t, /Si el usuario quiere/, 'condicional, no imperativo');
});

test('un repo ya adoptado no recibe la oferta', () => {
  const t = retrato(reconocer(WORKER), { adoptado: true });
  assert.ok(!/faro:adoptar/.test(t), t);
  assert.match(t, /Cloudflare Workers/, 'pero el retrato sigue siendo util');
});

// Un repo vacio no merece un parrafo: hablar por hablar es como se ensena a ignorar los avisos.
test('sin ficheros no dice nada', () => {
  assert.strictEqual(retrato(reconocer([])), null);
  assert.strictEqual(retrato(null), null);
});
