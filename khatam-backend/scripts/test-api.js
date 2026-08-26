// Test de bout en bout sur l'API en cours d'exécution (npm start ou npm run dev).
// Usage : npm run test:api
//
// Nécessite le même fichier de base que le serveur testé (lit directement
// email_codes pour récupérer le code de vérification — ce code n'est JAMAIS
// renvoyé par l'API elle-même, voir lib/email.js, donc ce script n'a pas
// d'autre moyen de le connaître ; c'est vrai que l'envoi Gmail soit configuré
// ou non, puisque contrairement à l'ancien Twilio Verify, le code est
// toujours géré localement).
const db = require('../src/lib/db');

const BASE = process.env.API_BASE || 'http://localhost:4000/api';
const ADMIN_KEY = process.env.ADMIN_KEY || 'testadminkey';

// Lit le dernier code généré pour cet email.
function readVerificationCode(email) {
  const row = db.prepare('SELECT code FROM email_codes WHERE email = ? ORDER BY createdAt DESC LIMIT 1').get(email);
  if (!row) throw new Error(`Aucun code trouvé en base pour ${email}`);
  return row.code;
}

let failures = 0;
function check(label, cond, extra) {
  if (cond) {
    console.log(`OK   - ${label}`);
  } else {
    failures++;
    console.log(`FAIL - ${label}`, extra ?? '');
  }
}

async function req(method, path, { token, device, body, isForm, admin } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (device) headers['X-Device-Id'] = device;
  if (admin) headers['X-Admin-Key'] = ADMIN_KEY;
  let fetchBody;
  if (isForm) {
    fetchBody = body; // FormData
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(body);
  }
  const r = await fetch(`${BASE}${path}`, { method, headers, body: fetchBody });
  const contentType = r.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await r.json() : await r.arrayBuffer();
  return { status: r.status, data, headers: r.headers };
}

// Confirme un achat via le panneau admin (remplace l'ancien webhook auto-appelé
// par le client — voir routes/admin.js, "Paiement manuel réel").
async function confirmAsAdmin(purchaseId) {
  return req('POST', `/admin/purchases/${purchaseId}/confirm`, { admin: true });
}

