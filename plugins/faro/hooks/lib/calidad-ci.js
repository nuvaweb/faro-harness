'use strict';
// Calidad medible en el CI generado (principios de ub-mode, github.com/unclebob/ub-mode, MIT).
// Puro: devuelve líneas de YAML y textos; quien escribe en disco es harness.js (cmdCi).
//
// Las herramientas van fijadas a un commit: un cambio suyo no entra en ningún CI sin pasar por un PR
// de FARO que actualice estos SHA. crapper y dryer requieren Python >= 3.11.

const HERRAMIENTAS = [
  { nombre: 'crapper', sha: 'c757ec79a6c15dc815238bbd9c2f4601eb54d3cc' },
  { nombre: 'dryer', sha: '66ff6d21a42c04afcad89c78a80066176d1294b0' },
];
const PYTHON_CI = '3.12';
const SCRIPT_CI = '.faro/calidad.py';

const urlPip = (h) => `git+https://github.com/unclebob/${h.nombre}@${h.sha}`;
const pipInstall = () => 'pip install -q ' + HERRAMIENTAS.map((h) => `"${urlPip(h)}"`).join(' ');

// Copia que vive en el repo del proyecto (el CI no tiene el plugin): cabecera con las versiones, que
// además sirve de clave de caché de pip (cambia cuando cambian los SHA), y el script tal cual.
function contenidoScript(script) {
  return `# FARO · herramientas: ${HERRAMIENTAS.map((h) => `${h.nombre}@${h.sha}`).join(' ')}\n${script}`;
}

function jobGithub(checkout) {
  return [
    // Solo en PR: mide contra la rama destino. En push a la rama principal ya se midió en su PR.
    '  calidad:',
    "    if: github.event_name == 'pull_request' && !github.event.pull_request.draft",
    '    runs-on: ubuntu-latest',
    '    steps:',
    `      - uses: ${checkout}`,
    '        with:',
    '          fetch-depth: 0',
    '      - uses: actions/setup-python@v7',
    '        with:',
    `          python-version: '${PYTHON_CI}'`,
    '          cache: pip',
    `          cache-dependency-path: ${SCRIPT_CI}`,
    `      - run: ${pipInstall()}`,
    `      - run: python ${SCRIPT_CI} --ci --base "origin/\${{ github.base_ref }}"`,
  ];
}

function jobGitlab() {
  return [
    '',
    'calidad:',
    '  stage: gates',
    `  image: python:${PYTHON_CI}`,
    '  variables:',
    '    GIT_DEPTH: "0"',
    '    PIP_CACHE_DIR: "$CI_PROJECT_DIR/.pip-cache"',
    '  cache:',
    '    key:',
    '      files:',
    `        - ${SCRIPT_CI}`,
    '    paths:',
    '      - .pip-cache',
    '  script:',
    '    - git fetch -q origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"',
    `    - ${pipInstall()}`,
    `    - python ${SCRIPT_CI} --ci --base "origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"`,
    '  rules:',
    '    - if: $CI_PIPELINE_SOURCE == "merge_request_event"',
  ];
}

// Para el aviso de «mergea a mano» cuando el proyecto ya tiene su CI.
function pasosManuales(forge) {
  const base = forge === 'github' ? 'origin/${{ github.base_ref }}' : 'origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME';
  return [
    `job calidad (solo en ${forge === 'github' ? 'PR' : 'MR'}, con la historia completa y Python ${PYTHON_CI}):`,
    ...(forge === 'github' ? [] : ['  git fetch -q origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"']),
    `  ${pipInstall()}`,
    `  python ${SCRIPT_CI} --ci --base "${base}"`,
  ];
}

module.exports = { HERRAMIENTAS, SCRIPT_CI, urlPip, contenidoScript, jobGithub, jobGitlab, pasosManuales };
