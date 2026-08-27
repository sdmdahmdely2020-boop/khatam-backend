// Test de bout en bout pour le bug de suppression de compte découvert le
// 27/08 en production (signalé par sidi : "si je met suprime qlq le
// supression ne faite pas... parfois me disent ca parfois laisse"). Cause :
// lib/cascade.js#deleteUserCascade() ne supprimait pas les lignes des
// tables feedback/app_ratings/admin_messages (ajoutées le même jour) avant
// de supprimer l'utilisateur — la contrainte FOREIGN KEY faisait échouer
// TOUTE la transaction dès qu'un compte avait laissé un avis, un feedback,
// ou (pour un professeur) échangé un message avec l'admin, sans que le
// compte soit réellement supprimé. Ce script reproduit exactement ce
// scénario et vérifie que la suppression fonctionne désormais dans les deux
// cas, en individuel ET via /admin/reset-all-users.
// Usage : npm start (dans un terminal) puis node scripts/test-delete-cascade-fix.js
const db = require('../src/lib/db');

const BASE = process.env.API_BASE || 'http://localhost:4000/api';
const ADMIN_KEY = process.env.ADMIN_KEY || 'testadminkey';

let failures = 0;
function check(label, cond, extra) {
  if (cond) { console.log(`OK   - ${label}`); }
  else { failures++; console.log(`FAIL - ${label}`, extra ?? ''); }
}

function readVerificationCode(email) {
  const row = db.prepare('SELECT code FROM email_codes WHERE email = ? ORDER BY createdAt DESC LIMIT 1').get(email);
  if (!row) throw new Error(`Aucun code trouvé en base pour ${email}`);
  return row.code;
}

async function req(method, path, { token, device, body, admin } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (device) headers['X-Device-Id'] = device;
  if (admin) headers['X-Admin-Key'] = ADMIN_KEY;
  let fetchBody;
  if (body) { headers['Content-Type'] = 'application/json'; fetchBody = JSON.stringify(body); }
  const r = await fetch(`${BASE}${path}`, { method, headers, body: fetchBody });
  const contentType = r.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await r.json() : await r.arrayBuffer();
  return { status: r.status, data };
}

async function signupAndVerify(role, rand, extra = {}) {
  const prefix = role === 'PROFESSOR' ? '2226' : '2228';
  const phone = `${prefix}${rand}`.slice(0, 11);
  const email = `${role.toLowerCase()}.delfix.${rand}@khatam.mr`;
  const device = `device-delfix-${role}-${rand}`;
  const body = { role, fullName: `${role} DelFix Test`, phone, email, password: 'demo1234', serie: 'C', ...extra };
  let r = await req('POST', '/auth/signup', { body });
  check(`signup ${role} -> 201`, r.status === 201, r.data);
  const code = readVerificationCode(email);
  r = await req('POST', '/auth/verify-email', { body: { email, code, deviceId: device, deviceLabel: 'test' } });
  check(`verify-email ${role} -> 200 + token`, r.status === 200 && !!r.data.token, r.data);
  return { token: r.data.token, user: r.data.user, phone, email, device };
}

async function main() {
  console.log(`\n=== Tests correctif suppression de compte — cible : ${BASE} ===\n`);

  // --- Cas 1 : élève ayant laissé un avis + un feedback, puis supprimé individuellement ---
  const student = await signupAndVerify('STUDENT', Date.now() % 100000);
  let r = await req('POST', '/ratings', { token: student.token, device: student.device, body: { stars: 5, comment: 'Top !' } });
  check('élève laisse une note (app_ratings) -> 201', r.status === 201, r.data);
  r = await req('POST', '/feedback', { token: student.token, device: student.device, body: { message: 'Un petit souci de rien du tout.' } });
  check('élève envoie un feedback -> 201', r.status === 201, r.data);

  r = await req('DELETE', `/admin/users/${student.user.id}`, { admin: true });
  check('suppression admin de cet élève -> 200 (AVANT le correctif : 500 FOREIGN KEY)', r.status === 200, r.data);

  const stillThere = db.prepare('SELECT id FROM users WHERE id = ?').get(student.user.id);
  check('le compte élève a bien disparu de la base', !stillThere, stillThere);

  r = await req('POST', '/auth/signup', { body: { role: 'STUDENT', fullName: 'Retry', phone: student.phone, email: `retry.${Date.now()}@khatam.mr`, password: 'demo1234', serie: 'C' } });
  check('le même numéro de téléphone est réutilisable juste après (pas de compte fantôme)', r.status === 201, r.data);

  // --- Cas 2 : professeur ayant échangé un message avec l'admin, puis supprimé ---
  const prof = await signupAndVerify('PROFESSOR', (Date.now() + 1) % 100000, { etablissement: 'Lycée Test', matieres: 'Maths', experienceYears: 3 });
  r = await req('POST', `/admin/professors/${prof.user.id}/messages`, { admin: true, body: { body: 'Bienvenue sur Khatam !' } });
  check('admin envoie un message à ce professeur (admin_messages) -> 201', r.status === 201, r.data);

  r = await req('DELETE', `/admin/users/${prof.user.id}`, { admin: true });
  check('suppression admin de ce professeur -> 200 (AVANT le correctif : 500 FOREIGN KEY)', r.status === 200, r.data);
  const profStillThere = db.prepare('SELECT id FROM users WHERE id = ?').get(prof.user.id);
  check('le compte professeur a bien disparu de la base', !profStillThere, profStillThere);

  // --- Cas 3 : reset-all-users avec des comptes "à risque" présents ---
  const s2 = await signupAndVerify('STUDENT', (Date.now() + 2) % 100000);
  await req('POST', '/ratings', { token: s2.token, device: s2.device, body: { stars: 3 } });
  await req('POST', '/feedback', { token: s2.token, device: s2.device, body: { message: 'Un autre avis.' } });

  r = await req('POST', '/admin/reset-all-users', { admin: true, body: { confirm: 'SUPPRIMER TOUT' } });
  check('reset-all-users -> 200', r.status === 200, r.data);
  check('reset-all-users ne rapporte AUCUN échec (failed vide)', Array.isArray(r.data.failed) && r.data.failed.length === 0, r.data);
  const remaining = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  check('plus aucun utilisateur en base après reset-all-users', remaining === 0, remaining);

  console.log(`\n=== Résultat : ${failures === 0 ? 'TOUT PASSE ✅' : `${failures} échec(s) ❌`} ===\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('Erreur fatale des tests :', e); process.exit(1); });
