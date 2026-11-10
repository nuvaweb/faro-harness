// lib/forge-gitlab-equipo.js — EQUIPO del proyecto en GitLab: quien es DIRECTO (el equipo real),
// quien solo HEREDA acceso del grupo, quien puede APROBAR, y como construir el equipo.
// Extraido de forge-gitlab.js por atomicidad (~400 lineas por modulo).
//
// REGLA: el equipo son los miembros DIRECTOS. '/members/all' trae ademas a quien hereda del grupo —
// en el repo real, 13 personas ajenas al proyecto — y con esa lista se asignaban tareas y se elegian
// revisores. El acceso heredado NO se puede quitar desde el proyecto (asi funciona GitLab); el EQUIPO
// si se decide: quien trabaja aqui se anade con 'harness.js miembro anadir'.
'use strict';

module.exports = function (g) {
  const { api, pid, f, SIN_TOKEN, nivelARol } = g;

  // ---- 3) EQUIPO y REVISORES ----
  // EL EQUIPO SON LOS MIEMBROS DIRECTOS. '/members/all' incluye a quien HEREDA acceso del grupo: en un
  // grupo mediano son decenas de personas ajenas al proyecto, y con esa lista se asignaban tareas y se
  // elegian revisores (se podia asignar trabajo a alguien que no pinta nada ahi). El acceso heredado
  // NO se puede quitar desde el proyecto — es como funciona GitLab —, pero el EQUIPO si se decide:
  // quien trabaja aqui se anade al proyecto (harness.js miembro anadir).
  const mapear = (b) => b.map((m) => ({ id: m.id, login: m.username, nombre: m.name || null, rol: nivelARol(m.access_level || 0), nivel: m.access_level || 0 })).filter((m) => m.login);
  const esRobot = (l) => /(^|_)bot_|_bot$|^project_\d+_bot|^group_\d+_bot/.test(String(l));
  async function collaborators() {   // DIRECTOS: el equipo real del proyecto
    const r = await api(`projects/${pid()}/members?per_page=100`);
    if (!r.ok || !Array.isArray(r.body)) return [];
    return mapear(r.body);
  }
  async function heredados() {       // con acceso por el grupo, pero NO son el equipo
    const [t, d] = await Promise.all([api(`projects/${pid()}/members/all?per_page=100`), api(`projects/${pid()}/members?per_page=100`)]);
    if (!t.ok || !Array.isArray(t.body)) return [];
    const directos = new Set((d.ok && Array.isArray(d.body) ? d.body : []).map((m) => m.id));
    return mapear(t.body.filter((m) => !directos.has(m.id)));
  }
  // QUIEN PUEDE APROBAR de verdad. '/members/all' incluye los HEREDADOS del grupo: con ese criterio,
  // cualquier Maintainer del grupo se vuelve aprobador de TODOS los proyectos, que no es lo que se
  // quiere. Criterio (alineado con la regla de aprobacion que aplica el gobierno de la organizacion):
  // QUIEN PUEDE APROBAR — criterio ADAPTATIVO, porque no todas las organizaciones permiten lo mismo:
  //   1) Maintainers/Owners DIRECTOS del proyecto. Es el criterio fino y el que se prefiere: evita que
  //      cualquier Maintainer del grupo apruebe en TODOS los repos.
  //   2) Si no hay NINGUNO, se cae a la herencia del grupo: primero Owners (50); si tampoco, Maintainers
  //      (40). Hace falta porque una organizacion puede BLOQUEAR la pertenencia a proyectos
  //      ('membership_lock' en un grupo ancestro): entonces NADIE puede ser miembro directo jamas y el
  //      criterio fino dejaria todos los repos sin un solo aprobador posible (caso real,
  //      11 sep 2026: el bloqueo venia de dos grupos por encima, fuera del alcance del usuario).
  // 'via' dice cual se aplico, para que el agente lo explique en vez de que parezca magia.
  async function approversInfo() {
    const dir = (await collaborators()).filter((m) => m.nivel >= 40 && !esRobot(m.login));
    if (dir.length) return { logins: dir.map((m) => m.login), via: 'directos' };
    const her = (await heredados()).filter((m) => !esRobot(m.login));
    const owners = her.filter((m) => m.nivel >= 50);
    if (owners.length) return { logins: owners.map((m) => m.login), via: 'owners-heredados' };
    const maint = her.filter((m) => m.nivel >= 40);
    if (maint.length) return { logins: maint.map((m) => m.login), via: 'maintainers-heredados' };
    return { logins: [], via: 'nadie' };
  }
  async function approvers() { return (await approversInfo()).logins; }
  async function cmdEquipo() {
    const [cs, hs, ai] = await Promise.all([collaborators(), heredados(), approversInfo()]);
    if (!cs.length && !hs.length) { const r = await api('user'); if (r.sinToken) { console.log(SIN_TOKEN()); process.exit(2); } console.log('No pude leer los miembros del proyecto.'); return; }
    const apr = new Set(ai.logins);
    const humanos = cs.filter((c) => !esRobot(c.login));
    console.log(`EQUIPO de ${f().path} — miembros DIRECTOS (${humanos.length}): a estos se les asigna trabajo y de estos salen los revisores.`);
    if (!humanos.length) {
      console.log('  (ninguno todavia)');
      console.log(`  ⚠ Sin miembros directos no hay a quien asignar trabajo. Anade a quien trabaje aqui:`);
      console.log(`     node .claude/hooks/harness.js miembro anadir <usuario> <developer|maintainer|owner>`);
      console.log(`     (Si responde que el grupo tiene BLOQUEADA la pertenencia, es una politica de la organizacion`);
      console.log(`      en un grupo superior: aqui NUNCA habra miembros directos y se aprueba por herencia.)`);
    } else {
      for (const c of humanos.sort((a, b) => b.nivel - a.nivel)) console.log(`  - ${c.login}${c.nombre ? ` (${c.nombre})` : ''} · ${c.rol} (${c.nivel})${apr.has(c.login) ? '  ← puede APROBAR' : ''}`);
    }
    const robots = cs.filter((c) => esRobot(c.login));
    if (robots.length) console.log(`  · ${robots.length} cuenta(s) de servicio directas (bots), fuera del equipo.`);
    if (hs.length) {
      const hh = hs.filter((c) => !esRobot(c.login));
      console.log(`\nCon acceso HEREDADO del grupo (${hh.length}): pueden ver y clonar, pero NO son el equipo de este proyecto:`);
      console.log(`  ${hh.slice(0, 8).map((c) => `${c.login} (${c.rol})`).join(' · ')}${hh.length > 8 ? ` … y ${hh.length - 8} mas` : ''}`);
      console.log('  El acceso heredado NO se puede quitar desde el proyecto (asi funciona GitLab).');
    }
    const PORQUE = {
      directos: 'los Maintainers/Owners DIRECTOS del proyecto (criterio preferido: cada repo decide quien aprueba en el).',
      'owners-heredados': 'los OWNERS del grupo, por herencia — este proyecto no tiene miembros directos (la organizacion puede tener BLOQUEADA la pertenencia a proyectos).',
      'maintainers-heredados': 'los MAINTAINERS del grupo, por herencia — no hay miembros directos ni owners.',
      nadie: 'NADIE: no hay directos ni heredados con nivel suficiente.',
    };
    console.log(`
APRUEBAN (${ai.logins.length}): ${ai.logins.join(' · ') || '—'}
  Criterio aplicado: ${PORQUE[ai.via]}`);
  }

  // ---- MIEMBROS del proyecto (construir el equipo) ----
  const ROLES = { guest: 10, reporter: 20, developer: 30, maintainer: 40, owner: 50 };
  async function cmdMiembro() {
    const [sub, quien, rol] = process.argv.slice(3);
    const uso = 'Uso: harness.js miembro [listar | anadir <usuario> <developer|maintainer|owner> | quitar <usuario>]';
    if (!sub || sub === 'listar') return cmdEquipo();
    if (!quien) { console.log(uso); process.exit(1); }
    const login = String(quien).replace(/^@/, '');
    if (sub === 'anadir') {
      const nivel = ROLES[String(rol || '').toLowerCase()];
      if (!nivel) { console.log(`Rol invalido '${rol || ''}'. Usa: ${Object.keys(ROLES).join(' · ')}\n${uso}`); process.exit(1); }
      // El usuario debe existir; se busca entre quienes ya tienen acceso (heredados incluidos) y, si no, por nombre.
      const todos = [...(await collaborators()), ...(await heredados())];
      let u = todos.find((c) => c.login.toLowerCase() === login.toLowerCase());
      if (!u) {
        const b = await api(`projects/${pid()}/members/all?query=${encodeURIComponent(login)}`);
        const cand = (b.ok && Array.isArray(b.body)) ? mapear(b.body) : [];
        if (cand.length === 1) u = cand[0];
        else if (cand.length > 1) { console.log(`'${login}' es ambiguo: ${cand.map((c) => c.login).join(' · ')}. Usa el nombre de usuario exacto.`); process.exit(1); }
      }
      if (!u) { console.log(`No encuentro a '${login}' entre quienes tienen acceso a ${f().path}. Debe estar en el grupo o invitarlo desde la web.`); process.exit(1); }
      const r = await api(`projects/${pid()}/members`, { method: 'POST', body: { user_id: u.id, access_level: nivel } });
      if (r.sinToken) { console.log(SIN_TOKEN()); process.exit(2); }
      if (!r.ok && r.status === 409) {
        const up = await api(`projects/${pid()}/members/${u.id}`, { method: 'PUT', body: { access_level: nivel } });
        if (!up.ok) { console.log(`Ya era miembro y no pude cambiarle el rol (HTTP ${up.status}).`); process.exit(1); }
        console.log(`✅ ${u.login} ya era miembro directo; rol actualizado a ${rol} (${nivel}).`); return;
      }
      if (!r.ok) { console.log(`No pude anadir a ${u.login} (HTTP ${r.status})${r.body && r.body.message ? `: ${JSON.stringify(r.body.message)}` : ''}. Anadir con rol Owner exige ser Owner.`); process.exit(1); }
      const v = await collaborators();   // relectura: el efecto real
      const ok = v.some((c) => c.id === u.id && c.nivel === nivel);
      console.log(ok ? `✅ ${u.login} es ahora miembro DIRECTO de ${f().path} como ${rol} (${nivel}).${nivel >= 40 ? ' Ya cuenta como aprobador aqui.' : ''}` : `⚠ GitLab acepto la peticion pero no veo a ${u.login} como directo con nivel ${nivel}.`);
      return;
    }
    if (sub === 'quitar') {
      const u = (await collaborators()).find((c) => c.login.toLowerCase() === login.toLowerCase());
      if (!u) { console.log(`'${login}' no es miembro DIRECTO de este proyecto (si tiene acceso heredado del grupo, eso no se quita desde aqui).`); process.exit(1); }
      const r = await api(`projects/${pid()}/members/${u.id}`, { method: 'DELETE' });
      if (r.sinToken) { console.log(SIN_TOKEN()); process.exit(2); }
      console.log(r.ok ? `✅ ${u.login} ya no es miembro directo (puede conservar acceso heredado del grupo).` : `No pude quitarlo (HTTP ${r.status}).`);
      return;
    }
    console.log(uso); process.exit(1);
  }

  return { collaborators, heredados, approvers, approversInfo, cmdEquipo, cmdMiembro, esRobot, mapear };
};
