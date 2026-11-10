// #177 — el agente NO levanta servidores de desarrollo: pre-bash pide confirmacion (ask) con el mensaje corto.
// RED DE SEGURIDAD, no frontera (texto del comando; node -e, scripts y run_in_background no se ven).
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const { detectarServidor, MENSAJE } = createRequire(import.meta.url)(path.join(HOOKS, 'lib', 'servidores.js'));

const SERVIDORES = [
  'vite', 'npx vite --port 3000', 'vite preview', 'pnpm dev', 'pnpm run dev', 'npm run dev', 'npm start', 'yarn dev', 'yarn start',
  'bun run dev', 'pnpm --filter web dev', 'pnpm -C apps/web run dev:web', 'npm run serve', 'wrangler dev', 'npx wrangler dev --port 8787',
  'pnpm wrangler dev', 'wrangler pages dev ./dist', 'next dev', 'npx next start', 'serve -s dist', 'npx serve', 'http-server .', 'nodemon app.js',
  'webpack serve', 'webpack-dev-server', 'cd app && npm run dev', 'npm run dev &', 'nohup npm run dev > log.txt 2>&1 &', 'start npm run dev',
  'start /b npm run dev', 'Start-Process npm -ArgumentList "run dev"', "Start-Process -FilePath pnpm -ArgumentList 'dev' -WindowStyle Hidden",
  'cmd /c "npm run dev"', 'bash -c "npm run dev"', 'powershell -Command "pnpm dev"', 'FOO=1 npm run dev', 'cross-env PORT=3000 npm run dev',
  'node node_modules/vite/bin/vite.js', 'ng serve', 'astro dev', 'timeout 60 npm run dev', 'echo $(npm run dev)', 'sudo -u x vite',
  'npm.cmd run dev', '& npm run dev', 'pnpm exec vite', 'yarn workspace web dev', 'python -m http.server 8000', 'php -S localhost:8000', '(npm run dev)',
  'ls; vite', 'npm run dev -- --port 4000', 'live-server', 'bunx vite',
];
const INOCUOS = [
  'npm test', 'pnpm test', 'npm run test', 'npm run build', 'pnpm build', 'vite build', 'npx vite build', 'npm run lint', 'npm run typecheck',
  'tsc --noEmit', 'vitest run', 'vitest', 'node --test test/x.test.mjs', 'git commit -m "fix: npm run dev server"', 'echo "npm run dev"',
  'grep -r "vite" src', 'npm install', 'pnpm install vite', 'npm run build:dev', 'next build', 'wrangler deploy', 'wrangler types', 'cat package.json',
  'git log --grep=dev', 'npm run test -- --watch', 'pnpm --filter web test', 'ls', 'npm run lint -- dev', 'npm create vite@latest app', 'git status',
  'node scripts/build.js', 'eslint .', 'npx tsc -p .', 'pnpm --filter web build', 'ng build', 'astro build', 'wrangler dev --help',
];

test('detectarServidor: pide confirmacion ante los servidores de desarrollo (y sus envoltorios)', () => {
  for (const c of SERVIDORES) assert.ok(detectarServidor(c), `deberia detectarse: ${c}`);
});
test('detectarServidor: NO molesta a tests, builds, lint, typecheck ni texto que solo los nombra', () => {
  for (const c of INOCUOS) assert.strictEqual(detectarServidor(c), null, `falso positivo: ${c}`);
});
test('detectarServidor: entradas raras no lanzan excepcion', () => {
  for (const c of [undefined, null, '', 42, {}, '"sin cerrar', '$(', 'a'.repeat(100000)]) assert.doesNotThrow(() => detectarServidor(c));
});
test('el mensaje es corto y fijo (sin contenido del repo)', () => {
  assert.match(MENSAJE, /dame el comando y el puerto/);
  assert.match(MENSAJE, /terminal aparte/);
  assert.ok(MENSAJE.length < 160);
});

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-srv-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), '---\niniciativa: X\n---\n');
  return dir;
}
const preBash = (dir, command, tool = 'Bash') => spawnSync(process.execPath, [path.join(HOOKS, 'harness.js'), 'pre-bash'], {
  cwd: dir, encoding: 'utf8', timeout: 60000, input: JSON.stringify({ tool_name: tool, tool_input: { command } }),
  env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
});

test('pre-bash: servidor de desarrollo => ask con el mensaje corto; test/build => sin decision', () => {
  const dir = repo();
  for (const [c, tool] of [['pnpm dev', 'Bash'], ['Start-Process npm -ArgumentList "run dev"', 'PowerShell']]) {
    const r = preBash(dir, c, tool);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.hookSpecificOutput.permissionDecision, 'ask', c);
    assert.match(j.hookSpecificOutput.permissionDecisionReason, /dame el comando y el puerto/);
  }
  for (const c of ['npm test', 'npm run build', 'node --test x.mjs']) {
    const r = preBash(dir, c);
    assert.ok(!/"permissionDecision"/.test(r.stdout), `${c}\n${r.stdout}`);
  }
});
