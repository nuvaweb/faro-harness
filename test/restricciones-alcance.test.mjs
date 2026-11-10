// RESTRICCIONES DE ALCANCE (#150): el agente solo modifica el repo de la sesion y sus worktrees; en un
// repo ajeno la via es abrir un ISSUE; la forja solo se toca en la organizacion del remoto de la
// sesion; leer repos ajenos esta permitido. Repos git temporales: propio, ajeno (misma org), de otra
// organizacion, worktree del propio y carpeta sin git.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');
const A = createRequire(import.meta.url)(path.join(HOOKS, 'lib', 'alcance.js'));
const { esOrdenInocua } = createRequire(import.meta.url)(path.join(HOOKS, 'lib', 'orden-inocua.js'));

let TMP, PROPIO, WT, AJENO, EXT, CFG, SINGIT, SUBMODULO_FALSO;
const git = (cwd, ...a) => execFileSync('git', a, { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function repo(dir, remoto, rama = 'feat/base') {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', rama);
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'Prueba');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), '# prueba\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'inicial');
  if (remoto) git(dir, 'remote', 'add', 'origin', remoto);
}
const barras = (p) => p.replace(/\\/g, '/');

before(() => {
  TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'faro-alcance-')));
  PROPIO = path.join(TMP, 'propio');
  AJENO = path.join(TMP, 'ajeno');
  EXT = path.join(TMP, 'externo');
  CFG = path.join(TMP, 'conconfig');
  SINGIT = path.join(TMP, 'carpeta-sin-git');
  repo(PROPIO, 'https://github.com/acme/propio.git');
  repo(AJENO, 'https://github.com/acme/otro.git');
  repo(EXT, 'https://github.com/zeta/ext.git');
  repo(CFG, 'https://github.com/acme/conconfig.git');
  fs.writeFileSync(path.join(CFG, '.faro.json'), JSON.stringify({ alcance: { repos_permitidos: ['acme/otro'] } }));
  fs.mkdirSync(SINGIT, { recursive: true });
  WT = path.join(TMP, 'propio-wt');
  git(PROPIO, 'worktree', 'add', '-q', '-b', 'feat/wt', WT);
});
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

// ───────────────────────── lib/alcance.js ─────────────────────────

test('repoDeRuta: raiz del repo que contiene la ruta, tambien si la ruta aun no existe; null fuera de repos', () => {
  assert.strictEqual(path.resolve(A.repoDeRuta(path.join(PROPIO, 'src', 'nuevo', 'a.js'))), PROPIO);
  assert.strictEqual(path.resolve(A.repoDeRuta(path.join(WT, 'README.md'))), WT);
  assert.strictEqual(A.repoDeRuta(path.join(SINGIT, 'x.txt')) , null);
});

test('mismoRepo compara el git-common-dir: un worktree es el mismo repo, otro repo no', () => {
  assert.strictEqual(A.mismoRepo(PROPIO, WT), true);
  assert.strictEqual(A.mismoRepo(path.join(WT, 'x'), PROPIO), true);
  assert.strictEqual(A.mismoRepo(PROPIO, AJENO), false);
  assert.strictEqual(A.mismoRepo(PROPIO, SINGIT), false);
});

test('esRutaAjena: otro repo si; propio, su worktree y carpetas sin git no', () => {
  assert.strictEqual(A.esRutaAjena(PROPIO, path.join(AJENO, 'x.md')), true);
  assert.strictEqual(A.esRutaAjena(PROPIO, path.join(AJENO, 'nueva', 'carpeta', 'x.md')), true);
  assert.strictEqual(A.esRutaAjena(PROPIO, path.join(PROPIO, 'x.md')), false);
  assert.strictEqual(A.esRutaAjena(PROPIO, path.join(WT, 'x.md')), false);
  assert.strictEqual(A.esRutaAjena(PROPIO, path.join(SINGIT, 'x.md')), false);
  assert.strictEqual(A.esRutaAjena(PROPIO, path.join(os.homedir(), '.claude', 'projects', 'm', 'memory', 'MEMORY.md')), false);
  assert.strictEqual(A.esRutaAjena(SINGIT, path.join(AJENO, 'x.md')), false, 'una sesion fuera de git no tiene repo que acotar');
});

