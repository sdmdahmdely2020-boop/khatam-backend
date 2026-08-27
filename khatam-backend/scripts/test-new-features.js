// Test de bout en bout pour les 7 nouvelles fonctionnalités ajoutées le
// 27/08 : ads.zone (carrousel), feedback + WhatsApp, FAQ/À propos,
// mot de passe oublié, note de l'application (étoiles), messagerie
// admin <-> professeur. Complète scripts/test-api.js (qui couvre déjà tout
// le flux principal) sans le dupliquer.
// Usage : npm start (dans un terminal) puis node scripts/test-new-features.js
const db = require('../src/lib/db');

const BASE = process.env.API_BASE || 'http://localhost:4000/api';
const ADMIN_KEY = process.env.ADMIN_KEY || 'testadminkey';

function readVerificationCode(email) {
  const row = db.prepare('SELECT code FROM email_codes WHERE email = ? ORDER BY createdAt DESC LIMIT 1').get(email);
  if (!row) throw new Error(`Aucun code trouvé en base pour ${email}`);
  return row.code;
}
function readResetCode(email) {
  const row = db.prepare("SELECT code FROM email_codes WHERE email = ? AND purpose = 'reset' ORDER BY createdAt DESC LIMIT 1").get(email);
  if (!row) throw new Error(`Aucun code de réinitialisation trouvé pour ${email}`);
  return row.code;
}

let failures = 0;
function check(label, cond, extra) {
  if (cond) { console.log(`OK   - ${label}`); }
  else { failures++; console.log(`FAIL - ${label}`, extra ?? ''); }
}

async function req(method, path, { token, device, body, isForm, admin } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (device) headers['X-Device-Id'] = device;
  if (admin) headers['X-Admin-Key'] = ADMIN_KEY;
  let fetchBody;
  if (isForm) { fetchBody = body; }
  else if (body) { headers['Content-Type'] = 'application/json'; fetchBody = JSON.stringify(body); }
  const r = await fetch(`${BASE}${path}`, { method, headers, body: fetchBody });
  const contentType = r.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await r.json() : await r.arrayBuffer();
  return { status: r.status, data };
}

async function signupAndVerify(role, rand, extra = {}) {
  // Préfixe différent par rôle (comme scripts/test-api.js) — deux `rand`
  // proches (ex. rand et rand+1) produiraient sinon le même numéro une fois
  // tronqué à 11 chiffres, et le 2e signup échouerait en PHONE_TAKEN.
  const prefix = role === 'PROFESSOR' ? '2227' : '2229';
  const phone = `${prefix}${rand}`.slice(0, 11);
  const email = `${role.toLowerCase()}.nf.${rand}@khatam.mr`;
  const device = `device-nf-${role}-${rand}`;
  const body = { role, fullName: `${role} NF Test`, phone, email, password: 'demo1234', serie: 'C', ...extra };
  let r = await req('POST', '/auth/signup', { body });
  check(`signup ${role} -> 201`, r.status === 201, r.data);
  const code = readVerificationCode(email);
  r = await req('POST', '/auth/verify-email', { body: { email, code, deviceId: device, deviceLabel: 'test' } });
  check(`verify-email ${role} -> 200 + token`, r.status === 200 && !!r.data.token, r.data);
  return { token: r.data.token, user: r.data.user, phone, email, device };
}

