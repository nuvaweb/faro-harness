'use strict';
// Adaptador de `harness.js calidad`: Python, un venv propio de FARO con crapper y dryer fijados a un
// commit (lib/calidad-ci.js), y la ejecución de lib/calidad.py. En local informa: nunca bloquea.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { HERRAMIENTAS, urlPip } = require('./calidad-ci.js');

const SCRIPT = path.join(__dirname, 'calidad.py');
const ES_311 = 'import sys; print(sys.version_info >= (3, 11))';

// Primer Python >= 3.11 disponible. FARO_PYTHON fuerza uno concreto (y, si no existe, ninguno).
function buscarPython() {
  const candidatos = process.env.FARO_PYTHON
    ? [{ cmd: process.env.FARO_PYTHON, args: [] }]
    : [{ cmd: 'python3', args: [] }, { cmd: 'python', args: [] }, { cmd: 'py', args: ['-3'] }];
  for (const c of candidatos) {
    const r = spawnSync(c.cmd, [...c.args, '-c', ES_311], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    if (r.status === 0 && r.stdout.trim() === 'True') return c;
  }
  return null;
}

const dirHerramientas = () => process.env.FARO_HERRAMIENTAS || path.join(os.homedir(), '.faro', 'herramientas');
const pythonDelVenv = (venv) => path.join(venv, process.platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python'));
const firma = () => HERRAMIENTAS.map((h) => `${h.nombre}@${h.sha}`).join('\n');

// Venv listo con las versiones fijadas; reinstala solo si cambian. Devuelve su python o null.
function prepararVenv(py, log) {
  const venv = path.join(dirHerramientas(), 'calidad-venv');
  const marca = path.join(venv, '.faro-herramientas');
  const vpy = pythonDelVenv(venv);
  if (fs.existsSync(vpy) && fs.existsSync(marca) && fs.readFileSync(marca, 'utf8') === firma()) return vpy;
  log(`[calidad] preparando las herramientas (${HERRAMIENTAS.map((h) => h.nombre).join(', ')}) en ${venv}: solo la primera vez o al cambiar de versión.`);
  fs.mkdirSync(path.dirname(venv), { recursive: true });
  if (!fs.existsSync(vpy)) {
    const r = spawnSync(py.cmd, [...py.args, '-m', 'venv', venv], { stdio: 'inherit', windowsHide: true });
    if (r.status !== 0) return null;
  }
  const r = spawnSync(vpy, ['-m', 'pip', 'install', '-q', '--disable-pip-version-check', ...HERRAMIENTAS.map(urlPip)], { stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) return null;
  fs.writeFileSync(marca, firma());
  return vpy;
}

// Devuelve el código de salida del script (1 solo con --ci e incumplimientos); 0 si no se pudo medir.
function ejecutar(args, raiz, log = console.log) {
  const py = buscarPython();
  if (!py) {
    log('[calidad] hace falta Python 3.11 o superior para medir CRAP y duplicación (crapper y dryer). Instálalo y repite; mientras, no se mide nada.');
    return 0;
  }
  const vpy = prepararVenv(py, log);
  if (!vpy) {
    log('[calidad] no se pudieron instalar crapper y dryer (¿sin red o sin git?): no se mide nada esta vez.');
    return 0;
  }
  const r = spawnSync(vpy, ['-I', SCRIPT, ...args], { cwd: raiz, stdio: 'inherit', windowsHide: true });
  return r.status || 0;
}

module.exports = { buscarPython, prepararVenv, ejecutar, SCRIPT };