test('esRutaAjena: evasiones (.. relativo, barras y mayusculas de Windows)', () => {
  assert.strictEqual(A.esRutaAjena(PROPIO, '../ajeno/x.md'), true);
  assert.strictEqual(A.esRutaAjena(PROPIO, 'src/../../ajeno/x.md'), true);
  assert.strictEqual(A.esRutaAjena(PROPIO, `src/../${path.basename(PROPIO)}/x.md`), false, 'el .. que vuelve al propio repo no es evasion');
  assert.strictEqual(A.esRutaAjena(PROPIO, `${barras(AJENO)}/x.md`), true);
  if (process.platform === 'win32') {
    assert.strictEqual(A.esRutaAjena(PROPIO, path.join(AJENO, 'x.md').toUpperCase().replace(/\//g, '\\')), true);
    assert.strictEqual(A.esRutaAjena(PROPIO.toUpperCase(), path.join(PROPIO, 'x.md').toLowerCase()), false, 'mayusculas distintas del MISMO repo no son ajenas');
  }
});

test('organizacionDelRemoto / esOrganizacionPropia', () => {
  assert.strictEqual(A.organizacionDelRemoto(PROPIO), 'acme');
  assert.strictEqual(A.organizacionDelRemoto(WT), 'acme');
  assert.strictEqual(A.organizacionDelRemoto(SINGIT), null);
  assert.strictEqual(A.esOrganizacionPropia(PROPIO, 'ACME'), true);
  assert.strictEqual(A.esOrganizacionPropia(PROPIO, 'zeta'), false);
  assert.strictEqual(A.esOrganizacionPropia(SINGIT, 'acme'), false);
});

test('.faro.json > alcance.repos_permitidos autoriza un repo hermano concreto (y solo ese)', () => {
  assert.strictEqual(A.esRutaAjena(CFG, path.join(AJENO, 'x.md')), false);
  assert.strictEqual(A.esRutaAjena(CFG, path.join(EXT, 'x.md')), true);
  assert.strictEqual(A.esRutaAjena(PROPIO, path.join(AJENO, 'x.md')), true, 'sin la config sigue siendo ajeno');
});

test('validarConfig avisa de alcance mal formado y calla si esta bien', () => {
  const t = fs.mkdtempSync(path.join(TMP, 'cfg-'));
  const escribe = (o) => fs.writeFileSync(path.join(t, '.faro.json'), JSON.stringify(o));
  escribe({ alcance: { repos_permitidos: ['acme/otro'] } });
  assert.deepStrictEqual(A.validarConfig(t), []);
  escribe({});
  assert.deepStrictEqual(A.validarConfig(t), []);
  escribe({ alcance: { repos_permitidos: ['sin-barra', 3] } });
  assert.strictEqual(A.validarConfig(t).length, 2);
  escribe({ alcance: { otra: 1 } });
  assert.match(A.validarConfig(t)[0], /alcance\.otra/);
  escribe({ alcance: 'x' });
  assert.match(A.validarConfig(t)[0], /objeto/);
});

// Ordenes: [orden, ¿bloquea?]. Se escriben contra rutas absolutas temporales.
const q = (p) => `"${p}"`;
test('analizarComando: ESCRITURAS hacia otro repo se bloquean', () => {
  const x = barras(AJENO);
  const bloquean = [
    `git -C ${x} commit -m x`,
    `git -C ${q(x)} commit -m x`,
    `git -C '${x}' push origin main`,
    `git -C ../ajeno add -A`,
    `git -C ../ajeno rm README.md`,
    `git -C ../ajeno mv a b`,
    `git -C ../ajeno checkout -- README.md`,
    `git -C ../ajeno checkout -b otra`,
    `git -C ../ajeno reset --hard`,
    `git -C ../ajeno stash`,
    `git -C ../ajeno branch -D x`,
    `git -C ../ajeno fetch`,
    `git -C ../ajeno config user.name x`,
    `git -C ../ajeno -c user.name=x commit -m y`,
    `git --no-pager -C ../ajeno commit -m y`,
    `git -C../ajeno commit -m y`,
    `git --git-dir=${x}/.git --work-tree=${x} commit -m x`,
    `git --git-dir ${x}/.git commit -m x`,
    `git --work-tree=${x} add -A`,
    `GIT_DIR=${x}/.git git commit -m x`,
    `cd ${x} && git commit -m x`,
    `cd ${q(x)} && git add -A && git commit -m x`,
    `cd ../ajeno; git push`,
    `cd ../ajeno && echo hola > nuevo.txt`,
    `(cd ../ajeno && git commit -m x)`,
    `echo hola > ${x}/nuevo.txt`,
    `echo hola >> ../ajeno/nuevo.txt`,
    `echo hola 2>&1 > ${x}/nuevo.txt`,
    `cat <<'EOF' > ../ajeno/nuevo.txt\nhola\nEOF`,
    `bash -c "git -C ../ajeno commit -m x"`,
    `sh -c 'cd ../ajeno && git commit -m x'`,
    `echo $(git -C ../ajeno commit -m x)`,
    `ls && git -C ../ajeno push`,
    `git -C ../externo commit -m x`,
  ];
  for (const c of bloquean) {
    const b = A.analizarComando(c, PROPIO);
    assert.ok(b, `deberia frenarse: ${c}`);
    assert.strictEqual(b.nivel, 'deny', `nivel de: ${c}`);
  }
});

test('analizarComando: git con -C/--git-dir/--work-tree no resoluble y escritura PIDE CONFIRMACION (ask, no allow)', () => {
  for (const c of ['git -C "$D" commit -m x', 'git -C $(pwd)/../ajeno commit -m x', 'git --git-dir="$X" push', 'git --work-tree=$W add -A', 'git -C `echo ../ajeno` commit -m x']) {
    const b = A.analizarComando(c, PROPIO);
    assert.ok(b, `deberia fallar cerrado: ${c}`);
    assert.strictEqual(b.nivel, "ask"); assert.match(b.tipo, /git/);
  }
  // Pero una LECTURA ambigua no estorba.
  assert.strictEqual(A.analizarComando('git -C "$D" log --oneline', PROPIO), null);
});

test('analizarComando: LECTURAS de repos ajenos y todo lo propio pasan', () => {
  const x = barras(AJENO);
  const pasan = [
    `git -C ${x} log --oneline`,
    `git -C ${q(x)} status`,
    `git -C ../ajeno diff HEAD~1`,
    `git -C ../ajeno show HEAD`,
    `git -C ../ajeno branch`,
    `git -C ../ajeno branch -a`,
    `git -C ../ajeno remote -v`,
    `git -C ../ajeno ls-files`,
    `git --git-dir=${x}/.git log`,
    `cd ../ajeno && git log && git status && git diff`,
    `cd ../ajeno && cat README.md && ls`,
    `cat ../ajeno/README.md`,
    `ls ../ajeno`,
    `grep -rn x ../ajeno`,
    `cp ../ajeno/README.md copia.md`,
    `git commit -m x`,
    `git add -A && git commit -m "git -C ../ajeno commit"`,
    `git -C ${barras(PROPIO)} commit -m x`,
    `git -C ${barras(WT)} commit -m x`,
    `cd ${barras(WT)} && git commit -m x`,
    `cd ../ajeno && cd ../propio && git commit -m x`,
    `(cd ../ajeno && git log); git commit -m x`,
    `echo hola > nuevo.txt`,
    `echo hola > ${barras(WT)}/nuevo.txt`,
    `echo hola > ${barras(SINGIT)}/nuevo.txt`,
    `echo hola > /dev/null 2>&1`,
    `npm test 2>&1 | tail -5`,
    `echo "a > ../ajeno/f"`,
    `echo 'git -C ../ajeno commit'`,
    `git commit -m 'cd ../ajeno && git push'`,
    `cat <<'EOF' > nota.txt\ngit -C ../ajeno commit -m x\necho hola > ../ajeno/f\nEOF`,
    `git commit -m "$(cat <<'EOF'\ngit -C ../ajeno commit\nEOF\n)"`,
    `rm -rf ${barras(SINGIT)}/x`,
    `touch ../carpeta-sin-git/a.txt`,
    `cd ../carpeta-sin-git && touch a.txt`,
    `git -C ../carpeta-sin-git status`,
    'git',
    'git --version',
    'ls -la',
    'node -v',
  ];
  for (const c of pasan) assert.strictEqual(A.analizarComando(c, PROPIO), null, `no deberia bloquearse: ${c}`);
});

test('analizarComando: un hermano autorizado en .faro.json se puede escribir', () => {
  assert.strictEqual(A.analizarComando('git -C ../ajeno commit -m x', CFG), null);
  assert.ok(A.analizarComando('git -C ../externo commit -m x', CFG));
});

test('esLecturaGit: lista cerrada y minima, sin opciones que escriban o ejecuten', () => {
  for (const v of ['status', 'log', 'diff', 'show', 'rev-parse', 'branch', 'ls-files', 'remote', 'describe']) assert.strictEqual(A.esLecturaGit(v, []), true, v);
  for (const v of ['grep', 'cat-file', 'blame', 'config', 'stash', 'tag', 'fetch', 'archive', 'bundle', 'format-patch', 'inventado', 'commit', 'worktree']) assert.strictEqual(A.esLecturaGit(v, []), false, v);
  for (const [v, args] of [
    ['log', ['--output=x.txt']], ['log', ['--output', 'x']], ['diff', ['--output=x']], ['show', ['-o', 'x']], ['show', ['-ox']], ['diff', ['-O', 'ord']], ['diff', ['--ext-diff']], ['log', ['--textconv']],
    ['diff', ['--no-index', 'a', 'b']], ['log', ['--exec=x']], ['status', ['--open-files-in-pager']], ['log', ['--upload-pack=x']], ['log', ['--git-dir=/x']], ['log', ['-c', 'a=b']],
    ['log', ['--file', 'x']], ['log', ['--pager=x']], ['log', ['--help']], ['log', ['>', 'x']], ['branch', ['-D', 'x']], ['branch', ['nueva']], ['branch', ['-m', 'a', 'b']],
    ['remote', ['add', 'x', 'u']], ['remote', ['set-url', 'x', 'u']], ['remote', ['show', 'origin']],
  ]) assert.strictEqual(A.esLecturaGit(v, args), false, v + ' ' + args.join(' '));
  assert.strictEqual(A.esLecturaGit('log', ['--oneline', '-5', '--', 'src']), true);
  assert.strictEqual(A.esLecturaGit('branch', ['-a']), true);
});

test('la via temprana de orden-inocua nunca decide sobre estas ordenes (todas siguen el camino completo)', () => {
  for (const c of ['git -C ../ajeno commit', 'cd ../ajeno && git commit', 'echo x > ../ajeno/f', 'ls ../ajeno', 'ls "../ajeno"', 'rm ../ajeno/x', 'git -C ../ajeno log']) {
    assert.strictEqual(esOrdenInocua(c), false, `se colaria por la via temprana: ${c}`);
  }
});

test('evaluarGh: otra organizacion se rechaza; lecturas libres dentro de la org', () => {
  const s = { org: 'acme', repo: 'propio' };
  const ok = [
    ['repos/acme/propio/issues/1'], ['repos/acme/otro/issues'], ['repos/ACME/otro/pulls?state=open'], ['/repos/acme/otro/contents/x'],
    ['repos/acme/propio/pulls', 'POST'], ['repos/acme/propio/issues/3', 'PATCH'], ['repos/acme/propio/git/refs', 'POST'],
    ['repos/acme/otro/issues', 'POST'], ['repos/acme/otro/issues/7/comments', 'POST'],
    ['orgs/acme/members'], ['user'], ['search/issues?q=org:zeta'], ['graphql', 'POST', '{"query":"{ viewer { login } }"}'],
    ['https://api.github.com/repos/acme/otro/issues', 'GET'],
  ];
  for (const [p, m, cuerpo] of ok) assert.strictEqual(A.evaluarGh(p, m, s, { cuerpo, apiBase: 'https://api.github.com/' }), null, `deberia permitirse: ${p} ${m || ''}`);
  const no = [
    ['repos/zeta/ext/issues'], ['repos/zeta/ext/issues', 'POST'], ['repos/ZETA/ext/pulls'], ['/repos/zeta/ext'], ['orgs/zeta/repos'],
    ['repos/acme/otro/pulls', 'POST'], ['repos/acme/otro/issues/7', 'PATCH'], ['repos/acme/otro/contents/x.md', 'PUT'], ['repos/acme/otro', 'DELETE'],
    ['repos/acme/otro/issues', 'PUT'], ['repos/acme/otro/issues/7/labels', 'POST'], ['repos/acme/otro/git/refs', 'POST'],
    ['repos/acme/propio/../../zeta/ext/issues'], ['repos/acme/%2e%2e/zeta/ext/issues'], ['repos//zeta/ext/issues'], ['repos\\zeta\\ext\\issues'],
    ['repos/acme%2Fzeta/ext'], ['repositories/123/issues', 'POST'],
    ['https://api.github.com/repos/zeta/ext/issues', 'GET'], ['https://evil.example/repos/acme/otro/issues', 'GET'],
    ['graphql', 'POST', '{"query":"mutation { addComment(input:{}) { clientMutationId } }"}'],
  ];
  for (const [p, m, cuerpo] of no) assert.ok(A.evaluarGh(p, m, s, { cuerpo, apiBase: 'https://api.github.com/' }), `deberia rechazarse: ${p} ${m || ''}`);
  assert.ok(A.evaluarGh('repos/acme/propio/issues', 'GET', null), 'sin remoto no se sabe la org: falla cerrado');
  assert.strictEqual(A.evaluarGh('repos/acme/hermano/pulls', 'POST', s, { permitidos: ['acme/hermano'] }), null, 'hermano autorizado en .faro.json');
});

test('parsearRepoArg: patron, misma organizacion y repo de la sesion', () => {
  assert.deepStrictEqual(A.parsearRepoArg('acme/otro', PROPIO), { ok: true, org: 'acme', repo: 'otro', esSesion: false });
  assert.strictEqual(A.parsearRepoArg('acme/propio', PROPIO).esSesion, true);
  for (const mal of ['otro', 'a/b/c', 'acme/', '/otro', 'acme/o tro', 'acme/otro;rm', '../x', '']) assert.ok(A.parsearRepoArg(mal, PROPIO).error, `patron invalido: ${mal}`);
  assert.match(A.parsearRepoArg('zeta/ext', PROPIO).error, /organizacion/);
  assert.ok(A.parsearRepoArg('acme/otro', SINGIT).error);
});

// ───────────────────────── hooks reales ─────────────────────────

function hook(cmd, root, input, extraEnv = {}) {
  const r = spawnSync(process.execPath, [HARNESS, cmd, ...(extraEnv.__args || [])], {
    cwd: root, input: JSON.stringify(input), encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  let o = null;
  if (r.stdout && r.stdout.trim()) { try { o = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { o = null; } }
  return o;
}
const decision = (o) => (o && o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision) || null;
const razon = (o) => (o && o.hookSpecificOutput && o.hookSpecificOutput.permissionDecisionReason) || '';
const preDoc = (root, file_path) => hook('pre-doc', root, { tool_name: 'Write', tool_input: { file_path, content: 'x' } });
const preBash = (root, command) => hook('pre-bash', root, { tool_name: 'Bash', tool_input: { command } });

test('pre-doc: escribir en un repo ajeno se bloquea y propone el issue', () => {
  const o = preDoc(PROPIO, path.join(AJENO, 'x.md'));
  assert.strictEqual(decision(o), 'deny');
  assert.match(razon(o), /acme\/otro/);
  assert.match(razon(o), /no de esta sesi/);
  assert.match(razon(o), /asignar-tarea/);
  assert.match(razon(o), /--repo acme\/otro/);
});

test('pre-doc: evasiones (.. relativo, fichero nuevo en carpeta inexistente, barras/mayusculas de Windows)', () => {
  assert.strictEqual(decision(preDoc(PROPIO, '../ajeno/x.md')), 'deny');
  assert.strictEqual(decision(preDoc(PROPIO, 'src/../../ajeno/x.md')), 'deny');
  assert.strictEqual(decision(preDoc(PROPIO, path.join(AJENO, 'a', 'b', 'c', 'x.md'))), 'deny');
  assert.strictEqual(decision(preDoc(PROPIO, barras(path.join(AJENO, 'x.md')))), 'deny');
  if (process.platform === 'win32') assert.strictEqual(decision(preDoc(PROPIO, path.join(AJENO, 'x.md').toUpperCase())), 'deny');
});

test('pre-doc: el propio repo, su worktree, carpetas sin git y la config de Claude NO se bloquean', () => {
  for (const f of [path.join(PROPIO, 'src', 'a.txt'), path.join(WT, 'src', 'a.txt'), path.join(SINGIT, 'a.txt'), path.join(os.tmpdir(), 'faro-alcance-suelto.txt'), path.join(os.homedir(), '.claude', 'projects', 'x', 'memory', 'm.md')]) {
    const o = preDoc(PROPIO, f);
    assert.ok(!/no de esta sesi/.test(razon(o)), `no deberia ser alcance: ${f} -> ${razon(o)}`);
  }
});

test('pre-doc: un hermano autorizado en .faro.json no se bloquea; otra organizacion si', () => {
  assert.ok(!/no de esta sesi/.test(razon(preDoc(CFG, path.join(AJENO, 'x.md')))));
  assert.strictEqual(decision(preDoc(CFG, path.join(EXT, 'x.md'))), 'deny');
});

test('hooks.json: pre-doc tambien cubre MultiEdit', () => {
  const h = JSON.parse(fs.readFileSync(path.join(HOOKS, 'hooks.json'), 'utf8'));
  const entrada = h.hooks.PreToolUse.find((e) => e.hooks.some((x) => /harness\.js"? pre-doc$/.test(x.command)));
  assert.ok(entrada && /MultiEdit/.test(entrada.matcher), `matcher: ${entrada && entrada.matcher}`);
});

test('pre-bash: escrituras hacia otro repo se bloquean con el issue como via', () => {
  for (const c of [`git -C ${q(barras(AJENO))} commit -m x`, `cd ${barras(AJENO)} && git commit -m x`, `echo hola > ${barras(AJENO)}/f.txt`]) {
    const o = preBash(PROPIO, c);
    assert.strictEqual(decision(o), 'deny', `deberia bloquearse: ${c}`);
    assert.match(razon(o), /asignar-tarea/);
  }
  assert.match(razon(preBash(PROPIO, `git -C ${barras(AJENO)} push`)), /acme\/otro/);
});

test('pre-bash: lecturas de repos ajenos y escrituras propias no se bloquean por alcance', () => {
  for (const c of [`git -C ${barras(AJENO)} log --oneline`, `cd ${barras(AJENO)} && git status`, `cat ${barras(AJENO)}/README.md`, `git -C ${barras(WT)} status`, `echo x > ${barras(WT)}/f.txt`, 'ls', 'ls -la']) {
    const o = preBash(PROPIO, c);
    assert.ok(!/no de esta sesi/.test(razon(o)), `no deberia ser alcance: ${c} -> ${razon(o)}`);
    assert.notStrictEqual(decision(o), 'deny', c);
  }
});

function harness(root, ...args) {
  return spawnSync(process.execPath, [HARNESS, ...args], { cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true, env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
}

test('harness.js gh: otra organizacion y escrituras en repos ajenos se rechazan ANTES de pedir token ni red', () => {
  for (const args of [['repos/zeta/ext/issues'], ['repos/zeta/ext/issues', 'POST', '{}'], ['repos/acme/otro/pulls', 'POST', '{}'], ['repos/acme/otro/issues/1', 'PATCH', '{}'], ['repos/acme/propio/../../zeta/ext/issues']]) {
    const r = harness(PROPIO, 'gh', ...args);
    assert.match(r.stdout, /BLOQUEADO/, args.join(' '));
    assert.notStrictEqual(r.status, 0, args.join(' '));
  }
});

test('asignar-tarea --repo: patron invalido y otra organizacion se rechazan antes de crear nada', () => {
  const base = ['asignar-tarea', 'Algo', 'fer', '--tipo', 'tarea'];
  let r = harness(PROPIO, ...base, '--repo', 'sin-barra');
  assert.match(r.stdout, /org\/repo/);
  assert.notStrictEqual(r.status, 0);
  r = harness(PROPIO, ...base, '--repo=zeta/ext');
  assert.match(r.stdout, /organizaci/);
  assert.notStrictEqual(r.status, 0);
});

test('faro-schema.json declara alcance y validate avisa de un .faro.json > alcance mal formado', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(HOOKS, 'faro-schema.json'), 'utf8'));
  assert.deepStrictEqual(schema.enums.alcance.claves, ['repos_permitidos']);
  assert.ok(new RegExp(schema.enums.alcance.patron_repo).test('acme/otro'));
  const t = path.join(TMP, 'validar');
  repo(t, 'https://github.com/acme/validar.git');
  fs.writeFileSync(path.join(t, '.faro.json'), JSON.stringify({ alcance: { repos_permitidos: ['mal'], x: 1 } }));
  fs.writeFileSync(path.join(t, 'ESTADO.md'), '---\niniciativa: X\n---\n');
  const r = harness(t, 'validate');
  assert.match(r.stdout + r.stderr, /\[alcance\]/);
});

// ───────────────── pasada adversarial (PR #165): fallar CERRADO ─────────────────
// deny = probado que es de otro repo · ask = no se puede resolver con certeza · null = propio/no es repo.
const estado = (r) => (r ? r.estado : null);
function enlace(destino, ruta) {
  try { fs.symlinkSync(destino, ruta, process.platform === 'win32' ? 'junction' : 'dir'); return true; } catch { return false; }
}

test('rutas: un enlace simbolico o junction DENTRO del repo que apunta a otro repo es ajeno', () => {
  const e = path.join(PROPIO, 'enlace-a-ajeno');
  if (!enlace(AJENO, e)) return;
  assert.strictEqual(estado(A.evaluarRuta(PROPIO, path.join(e, 'x.md'))), 'ajena');
  assert.strictEqual(estado(A.evaluarRuta(PROPIO, path.join(e, 'nueva', 'x.md'))), 'ajena');
  assert.strictEqual(decision(preDoc(PROPIO, path.join(e, 'x.md'))), 'deny');
  assert.ok(A.analizarComando(`echo hola > ${barras(e)}/f.txt`, PROPIO));
});

test('rutas: el MISMO repo accedido por una junction/enlace externo no es ajeno', () => {
  const atajo = path.join(TMP, 'atajo-a-propio');
  if (!enlace(PROPIO, atajo)) return;
  assert.strictEqual(A.evaluarRuta(PROPIO, path.join(atajo, 'src', 'x.md')), null);
  assert.strictEqual(A.evaluarRuta(atajo, path.join(PROPIO, 'x.md')), null);
});

test('rutas: un clon del propio (otro repo con el mismo contenido) y un repo desnudo son ajenos', () => {
  const clon = path.join(TMP, 'clon-de-propio');
  git(TMP, 'clone', '-q', PROPIO, clon);
  assert.strictEqual(estado(A.evaluarRuta(PROPIO, path.join(clon, 'README.md'))), 'ajena');
  const desnudo = path.join(TMP, 'desnudo.git');
  git(TMP, 'clone', '-q', '--bare', PROPIO, desnudo);
  assert.strictEqual(estado(A.evaluarRuta(PROPIO, path.join(desnudo, 'config'))), 'ajena');
  assert.strictEqual(A.analizarComando(`git --git-dir=${barras(desnudo)} push origin main`, PROPIO).nivel, 'deny');
});

test('rutas: normalizaciones de Windows (prefijo extendido, UNC, puntos/espacios finales, C:foo, flujos NTFS, 8.3)', { skip: process.platform !== 'win32' }, () => {
  const w = (p) => p.replace(/\//g, '\\');
  assert.strictEqual(estado(A.evaluarRuta(PROPIO, '\\\\?\\' + w(AJENO) + '\\x.md')), 'ajena');
  assert.strictEqual(estado(A.evaluarRuta(PROPIO, '\\\\.\\' + w(AJENO) + '\\x.md')), 'ajena');
  assert.strictEqual(estado(A.evaluarRuta(PROPIO, '//?/' + barras(AJENO) + '/x.md')), 'ajena');
  assert.strictEqual(A.evaluarRuta(PROPIO, '\\\\?\\' + w(PROPIO) + '\\x.md'), null);
  assert.strictEqual(estado(A.evaluarRuta(PROPIO, w(AJENO) + '. \\x.md')), 'ajena', 'puntos y espacios finales los ignora Win32');
  assert.strictEqual(estado(A.evaluarRuta(PROPIO, w(AJENO) + '\\x.md.')), 'ajena');
  assert.strictEqual(estado(A.evaluarRuta(PROPIO, 'C:foo.md')), 'incierta');
  assert.strictEqual(estado(A.evaluarRuta(PROPIO, w(AJENO) + '\\x.md:flujo')), 'incierta');
  const unc = '\\\\localhost\\' + AJENO[0] + '$' + w(AJENO).slice(2) + '\\x.md';
  assert.ok(estado(A.evaluarRuta(PROPIO, unc)) !== null, 'una ruta UNC a otro repo no pasa en silencio');
  const corto = spawnSync("cmd", ["/d", "/s", "/c", `"for %I in (${w(AJENO)}) do @echo %~sI"`], { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true }).stdout.trim();
  if (corto && corto.toLowerCase() !== w(AJENO).toLowerCase()) assert.strictEqual(estado(A.evaluarRuta(PROPIO, corto + '\\x.md')), 'ajena');
  assert.strictEqual(decision(preDoc(PROPIO, 'C:foo.md')), 'ask');
});

test('rutas: ..tras normalizar y ./ no esconden el repo ajeno', () => {
  assert.strictEqual(estado(A.evaluarRuta(PROPIO, './src/./../../ajeno/./x.md')), 'ajena');
  assert.strictEqual(estado(A.evaluarRuta(PROPIO, `${barras(PROPIO)}/src/../../ajeno/x.md`)), 'ajena');
});

const x = () => barras(AJENO);
test('pre-bash: variantes de destino ajeno PROBADO -> deny', () => {
  const urlAj = 'https://github.com/acme/otro.git';
  const deny = [
    `env GIT_DIR=${x()}/.git git commit -m x`,
    `env GIT_WORK_TREE=${x()} git add -A`,
    `export GIT_DIR=${x()}/.git; git commit -m x`,
    `export GIT_WORK_TREE=${x()} && git add -A`,
    `GIT_COMMON_DIR=${x()}/.git git commit -m x`,
    `$env:GIT_DIR = "${x()}/.git"; git commit -m x`,
    `Set-Item env:GIT_DIR ${x()}/.git; git commit -m x`,
    `git -c core.worktree=${x()} add -A`,
    `git -C ../propio -C ../ajeno commit -m x`,
    `git -C . -C ../ajeno commit -m x`,
    `git -C ../ajeno -c user.name=x commit -m x`,
    `pushd ../ajeno && git commit -m x`,
    `Set-Location ../ajeno; git commit -m x`,
    `sl ../ajeno; git commit -m x`,
    `Push-Location ../ajeno; git commit -m x`,
    `(cd ../ajeno; git commit -m x)`,
    `{ cd ../ajeno; git commit -m x; }`,
    `if cd ../ajeno; then git commit -m x; fi`,
    `cd ../ajeno\ngit commit -m x`,
    `"git" -C ../ajeno commit -m x`,
    `g''it -C ../ajeno commit -m x`,
    `git -C "../ajeno" commit -m x`,
    `/usr/bin/git -C ../ajeno commit -m x`,
    `command git -C ../ajeno commit -m x`,
    `git.exe -C ../ajeno commit -m x`,
    `env -C ../ajeno git commit -m x`,
    `git worktree add ${x()}/sub`,
    `git worktree add -b nueva ${x()}/sub2`,
    `git clone ${urlAj} ${x()}/clonado`,
    `git init ${x()}/nuevo`,
    `bash <<EOF\ngit -C ../ajeno commit -m x\nEOF`,
    `bash <<< "git -C ../ajeno commit -m x"`,
    `sh -c 'cd ../ajeno && git commit -m x'`,
    `powershell -Command "git -C ../ajeno commit -m x"`,
    `eval "git -C ../ajeno commit -m x"`,
    `echo hola > "${x()}/con espacios.txt"`,
    `echo hola >${x()}/pegado.txt`,
    `echo hola &> ${x()}/todo.txt`,
  ];
  for (const c of deny) { const b = A.analizarComando(c, PROPIO); assert.ok(b && b.nivel === 'deny', `deberia ser deny: ${c} -> ${JSON.stringify(b)}`); }
});

test('pre-bash: destino que no se puede resolver con certeza -> ask (nunca allow silencioso)', () => {
  const ask = [
    'git -C "$D" commit -m x',
    'git -C $D commit -m x',
    'git -C ${D} push',
    'git -C `echo ../ajeno` commit -m x',
    'git -C $(echo ../ajeno) commit -m x',
    'git --git-dir=$X push',
    'git --work-tree $W add -A',
    'GIT_DIR=$X git commit -m x',
    'export GIT_DIR=$X; git commit -m x',
    'cd "$X" && git commit -m x',
    'cd $X; git add -A',
    'cd - && git commit -m x',
    'popd; git commit -m x',
    'pushd "$(mktemp -d)" && git commit -m x',
    'for d in ../a ../b; do git -C $d commit -m x; done',
    "git -c alias.x='!cd ../ajeno && git commit' x",
    'git -c core.sshCommand=foo push',
    'git --exec-path=/tmp/x commit -m x',
    'echo "git -C ../ajeno commit" | bash',
    'GIT_INDEX_FILE=/tmp/i git commit -m x',
  ];
  for (const c of ask) { const b = A.analizarComando(c, PROPIO); assert.ok(b && b.nivel === 'ask', `deberia ser ask: ${c} -> ${JSON.stringify(b)}`); }
});

test('pre-bash: lo claramente propio o de lectura sigue pasando (sin prompts de mas)', () => {
  const pasan = [
    'cd "$(git rev-parse --show-toplevel)" && git commit -m x',
    'git -C ../ajeno -C ../propio commit -m x',
    `git -C ${barras(PROPIO)}/src -C .. commit -m x`,
    'echo hola > /dev/null', 'echo hola 2>$null', 'echo hola > $null', 'echo hola > NUL',
    'echo hola > $HOME/.claude/nota.txt', 'echo hola > $TMPDIR/x', 'echo hola > $env:TEMP\\x', 'echo hola > ${CLAUDE_PROJECT_DIR}/x',
    'git commit -m "git -C ../ajeno commit"',
    'git log --oneline | head',
    'ls | xargs echo',
    'bash -c "git status"',
    'git -c user.name=x commit -m y',
    'export FOO=bar; git commit -m x',
    'git worktree add ../propio-nuevo-wt',
  ];
  for (const c of pasan) assert.strictEqual(A.analizarComando(c, PROPIO), null, `no deberia frenarse: ${c}`);
});

test('pre-bash (hook): ask se emite como confirmacion, deny como bloqueo', () => {
  assert.strictEqual(decision(preBash(PROPIO, 'git -C "$D" commit -m x')), 'ask');
  assert.strictEqual(decision(preBash(PROPIO, `env GIT_DIR=${x()}/.git git commit -m x`)), 'deny');
  assert.strictEqual(decision(preBash(PROPIO, 'cd "$X" && git add -A')), 'ask');
});

test('gh: nombres sin distinguir mayusculas, .git y repos hermanos; escrituras de alto riesgo hacia repos ajenos', () => {
  const s = { org: 'acme-org', repo: 'faro-plugin' };
  const ev = (p, m, o = {}) => A.evaluarGh(p, m, s, { apiBase: 'https://api.github.com/', ...o });
  for (const [p, m] of [['repos/acme-org/FARO-PLUGIN/pulls', 'POST'], ['repos/acme-org/faro-plugin.git/pulls', 'POST'], ['repos/Acme-Org/otro/issues', 'POST'], ['orgs/acme-org/members', 'GET'], ['/repos/acme-org/x/issues/1', 'GET'], ['https://API.GITHUB.COM/repos/acme-org/x/issues', 'GET']]) assert.strictEqual(ev(p, m), null, `${p} ${m}`);
  for (const [p, m, b] of [
    ['repos/acme-org/otro/transfer', 'POST'], ['repos/acme-org/faro-plugin/transfer', 'POST'], ['repos/acme-org/otro/dispatches', 'POST'], ['repos/acme-org/otro/forks', 'POST'],
    ['repos/acme-org/otro/git/refs', 'POST'], ['repos/acme-org/otro/git/refs/heads/x', 'PATCH'], ['repos/acme-org/otro/contents/a.md', 'PUT'], ['repos/acme-org/otro/contents/a.md', 'DELETE'],
    ['repos/acme-org/faro-plugin/forks', 'POST', '{"organization":"zeta"}'],
    ['repos/zeta/x/issues', 'GET'], ['repos/acme-org-extra/x/issues', 'GET'], ['orgs/Zeta/repos', 'GET'],
    ['repositories/123', 'GET'], ['repositories/123/issues', 'POST'], ['organizations/1/repos', 'GET'], ['app/installations', 'GET'], ['enterprises/e/audit-log', 'GET'], ['installation/repositories', 'GET'],
    ['user/repos', 'POST'], ['user/keys', 'POST'], ['teams/1/members/x', 'PUT'], ['gists', 'POST'], ['projects/1', 'PATCH'],
    ['https://api.github.com:443/repos/zeta/x', 'GET'], ['https://api.github.com:8443/repos/acme-org/x', 'GET'], ['https://user@api.github.com/repos/acme-org/x', 'GET'],
    ['https://api.github.com@evil.example/repos/acme-org/x', 'GET'], ['http://api.github.com/repos/acme-org/x', 'GET'], ['https:evil.example/x', 'GET'], ['//evil.example/repos/acme-org/x', 'GET'],
    ['./repos/zeta/x', 'GET'], ['repos/acme-org/%2e/../zeta/x', 'GET'], ['repos/acme-org%2Fzeta/x', 'GET'], ['repos/acme-org/otro%252F..%252Fx', 'GET'],
    ['repos/acme-org/faro-plugin%3F/../zeta', 'GET'], ['repos/acme-org/faro-plugin%23/x', 'GET'], ['repos/acme-org/faro-plugin%00', 'GET'], ['repos/acme-org/ faro', 'GET'],
    ['repos/acme-org/otro/issues', 'OPTIONS'], ['repos/acme-org/otro/issues', 'post '], ['repos/acme-org/otro/issues', 'TRACE'],
    ['graphql', 'POST', '{"query":"mutation($i:X!){a(input:$i){id}}","variables":{}}'],
    ['graphql', 'POST', '{"query":"fragment F on Mutation { id } query { viewer { id } }"}'],
    ['graphql', 'POST', '{"query":"\\u006dutation { x }"}'],
    ['graphql', 'POST', 'no es json'], ['graphql', 'POST', '{"variables":{}}'], ['graphql', 'POST', ''],
  ]) assert.ok(ev(p, m, { cuerpo: b }), `deberia rechazarse: ${p} ${m} ${b || ''}`);
  assert.strictEqual(ev('graphql', 'POST', { cuerpo: '{"query":"query { viewer { login } }"}' }), null);
});

// ───────────────── tercera ronda: lista cerrada de lecturas, superficie reducida, todo error cae en ask ─────────────────
test('git hacia otro repo: solo la lista cerrada de lecturas sin opciones que escriban; el resto, ask o deny', () => {
  const a = '../ajeno';
  for (const c of ['status', 'status -s', 'log --oneline -5', 'diff HEAD~1', 'show HEAD', 'rev-parse HEAD', 'branch', 'branch -a', 'ls-files', 'remote -v', 'describe --tags'])
    assert.strictEqual(A.analizarComando(`git -C ${a} ${c}`, PROPIO), null, `lectura permitida: ${c}`);
  const peligrosas = [
    'log --output=../propio/x.txt', 'diff --output=x', 'show --output x', 'format-patch -o /tmp/x HEAD~1', 'bundle create x.bundle HEAD', 'archive -o x.tar HEAD',
    'config --file x.cfg a.b c', 'config --get user.name', 'log --ext-diff', 'diff --textconv', 'show --exec-path', 'log --open-files-in-pager', 'diff -O ord',
    'diff --no-index /etc/a /etc/b', 'grep x', 'cat-file -p HEAD', 'blame README.md', 'stash list', 'tag', 'fetch', 'remote show origin', 'branch nueva', 'branch -D x',
    '-c core.pager=x log', 'log --upload-pack=x', 'log --receive-pack=x', 'ls-remote .', 'log > ../externo/x.txt',
  ];
  for (const c of peligrosas) {
    const b = A.analizarComando(c.startsWith('-c') ? `git ${c.replace(/^(-c \S+) /, `$1 -C ${a} `)}` : `git -C ${a} ${c}`, PROPIO);
    assert.ok(b, `deberia frenarse: ${c}`);
    assert.ok(['ask', 'deny'].includes(b.nivel), c);
  }
  assert.strictEqual(A.analizarComando('git --git-dir=../ajeno/.git --git-dir=../ajeno/.git log', PROPIO).nivel, 'ask', '--git-dir repetido');
  assert.strictEqual(A.analizarComando('git -C ../ajeno log -c a=b', PROPIO) === null, false);
  // En el repo propio nada de esto molesta.
  for (const c of ['git log --output=x.txt', 'git config user.name x', 'git grep x', 'git stash', 'git fetch']) assert.strictEqual(A.analizarComando(c, PROPIO), null, c);
});

test('superficie reducida: las herramientas sueltas ya no se analizan (limite documentado) y las redirecciones simples si', () => {
  for (const c of ['rm ../ajeno/README.md', 'cp a.txt ../ajeno/a.txt', 'touch ../ajeno/a', 'find ../ajeno -delete', 'tar -xf a.tar -C ../ajeno', 'curl -o ../ajeno/f http://x', 'sed -i s/a/b/ ../ajeno/README.md'])
    assert.strictEqual(A.analizarComando(c, PROPIO), null, `sin analisis: ${c}`);
  assert.strictEqual(A.analizarComando('echo x > ../ajeno/f', PROPIO).nivel, 'deny');
  assert.strictEqual(A.analizarComando('echo x >> ../ajeno/f', PROPIO).nivel, 'deny');
  assert.strictEqual(A.analizarComando('echo x > $OUT', PROPIO), null, 'redireccion no resoluble: sin analisis');
});

test('fallo abierto: entradas que no son texto, comillas sin cerrar, ordenes enormes y rutas raras acaban en ask, nunca en null', () => {
  for (const v of [123, {}, [], true, Symbol('x')]) assert.strictEqual(A.analizarComando(v, PROPIO).nivel, 'ask', String(typeof v));
  assert.strictEqual(A.analizarComando('', PROPIO), null);
  assert.strictEqual(A.analizarComando(undefined, PROPIO), null);
  assert.strictEqual(A.analizarComando('git commit -m x', undefined).nivel, 'ask', 'sin raiz de sesion');
  for (const c of ['git commit -m "sin cerrar', "git commit -m 'sin cerrar", 'git -C ../ajeno commit -m "x', 'echo $(git commit -m x', 'echo `git commit', 'git commit -m "$(echo x"']) assert.ok(A.analizarComando(c, PROPIO), `deberia frenarse: ${c}`);
  const enorme = 'git commit -m "' + 'x'.repeat(1024 * 1024) + '"';
  assert.strictEqual(A.analizarComando(enorme, PROPIO).nivel, 'ask');
  for (const v of [123, {}, [], true, null, undefined]) {
    if (v === undefined || v === null) assert.strictEqual(A.evaluarRuta(PROPIO, v), null);
    else assert.strictEqual(A.evaluarRuta(PROPIO, v).estado, 'incierta');
  }
  assert.strictEqual(A.evaluarRuta(undefined, 'x.md').estado, 'incierta');
  assert.strictEqual(A.evaluarRuta(PROPIO, 'a\0b').estado, 'incierta');
  for (const [p, m, s, o] of [[123, 'GET', null], [{}, 'GET', {}], ['repos/a/b', {}, { org: 'a', repo: 'b' }], ['graphql', 'POST', { org: 'a', repo: 'b' }, { cuerpo: {} }], ['repos/a/b', 'GET', 'no-objeto'], [undefined, undefined, undefined]])
    assert.ok(A.evaluarGh(p, m, s, o), `evaluarGh debe rechazar: ${String(p)} ${String(m)}`);
  assert.ok(A.parsearRepoArg({}, PROPIO).error);
  assert.ok(A.parsearRepoArg('acme/otro', undefined).error);
});

test('propiedades: un corpus generado de ordenes mutadas nunca lanza y nunca deja pasar un git de escritura con destino no resuelto o ajeno', () => {
  let semilla = 20260711;
  const rnd = (n) => { semilla = (semilla * 1664525 + 1013904223) >>> 0; return semilla % n; };
  const elige = (a) => a[rnd(a.length)];
  const destinosMalos = ['"$X"', '$X', '${X}', '`echo ../ajeno`', '$(echo ../ajeno)', '../ajeno', barras(AJENO), `"${barras(AJENO)}"`, "'../ajeno'", '"$(pwd)/../ajeno"', '%OTRO%', '$env:OTRO'];
  const verbos = ['commit -m x', 'push origin main', 'add -A', 'rm README.md', 'mv a b', 'checkout -- .', 'reset --hard', 'merge x', 'rebase x', 'pull', 'clean -fd', 'fetch', 'stash', 'tag v1', 'config user.name x', 'branch -D x'];
  const antes = ['', '', 'cd . && ', 'true; ', '( ', 'ls\n', 'FOO=1 ', 'env ', 'time ', 'command ', 'sudo ', '{ ', 'if true; then '];
  const despues = ['', '', ' && ls', ' ; echo hi', ' | cat', ' 2>&1', '\n', ' )', ' ; }', '; fi'];
  const ruido = ['', 'ü', '\u0001', '‮', ' ', 'ñ', '\t', '\r'];
  let n = 0;
  for (let i = 0; i < 400; i++) {
    const dest = elige(destinosMalos), verbo = elige(verbos);
    const ab = elige(antes), de = elige(despues);
    const cierre = (ab === '( ' && de !== ' )') ? ' )' : (ab === '{ ' && de !== ' ; }') ? ' ; }' : (ab === 'if true; then ' && de !== '; fi') ? '; fi' : '';
    const orden = `${ab}git -C ${dest} ${verbo.replace(' -m x', ` -m "${elige(ruido)}m${elige(ruido)}"`)}${de}${cierre}`;
    let b;
    assert.doesNotThrow(() => { b = A.analizarComando(orden, PROPIO); }, orden);
    assert.ok(b && ['ask', 'deny'].includes(b.nivel), `debe frenarse: ${JSON.stringify(orden)} -> ${JSON.stringify(b)}`);
    n++;
  }
  assert.strictEqual(n, 400);
  // Basura arbitraria: no lanza y devuelve null o un {nivel} valido.
  const piezas = ['git', ' ', '-C', '"', "'", '`', '$(', ')', '(', '|', '&', ';', '>', '<<', '<<<', '\n', '\\', '\u0000', 'commit', '../ajeno', 'ü', 'GIT_DIR=', 'cd ', '${', '}', '%', '*', 'bash -c ', 'eval '];
  for (let i = 0; i < 600; i++) {
    let s = ''; for (let k = rnd(14); k >= 0; k--) s += elige(piezas);
    let b;
    assert.doesNotThrow(() => { b = A.analizarComando(s, PROPIO); }, JSON.stringify(s));
    assert.ok(b === null || ['ask', 'deny'].includes(b.nivel), JSON.stringify(s));
  }
  // La entrada de 1 MB de basura tampoco lanza ni tarda de mas.
  const t0 = Date.now();
  assert.doesNotThrow(() => A.analizarComando('git ' + '$('.repeat(300000), PROPIO));
  assert.ok(Date.now() - t0 < 20000);
});

test('harness.js gh no admite cabeceras: el metodo no se puede cambiar con X-HTTP-Method-Override', () => {
  const src = fs.readFileSync(path.join(HOOKS, 'lib', 'github.js'), 'utf8');
  const cuerpo = src.slice(src.indexOf('async function cmdGh()'), src.indexOf('async function issueEstado'));
  assert.ok(!/process\.argv\[[6-9]\]/.test(cuerpo), 'cmdGh no lee argumentos de cabeceras');
  assert.ok(!/Method-Override/i.test(cuerpo));
});

// ───────────────────────── revision de seguridad ─────────────────────────

const require_ = createRequire(import.meta.url);
const preDocT = (root, tool_name, tool_input) => hook('pre-doc', root, { tool_name, tool_input });

test('.faro.json es libre: ni pre-doc ni pre-bash piden confirmacion por mencionarlo o escribirlo (#238)', () => {
  const faro = path.join(PROPIO, '.faro.json');
  for (const [tool, input] of [
    ['Write', { file_path: faro, content: JSON.stringify({ alcance: { repos_permitidos: ['acme/otro'] } }) }],
    ['Edit', { file_path: path.join(CFG, '.faro.json'), old_string: '"acme/otro"', new_string: '"acme/otro","zeta/ext"' }],
    ['MultiEdit', { file_path: faro, edits: [{ old_string: '{', new_string: '{"alcance":{"repos_permitidos":["zeta/ext"]},' }] }],
  ]) assert.notStrictEqual(decision(preDocT(PROPIO, tool, input)), 'ask', tool);
  for (const c of [
    'mkdir -p gestion/cambios && echo .faro.json', 'echo x > .faro.json', 'echo x | tee .faro.json', 'sed -i s/a/b/ .faro.json',
    'cp /tmp/x .faro.json', 'rm .faro.json', 'git checkout -- .faro.json', 'echo x > .fa[r]o.json', 'node scripts/edit.js .faro.json',
    `node -e "require('fs').writeFileSync('.faro.json','{}')"`, 'cat .faro.json', 'git add .faro.json',
  ]) {
    assert.strictEqual(A.analizarComando(c, PROPIO), null, c);
    assert.notStrictEqual(decision(preBash(PROPIO, c)), 'ask', c);
  }
  // El resto de confirmaciones conserva el texto de destino no comprobable.
  assert.match(razon(preBash(PROPIO, 'git -C "$D" commit -m x')), /fuera del repo de esta sesion/);
});

test('seguridad: asignar-tarea --repo no crea labels en el repo ajeno, no cita rutas internas y pasa por evaluarGh', async () => {
  const llamadas = [];
  const ghApi = async (p, { method = 'GET', body = null } = {}) => {
    llamadas.push({ p, method, body });
    if (/\/assignees\//.test(p)) return { ok: true, status: 204, body: true };
    if (/\/labels\?/.test(p)) return { ok: true, status: 200, body: [{ name: 'bug' }] };
    if (/\/issues$/.test(p) && method === 'POST') return { ok: true, status: 201, body: { number: 9, html_url: 'https://github.com/acme/otro/issues/9' } };
    return { ok: false, status: 404, body: null };
  };
  const schema = JSON.parse(fs.readFileSync(path.join(HOOKS, 'faro-schema.json'), 'utf8'));
  const fabrica = require_('../plugins/faro/hooks/lib/github-tareas.js');
  const t = fabrica({
    ROOT: PROPIO, ghApi, ghRepo: () => ({ org: 'acme', repo: 'propio' }), git: () => '', faroSchema: () => schema, specBase: 'gestion/cambios',
    ensureUser: async () => null, cachedUser: () => null, collaborators: async () => [], CRED: {}, ghHost: () => 'github.com', ghToken: () => 't',
    readCfg: () => ({}), writeCfg: () => {}, labelsCatalogo: () => schema.enums.labels, resolverLabel: async () => { throw new Error('no debe crear/resolver labels en el repo ajeno'); },
    fases: () => [], hitos: async () => [], buscarHito: () => null, crearHito: async () => ({}), tituloFase: () => '',
  });
  const argv0 = process.argv, env0 = process.env.CLAUDE_PROJECT_DIR, log0 = console.log;
  const salida = [];
  process.argv = ['node', 'h', 'asignar-tarea', 'Arreglar algo del otro repo', 'fer', 'mi-cambio-interno', 'Cuerpo del encargo', '--tipo', 'bug', '--repo', 'acme/otro'];
  process.env.CLAUDE_PROJECT_DIR = PROPIO;
  console.log = (...a) => salida.push(a.join(' '));
  try { await t.cmdAsignarTarea(); } finally { process.argv = argv0; console.log = log0; if (env0 === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = env0; }
  const escrituras = llamadas.filter((c) => c.method !== 'GET');
  assert.deepStrictEqual(escrituras.map((c) => `${c.method} ${c.p}`), ['POST repos/acme/otro/issues'], salida.join('\n'));
  const cuerpo = escrituras[0].body;
  assert.ok(!/gestion\/cambios|changes\//.test(cuerpo.body), 'no cita rutas internas');
  assert.deepStrictEqual(cuerpo.labels, ['bug'], 'solo labels que YA existen en el repo ajeno');
});

test('seguridad: sin label existente en el repo ajeno el issue se abre sin label (no se crea ninguno)', async () => {
  const llamadas = [];
  const ghApi = async (p, { method = 'GET', body = null } = {}) => {
    llamadas.push({ p, method, body });
    if (/\/assignees\//.test(p)) return { ok: true, status: 204, body: true };
    if (/\/labels\?/.test(p)) return { ok: true, status: 200, body: [] };
    if (/\/issues$/.test(p) && method === 'POST') return { ok: true, status: 201, body: { number: 9, html_url: 'u' } };
    return { ok: false, status: 404, body: null };
  };
  const schema = JSON.parse(fs.readFileSync(path.join(HOOKS, 'faro-schema.json'), 'utf8'));
  const t = require_('../plugins/faro/hooks/lib/github-tareas.js')({
    ROOT: PROPIO, ghApi, ghRepo: () => ({ org: 'acme', repo: 'propio' }), git: () => '', faroSchema: () => schema, specBase: 'gestion/cambios',
    ensureUser: async () => null, cachedUser: () => null, collaborators: async () => [], CRED: {}, ghHost: () => 'github.com', ghToken: () => 't',
    readCfg: () => ({}), writeCfg: () => {}, labelsCatalogo: () => schema.enums.labels, resolverLabel: async () => { throw new Error('no'); },
    fases: () => [], hitos: async () => [], buscarHito: () => null, crearHito: async () => ({}), tituloFase: () => '',
  });
  const argv0 = process.argv, log0 = console.log;
  process.argv = ['node', 'h', 'asignar-tarea', 'Arreglar algo del otro repo', 'fer', '--tipo', 'tarea', '--repo', 'acme/otro'];
  console.log = () => {};
  try { await t.cmdAsignarTarea(); } finally { process.argv = argv0; console.log = log0; }
  assert.ok(!llamadas.some((c) => /\/labels$/.test(c.p) && c.method === 'POST'), 'no se crean labels ajenos');
  const issue = llamadas.find((c) => c.method === 'POST');
  assert.ok(issue && issue.p === 'repos/acme/otro/issues');
  assert.deepStrictEqual(issue.body.labels, []);
});

test('seguridad: --config-env=<clave>=<VAR> con = se trata como -c (ask)', () => {
  for (const c of ['git --config-env=core.sshCommand=X fetch', 'git --config-env=alias.s=X status', 'git --config-env=core.fsmonitor=X log'])
    assert.strictEqual((A.analizarComando(c, PROPIO) || {}).nivel, 'ask', c);
});

test('seguridad: --repo y RE_REPO rechazan los segmentos . y ..', () => {
  for (const mal of ['./x', 'acme/.', 'acme/..', '../otro', '../..', './.', 'acme/../otro']) assert.ok(A.parsearRepoArg(mal, PROPIO).error, `debe rechazarse: ${mal}`);
  assert.ok(!A.RE_REPO.test('acme/..') && !A.RE_REPO.test('./otro') && A.RE_REPO.test('acme/otro.js') && A.RE_REPO.test('acme/.github'));
});

const frena = (c) => { const r = A.analizarComando(c, PROPIO); return r && r.nivel; };

test('seguridad: el guard y el shell leen igual la palabra de la orden (escape a mitad, variable, sustitucion)', () => {
  for (const c of ['g\\it -C ../ajeno commit -m x', '$(echo git) -C ../ajeno commit -m x', '${GIT:-git} -C ../ajeno commit -m x', '$GIT -C ../ajeno commit -m x', '`echo git` --git-dir=../ajeno/.git add -A', 'sh -c "$(echo git) -C ../ajeno commit"'])
    assert.ok(['ask', 'deny'].includes(frena(c)), c);
  assert.strictEqual(frena('$HOME/bin/herramienta --version'), null, 'una variable que no parece git no molesta');
});

test('seguridad: envoltorios con opciones con valor (sudo -u, nice -n, stdbuf -o, timeout -s, exec -a, env -S) no ocultan el git', () => {
  for (const c of ['sudo -u root git -C ../ajeno commit -m x', 'nice -n 5 git -C ../ajeno commit -m x', 'stdbuf -o L git -C ../ajeno commit -m x', 'timeout -s KILL 5 git -C ../ajeno commit -m x', 'exec -a n git -C ../ajeno commit -m x', 'env -S "git -C ../ajeno commit -m x"', 'busybox sh -c "git -C ../ajeno commit -m x"'])
    assert.strictEqual(frena(c), 'deny', c);
  assert.strictEqual(frena('nice -n 5 git status'), null);
  assert.strictEqual(frena('Start-Process git -ArgumentList "-C ../ajeno commit -m x"'), 'ask');
});

test('seguridad: >& fichero es una redireccion a fichero (no una duplicacion de descriptor)', () => {
  assert.strictEqual(frena('echo x >& ../ajeno/f'), 'deny');
  assert.strictEqual(frena('echo x &> ../ajeno/f'), 'deny');
  assert.strictEqual(frena('echo x 2>&1'), null);
  assert.strictEqual(frena('echo x >&2'), null);
});

test('seguridad: sustituciones dentro de un heredoc sin comillas se ejecutan y se analizan', () => {
  assert.ok(['ask', 'deny'].includes(frena('cat <<EOF\n$(git -C ../ajeno commit -m x)\nEOF')));
  assert.ok(['ask', 'deny'].includes(frena('cat <<EOF\n`git -C ../ajeno commit -m x`\nEOF')));
  assert.strictEqual(frena('cat <<EOF\nhola $(date)\nEOF'), null);
});

test('heredoc con el delimitador entre comillas: su cuerpo es texto literal, no ordenes (#197)', () => {
  const cron = 'cat > f.md <<%D%\ncrons `0 3 * * *` y $(git -C ../ajeno commit -m x)\n%F%';
  for (const [d, f] of [["'EOF'", 'EOF'], ['"EOF"', 'EOF'], ['\\EOF', 'EOF'], ["'FIN'", 'FIN'], ["-'EOF'", '\tEOF']])
    assert.strictEqual(A.analizarComando(cron.replace('%D%', d).replace('%F%', f), PROPIO), null, `<<${d} no ejecuta nada`);
  assert.ok(A.analizarComando(cron.replace('%D%', 'EOF').replace('%F%', 'EOF'), PROPIO), 'sin comillas, las sustituciones SI se ejecutan');
  assert.ok(['ask', 'deny'].includes(frena("bash <<'EOF'\ngit -C ../ajeno commit -m x\nEOF")), 'el cuerpo que lee un shell es codigo');
  assert.ok(['ask', 'deny'].includes(frena("cat <<'A' <<B\nliteral `0 *`\nA\n$(git -C ../ajeno commit -m x)\nB")), 'cada heredoc con su propio entrecomillado');
});

test('seguridad: xargs / find / parallel que lanzan un shell se confirman', () => {
  for (const c of ["xargs -I{} sh -c 'git -C {} commit' <<< ../ajeno", "find . -exec sh -c 'git -C ../ajeno commit' \\;", 'parallel bash -c "git -C {} push" ::: ../ajeno'])
    assert.ok(['ask', 'deny'].includes(frena(c)), c);
});

test('seguridad: git con una ruta de OTRO repo como destino de una opcion o del push no pasa', () => {
  for (const c of ['git push ../ajeno HEAD', 'git push --repo=../ajeno', 'git archive -o ../ajeno/f.tar HEAD', 'git archive --output=../ajeno/f.tar HEAD', 'git format-patch -o ../ajeno HEAD~1', 'git diff --output=../ajeno/f', 'git log --output ../ajeno/f', 'git bundle create ../ajeno/b.bundle HEAD', 'git config --file ../ajeno/.git/config user.name x', 'git config -f ../ajeno/.git/config user.name x', 'git checkout-index --prefix=../ajeno/ -a', 'git apply --directory=../ajeno p'])
    assert.ok(['ask', 'deny'].includes(frena(c)), c);
  assert.strictEqual(frena('git fetch ../ajeno'), null, 'leer de otro repo esta permitido');
  assert.strictEqual(frena('git archive -o /tmp/f.tar HEAD'), null);
  assert.strictEqual(frena('git push origin HEAD'), null);
});

test('seguridad: xargs / find -exec / parallel con git se confirman (ask) en vez de pasar sin analisis', () => {
  for (const c of ['echo x | xargs git commit -m x', 'find . -name a -exec git add {} \\;', 'xargs -I{} git -C {} push', 'parallel git -C {} push ::: ../ajeno'])
    assert.strictEqual((A.analizarComando(c, PROPIO) || {}).nivel, 'ask', c);
  assert.strictEqual(A.analizarComando('find . -name a', PROPIO), null);
  assert.strictEqual((A.analizarComando('\\git -C ../ajeno commit -m x', PROPIO) || {}).nivel, 'deny', 'un \\git con escape se analiza como git');
});

test('seguridad: barra invertida y tilde se leen como las leeria el shell (variante POSIX y variante Windows)', () => {
  for (const c of ['git -C ../aj\\eno commit -m x', 'git -C ..\\ajeno commit -m x', 'cd ../aj\\eno && git commit -m x', 'echo x > ../aj\\eno/f', 'git --git-dir=../aj\\eno/.git add -A'])
    assert.strictEqual(frena(c), 'deny', c);
  assert.strictEqual(frena('git -C ~root/x commit -m x'), 'ask', '~usuario no se resuelve');
  assert.strictEqual(frena('cd ~root && git commit -m x'), 'ask');
  assert.strictEqual(frena('git -C C:\\Users\\x\\repo-que-no-existe commit -m x'), null, 'una ruta de Windows legitima no da falsos avisos');
  assert.strictEqual(frena('GIT_CONFIG_PARAMETERS="\'alias.x=!true\'" git x'), 'ask');
});