async function main() {
  const rand = Math.floor(Math.random() * 1e8);

  const student = await signupAndVerify('STUDENT', rand);
  const prof = await signupAndVerify('PROFESSOR', rand + 1, { etablissement: 'Lycée Test', matieres: 'Mathématiques', experienceYears: 5 });

  // Le professeur doit être approuvé pour certains tests (pas strictement
  // nécessaire pour la messagerie/ads/feedback, mais on le fait pour rester
  // proche d'un vrai scénario).
  let r = await req('POST', `/admin/professors/${prof.user.id}/approve`, { admin: true });
  check('approbation admin du professeur NF -> 200', r.status === 200, r.data);

  // ===================== 1. FAQ / À propos =====================
  r = await req('GET', '/content');
  check('GET /content public -> 200', r.status === 200 && Array.isArray(r.data.faq), r.data);

  r = await req('PATCH', '/admin/content', { admin: true, body: {
    faq: [{ question: 'Comment payer ?', reponse: 'Via Bankily, Masrivi ou Sedad.' }],
    about: 'Khatam est la plateforme du Bac mauritanien.',
  }});
  check('PATCH /admin/content -> 200', r.status === 200 && r.data.faq.length === 1, r.data);

  r = await req('GET', '/content');
  check('GET /content reflète la mise à jour', r.status === 200 && r.data.faq[0].question === 'Comment payer ?' && r.data.about.includes('Khatam'), r.data);

  r = await req('GET', '/admin/content', { admin: true });
  check('GET /admin/content (lecture admin) -> 200', r.status === 200 && r.data.faq.length === 1, r.data);

  // ===================== 2. Feedback (+ WhatsApp gracieux) =====================
  r = await req('POST', '/feedback', { token: student.token, device: student.device, body: {
    contact: student.phone, message: 'Test de feedback automatisé.',
  }});
  check('POST /feedback (connecté) -> 201', r.status === 201, r.data);

  r = await req('POST', '/feedback', { body: { name: 'Anonyme NF', message: 'Feedback sans compte.' } });
  check('POST /feedback (anonyme) -> 201', r.status === 201, r.data);

  r = await req('POST', '/feedback', { body: { message: '' } });
  check('POST /feedback message vide -> 400', r.status === 400, r.data);

  r = await req('GET', '/admin/feedback', { admin: true });
  check('GET /admin/feedback -> 201... contient les 2 envois', r.status === 200 && r.data.feedback.length >= 2, r.data);

  // ===================== 3. Note de l'application (étoiles) =====================
  r = await req('POST', '/ratings', { token: student.token, device: student.device, body: { stars: 4, comment: 'Bien mais peut mieux faire.' } });
  check('POST /ratings élève -> 201', r.status === 201, r.data);

  r = await req('GET', '/ratings/me', { token: student.token, device: student.device });
  check('GET /ratings/me reflète la note', r.status === 200 && r.data.rating && r.data.rating.stars === 4, r.data);

  // Un second envoi doit REMPLACER le premier (UPSERT), pas en créer un second.
  r = await req('POST', '/ratings', { token: student.token, device: student.device, body: { stars: 5 } });
  check('POST /ratings (2e envoi = upsert) -> 201', r.status === 201, r.data);
  r = await req('GET', '/ratings/me', { token: student.token, device: student.device });
  check('GET /ratings/me reflète le nouvel envoi (5)', r.data.rating.stars === 5, r.data);

  r = await req('POST', '/ratings', { token: student.token, device: student.device, body: { stars: 7 } });
  check('POST /ratings stars invalide (7) -> 400', r.status === 400, r.data);

  r = await req('GET', '/admin/ratings', { admin: true });
  check('GET /admin/ratings -> 200 avec moyenne', r.status === 200 && typeof r.data.average === 'number', r.data);

  // ===================== 4. Mot de passe oublié =====================
  r = await req('POST', '/auth/forgot-password', { body: { email: student.email } });
  check('POST /auth/forgot-password (email existant) -> 200 sent:true', r.status === 200 && r.data.sent === true, r.data);

  r = await req('POST', '/auth/forgot-password', { body: { email: 'inconnu.nf@khatam.mr' } });
  check('POST /auth/forgot-password (email inconnu) -> 200 identique (anti-énumération)', r.status === 200 && r.data.sent === true, r.data);

  const resetCode = readResetCode(student.email);
  r = await req('POST', '/auth/reset-password', { body: { email: student.email, code: '000000', newPassword: 'nouveauPass1' } });
  check('POST /auth/reset-password mauvais code -> 400', r.status === 400, r.data);

  r = await req('POST', '/auth/reset-password', { body: { email: student.email, code: resetCode, newPassword: 'nouveauPass1' } });
  check('POST /auth/reset-password bon code -> 200', r.status === 200, r.data);

  r = await req('POST', '/auth/login', { body: { phone: student.phone, password: 'nouveauPass1', deviceId: student.device } });
  check('login avec le nouveau mot de passe -> 200', r.status === 200 && !!r.data.token, r.data);

  r = await req('POST', '/auth/login', { body: { phone: student.phone, password: 'demo1234', deviceId: student.device } });
  check("login avec l'ancien mot de passe refusé -> 401", r.status === 401, r.data);

  // (L'isolation purpose='signup' vs purpose='reset' — un code d'inscription
  // ne doit jamais servir à réinitialiser le mot de passe — est garantie par
  // construction : sendVerificationEmail()/checkVerificationCode() sont
  // toujours appelés avec purpose='reset' ici, voir routes/auth.js. Le code
  // d'inscription du professeur est de toute façon déjà supprimé de la base
  // une fois consommé par verify-email, voir lib/email.js checkVerificationCode.)

  // ===================== 5. Ads — carrousel (zone catalog/dashboard) =====================
  r = await req('POST', '/admin/ads', { admin: true, isForm: true, body: (() => {
    const f = new FormData();
    f.append('advertiserName', 'Annonceur Catalogue NF');
    f.append('placement', 'banner');
    f.append('zone', 'catalog');
    return f;
  })() });
  check('POST /admin/ads zone=catalog -> 201', r.status === 201 && r.data.ad.zone === 'catalog', r.data);
  const adCatalogId = r.data.ad && r.data.ad.id;

  r = await req('POST', '/admin/ads', { admin: true, isForm: true, body: (() => {
    const f = new FormData();
    f.append('advertiserName', 'Annonceur Dashboard NF');
    f.append('placement', 'banner');
    f.append('zone', 'dashboard');
    return f;
  })() });
  check('POST /admin/ads zone=dashboard -> 201', r.status === 201 && r.data.ad.zone === 'dashboard', r.data);
  const adDashboardId = r.data.ad && r.data.ad.id;

  r = await req('POST', '/admin/ads', { admin: true, isForm: true, body: (() => {
    const f = new FormData();
    f.append('advertiserName', 'Zone invalide NF');
    f.append('placement', 'banner');
    f.append('zone', 'nimportequoi');
    return f;
  })() });
  check('POST /admin/ads zone invalide -> 400', r.status === 400, r.data);

  r = await req('GET', '/ads/list?placement=banner&zone=catalog');
  check('GET /ads/list zone=catalog contient seulement les ads catalog', r.status === 200 && r.data.ads.some((a) => a.id === adCatalogId) && !r.data.ads.some((a) => a.id === adDashboardId), r.data);

  r = await req('GET', '/ads/list?placement=banner&zone=dashboard');
  check('GET /ads/list zone=dashboard contient seulement les ads dashboard', r.status === 200 && r.data.ads.some((a) => a.id === adDashboardId) && !r.data.ads.some((a) => a.id === adCatalogId), r.data);

  r = await req('GET', '/ads/list?placement=banner&zone=zoneinvalide');
  check('GET /ads/list zone invalide -> 400', r.status === 400, r.data);

  // Nettoyage des annonces de test pour ne pas polluer le carrousel de démo.
  if (adCatalogId) await req('DELETE', `/admin/ads/${adCatalogId}`, { admin: true });
  if (adDashboardId) await req('DELETE', `/admin/ads/${adDashboardId}`, { admin: true });

  // ===================== 6. Messagerie admin <-> professeur =====================
  r = await req('GET', `/admin/professors/${prof.user.id}/messages`, { admin: true });
  check('GET /admin/professors/:id/messages (vide au départ) -> 200', r.status === 200 && Array.isArray(r.data.messages), r.data);

  r = await req('POST', `/admin/professors/${prof.user.id}/messages`, { admin: true, body: { body: 'Bonjour, question sur votre document.' } });
  check('POST /admin/professors/:id/messages (admin -> prof) -> 201', r.status === 201, r.data);

  r = await req('GET', '/professors/me/messages', { token: prof.token, device: prof.device });
  check('GET /professors/me/messages voit le message admin', r.status === 200 && r.data.messages.some((m) => m.sender === 'admin'), r.data);

  r = await req('GET', '/professors/me/messages/unread-count', { token: prof.token, device: prof.device });
  check('unread-count = 0 après lecture (marqué lu par le GET précédent)', r.status === 200 && r.data.count === 0, r.data);

  r = await req('POST', '/professors/me/messages', { token: prof.token, device: prof.device, body: { body: 'Bonjour, oui je réponds.' } });
  check('POST /professors/me/messages (prof -> admin) -> 201', r.status === 201, r.data);

  r = await req('GET', '/admin/professors/unread-messages-count', { admin: true });
  check('GET /admin/professors/unread-messages-count >= 1', r.status === 200 && r.data.count >= 1, r.data);

  r = await req('GET', `/admin/professors/${prof.user.id}/messages`, { admin: true });
  check('GET /admin/professors/:id/messages voit maintenant 2 messages', r.status === 200 && r.data.messages.length === 2, r.data);

  r = await req('POST', '/professors/me/messages', { token: prof.token, device: prof.device, body: { body: '' } });
  check('POST /professors/me/messages vide -> 400', r.status === 400, r.data);

  console.log('\n' + (failures === 0 ? `TOUS LES TESTS (NOUVELLES FONCTIONNALITÉS) SONT PASSÉS ✔` : `${failures} TEST(S) EN ÉCHEC ✘`));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