async function main() {
  // --- Réglages admin : numéros de réception (nécessaires pour initier un paiement) ---
  let rSettings = await req('PATCH', '/admin/settings', {
    admin: true,
    body: { bankily: '22200099999', masrivi: '22200088888', sedad: '22200077777' },
  });
  check('PATCH /admin/settings -> 200', rSettings.status === 200, rSettings.data);

  const rand = Math.floor(Math.random() * 1e8);
  const studentPhone = `2221${rand}`.slice(0, 11);
  const studentEmail = `eleve.test.${rand}@khatam.mr`;
  const deviceA = `device-A-${rand}`;
  const deviceB = `device-B-${rand}`;

  // --- Inscription élève : ne renvoie plus de jeton directement, un code de
  // vérification envoyé par email doit d'abord être validé via /auth/verify-email. ---
  let r = await req('POST', '/auth/signup', { body: {
    role: 'STUDENT', fullName: 'Élève Test', phone: studentPhone, email: studentEmail, password: 'demo1234', serie: 'C',
  }});
  check('signup élève -> 201 needsVerification', r.status === 201 && r.data.needsVerification === true, r.data);

  // --- Sécurité : login avant vérification de l'email doit être refusé ---
  r = await req('POST', '/auth/login', { body: { phone: studentPhone, password: 'demo1234', deviceId: deviceA } });
  check('login avant vérification -> 403 EMAIL_NOT_VERIFIED', r.status === 403 && r.data.error === 'EMAIL_NOT_VERIFIED', r.data);

  // --- Sécurité : mauvais code -> refusé ---
  r = await req('POST', '/auth/verify-email', { body: { email: studentEmail, code: '000000', deviceId: deviceA } });
  check('verify-email mauvais code -> 400 INVALID_CODE', r.status === 400 && r.data.error === 'INVALID_CODE', r.data);

  // --- Bon code (toujours géré localement, lu directement en base) -> jeton reçu ---
  const studentCode = readVerificationCode(studentEmail);
  r = await req('POST', '/auth/verify-email', { body: { email: studentEmail, code: studentCode, deviceId: deviceA, deviceLabel: 'Test runner élève' } });
  check('verify-email bon code -> 200 avec jeton', r.status === 200 && !!r.data.token, r.data);
  const studentToken0 = r.data.token;

  // Délie l'appareil du compte professeur de démo pour que ce script soit rejouable
  // (sinon il resterait lié à l'appareil du run précédent).
  await req('POST', '/auth/device/release', { body: { phone: '22200000001', password: 'demo1234' } });

  // --- Connexion professeur seed (login lie l'appareil A) ---
  r = await req('POST', '/auth/login', { body: { phone: '22200000001', password: 'demo1234', deviceId: deviceA, deviceLabel: 'Test runner' } });
  check('login professeur (device A) -> 200', r.status === 200, r.data);
  const profToken = r.data.token;
  const profId = r.data.user.id;

  // --- Sécurité : login professeur depuis un AUTRE appareil doit être refusé ---
  r = await req('POST', '/auth/login', { body: { phone: '22200000001', password: 'demo1234', deviceId: deviceB } });
  check('login professeur (device B, différent) -> 409 DEVICE_MISMATCH', r.status === 409 && r.data.error === 'DEVICE_MISMATCH', r.data);

  // --- Connexion élève créé plus haut, lie deviceA ---
  r = await req('POST', '/auth/login', { body: { phone: studentPhone, password: 'demo1234', deviceId: deviceA } });
  check('login élève (device A) -> 200', r.status === 200, r.data);
  const studentToken = r.data.token;
  const studentId = r.data.user.id;

  // --- Requête professeur SANS le bon en-tête X-Device-Id doit échouer ---
  r = await req('GET', '/wallet', { token: profToken }); // pas de device header
  check('GET /wallet sans X-Device-Id -> 409', r.status === 409, r.data);

  // --- Catalogue public trié (boost/likes) ---
  r = await req('GET', '/documents?serie=C');
  check('GET /documents -> 200 avec des documents', r.status === 200 && r.data.documents.length > 0, r.data);
  const docs = r.data.documents;
  const freeDoc = docs.find((d) => d.free);
  // paidDoc/aiDoc doivent appartenir au professeur de démo (profId) : les ventes qui les
  // concernent alimentent son portefeuille, vérifié plus bas. Le tri du catalogue (boost/likes)
  // n'est pas déterministe entre les deux professeurs de seed — filtrer par professor.id
  // évite un test qui échoue au hasard selon l'ordre retourné.
  const aiDoc = docs.find((d) => d.aiGrading && !d.free && d.professor.id === profId);
  const paidDoc = docs.find((d) => !d.free && !d.adUnlock && !d.aiGrading && d.professor.id === profId && d.id !== aiDoc?.id);
  const adDoc = docs.find((d) => d.adUnlock && !d.free);
  check('un document gratuit existe', !!freeDoc);
  check('un document payant (sans IA) existe', !!paidDoc);
  check('un document déblocable par pub existe', !!adDoc);
  check('un document avec correction IA existe', !!aiDoc);

  // --- Document gratuit : accès direct au viewer sécurisé ---
  r = await req('GET', `/documents/${freeDoc.id}/view`, { token: studentToken, device: deviceA });
  check('view document gratuit -> 200 PDF', r.status === 200, r.status);

  // --- Document payant : accès refusé avant paiement ---
  r = await req('GET', `/documents/${paidDoc.id}/view`, { token: studentToken, device: deviceA });
  check('view document payant NON débloqué -> 403 LOCKED', r.status === 403 && r.data.error === 'LOCKED', r.data);

  // --- Paiement : initiation + confirmation manuelle admin (numéro de reçu élève) ---
  r = await req('POST', '/payments/initiate', { token: studentToken, device: deviceA, body: { documentId: paidDoc.id, method: 'bankily' } });
  check('POST /payments/initiate -> 201 pending avec un numéro à payer', r.status === 201 && r.data.status === 'pending' && !!r.data.payTo, r.data);
  const purchaseId1 = r.data.purchaseId;

  r = await req('POST', `/payments/${purchaseId1}/submit-reference`, { token: studentToken, device: deviceA, body: { reference: 'BKY-TEST-0001' } });
  check('submit-reference -> 200', r.status === 200, r.data);

  r = await confirmAsAdmin(purchaseId1);
  check('confirmation admin -> 200 confirmed', r.status === 200 && r.data.purchase.status === 'confirmed', r.data);

  // --- Document payant : accès autorisé après paiement confirmé ---
  r = await req('GET', `/documents/${paidDoc.id}/view`, { token: studentToken, device: deviceA });
  check('view document payant APRÈS paiement -> 200 PDF filigrané', r.status === 200, r.status);

  // --- Déblocage par publicité ---
  r = await req('POST', `/documents/${adDoc.id}/ad-unlock`, { token: studentToken, device: deviceA, body: { watchedMs: 5000 } });
  check('ad-unlock -> unlocked:true', r.status === 200 && r.data.unlocked === true, r.data);
  r = await req('GET', `/documents/${adDoc.id}/view`, { token: studentToken, device: deviceA });
  check('view document débloqué par pub -> 200', r.status === 200, r.status);

  // --- Favoris ---
  r = await req('POST', `/documents/${freeDoc.id}/favorite`, { token: studentToken, device: deviceA });
  check('toggle favori -> favorited:true', r.status === 200 && r.data.favorited === true, r.data);

  // --- Likes + classement professeur ---
  r = await req('POST', `/professors/${profId}/like`, { token: studentToken, device: deviceA });
  check('like professeur -> liked:true', r.status === 200 && r.data.liked === true, r.data);

  // --- Correction IA (stub) ---
  r = await req('POST', `/documents/${aiDoc.id}/ai-grade`, { token: studentToken, device: deviceA, body: { answerText: 'Voici ma réponse détaillée avec plusieurs étapes de calcul et justifications.' } });
  check('ai-grade sur document non débloqué -> 403', r.status === 403, r.data);

  // débloque aiDoc par achat pour tester le succès
  r = await req('POST', '/payments/initiate', { token: studentToken, device: deviceA, body: { documentId: aiDoc.id, method: 'masrivi' } });
  await confirmAsAdmin(r.data.purchaseId);
  r = await req('POST', `/documents/${aiDoc.id}/ai-grade`, { token: studentToken, device: deviceA, body: { answerText: 'Voici ma réponse détaillée avec plusieurs étapes de calcul et justifications solides.' } });
  check('ai-grade après déblocage -> 201 avec une note', r.status === 201 && typeof r.data.submission.note === 'number', r.data);

  // --- Portefeuille professeur : le paiement confirmé doit avoir crédité le solde ---
  r = await req('GET', '/wallet', { token: profToken, device: deviceA });
  check('GET /wallet -> solde > 0 après ventes', r.status === 200 && r.data.balance > 0, r.data);

  // Assez de ventes pour couvrir le prix du Boost (500 MRU) : achète un 3e document.
  const thirdDoc = docs.find((d) => !d.free && d.professor.id === profId && d.id !== paidDoc.id && d.id !== aiDoc.id);
  if (thirdDoc) {
    r = await req('POST', '/payments/initiate', { token: studentToken, device: deviceA, body: { documentId: thirdDoc.id, method: 'sedad' } });
    if (r.status === 201) await confirmAsAdmin(r.data.purchaseId);
  }

  // --- Boost professeur ---
  r = await req('POST', '/professors/me/boost', { token: profToken, device: deviceA });
  check('activation boost -> boosted:true', r.status === 200 && r.data.boosted === true, r.data);

  r = await req('GET', '/documents?serie=C');
  const firstDoc = r.data.documents[0];
  check('après boost, le premier document du catalogue appartient au prof boosté', firstDoc.professorBoosted === true, firstDoc);

  // --- Retrait ---
  r = await req('POST', '/wallet/withdraw', { token: profToken, device: deviceA, body: { amount: 50, method: 'bankily', accountRef: '22200000001' } });
  check('retrait 50 MRU -> 201', r.status === 201, r.data);
  const withdrawalId = r.data.withdrawal.id;

  // --- Sécurité : la clé admin est obligatoire sur les routes d'administration ---
  r = await req('GET', '/admin/purchases/pending'); // pas de X-Admin-Key
  check('GET /admin/purchases/pending sans clé -> 401', r.status === 401, r.data);
  r = await req('POST', `/payments/webhook/bankily`, { body: { providerRef: 'x', status: 'confirmed' } }); // pas de clé
  check('POST /payments/webhook sans clé -> 401', r.status === 401, r.data);

  // --- Admin : marquer un retrait comme payé ---
  r = await req('POST', `/admin/withdrawals/${withdrawalId}/mark-paid`, { admin: true });
  check('admin mark-paid retrait -> 200 status paid', r.status === 200 && r.data.withdrawal.status === 'paid', r.data);

  // --- Inscription professeur + vérification + approbation admin ---
  const newProfPhone = `2223${rand}`.slice(0, 11);
  const newProfEmail = `prof.attente.${rand}@khatam.mr`;
  const deviceC = `device-C-${rand}`;

  // Champs professeur manquants (établissement/matières) -> refusé
  r = await req('POST', '/auth/signup', { body: {
    role: 'PROFESSOR', fullName: 'Prof En Attente', phone: newProfPhone, email: newProfEmail, password: 'demo1234',
  }});
  check('signup professeur sans établissement -> 400 MISSING_FIELDS', r.status === 400 && r.data.error === 'MISSING_FIELDS', r.data);

  r = await req('POST', '/auth/signup', { body: {
    role: 'PROFESSOR', fullName: 'Prof En Attente', phone: newProfPhone, email: newProfEmail, password: 'demo1234',
    etablissement: 'Lycée Test', matieres: 'Philosophie', experienceYears: 5,
  }});
  check('signup professeur complet -> 201 needsVerification', r.status === 201 && r.data.needsVerification === true, r.data);

  const newProfCode = readVerificationCode(newProfEmail);
  r = await req('POST', '/auth/verify-email', { body: { email: newProfEmail, code: newProfCode, deviceId: deviceC, deviceLabel: 'Test runner nouveau prof' } });
  check('verify-email nouveau professeur -> 200 avec jeton', r.status === 200 && !!r.data.token, r.data);
  const newProfToken = r.data.token;
  const newProfId = r.data.user.id;
  check('nouveau professeur -> professorStatus pending', r.data.user.professorStatus === 'pending', r.data.user);

  // Le nouveau professeur peut se connecter et préparer un document, mais il
  // est automatiquement créé en brouillon (non approuvé) — jamais publié.
  const fd = new FormData();
  fd.append('title', 'Document brouillon (en attente d’approbation)');
  fd.append('matiere', 'Philosophie');
  fd.append('serie', 'A');
  fd.append('annee', '2026');
  fd.append('type', 'cours');
  fd.append('prix', '100');
  fd.append('file', new Blob([Buffer.from('%PDF-1.4\n%%EOF')], { type: 'application/pdf' }), 'cours.pdf');
  r = await req('POST', '/documents', { token: newProfToken, device: deviceC, isForm: true, body: fd });
  check('upload document par professeur non approuvé -> 201 en brouillon', r.status === 201 && r.data.document.statut === 'brouillon' && r.data.professorPending === true, r.data);
  const pendingDocId = r.data.document.id;

  // Impossible de le publier soi-même tant que le compte n'est pas approuvé.
  r = await req('PATCH', `/documents/${pendingDocId}`, { token: newProfToken, device: deviceC, body: { statut: 'publie' } });
  check('publier soi-même avant approbation -> 403 PROFESSOR_NOT_APPROVED', r.status === 403 && r.data.error === 'PROFESSOR_NOT_APPROVED', r.data);

  // Invisible du catalogue public, mais visible par son propre auteur.
  r = await req('GET', '/documents?serie=A');
  check('brouillon absent du catalogue public', !r.data.documents.some((d) => d.id === pendingDocId), r.data);
  r = await req('GET', '/documents?serie=A', { token: newProfToken, device: deviceC });
  check('brouillon visible par son auteur', r.data.documents.some((d) => d.id === pendingDocId), r.data);

  // --- Admin : liste des professeurs en attente, puis approbation ---
  r = await req('GET', '/admin/professors/pending', { admin: true });
  check('GET /admin/professors/pending contient le nouveau professeur', r.status === 200 && r.data.professors.some((p) => p.id === newProfId), r.data);

  r = await req('POST', `/admin/professors/${newProfId}/approve`, { admin: true });
  check('approbation admin -> 200 professorStatus approved', r.status === 200 && r.data.professor.professorStatus === 'approved', r.data);

  // Une fois approuvé, le professeur peut maintenant publier ce même document.
  r = await req('PATCH', `/documents/${pendingDocId}`, { token: newProfToken, device: deviceC, body: { statut: 'publie' } });
  check('publier après approbation -> 200 statut publie', r.status === 200 && r.data.document.statut === 'publie', r.data);
  r = await req('GET', '/documents?serie=A');
  check('document désormais visible dans le catalogue public', r.data.documents.some((d) => d.id === pendingDocId), r.data);

  // --- Le professeur peut modifier puis supprimer son propre document ---
  r = await req('PATCH', `/documents/${pendingDocId}`, { token: newProfToken, device: deviceC, body: { title: 'Titre modifié par le professeur' } });
  check('modification du document par son auteur -> 200', r.status === 200 && r.data.document.title === 'Titre modifié par le professeur', r.data);
  r = await req('DELETE', `/documents/${pendingDocId}`, { token: newProfToken, device: deviceC });
  check('suppression du document par son auteur -> 200', r.status === 200, r.data);
  r = await req('GET', `/documents/${pendingDocId}`);
  check('document supprimé -> 404', r.status === 404, r.data);

  console.log('\n' + (failures === 0 ? `TOUS LES TESTS SONT PASSÉS ✔` : `${failures} TEST(S) EN ÉCHEC ✘`));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
