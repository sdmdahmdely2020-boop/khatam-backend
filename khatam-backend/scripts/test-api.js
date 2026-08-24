// Test de bout en bout sur l'API en cours d'exécution (npm start ou npm run dev).
// Usage : npm run test:api
const BASE = process.env.API_BASE || 'http://localhost:4000/api';

let failures = 0;
function check(label, cond, extra) {
  if (cond) {
    console.log(`OK   - ${label}`);
  } else {
    failures++;
    console.log(`FAIL - ${label}`, extra ?? '');
  }
}

async function req(method, path, { token, device, body, isForm } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (device) headers['X-Device-Id'] = device;
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

async function main() {
  const rand = Math.floor(Math.random() * 1e8);
  const studentPhone = `2221${rand}`.slice(0, 11);
  const deviceA = `device-A-${rand}`;
  const deviceB = `device-B-${rand}`;

  // --- Inscription élève ---
  let r = await req('POST', '/auth/signup', { body: {
    role: 'STUDENT', fullName: 'Élève Test', phone: studentPhone, password: 'demo1234', serie: 'C',
  }});
  check('signup élève -> 201', r.status === 201, r.data);
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
  const aiDoc = docs.find((d) => d.aiGrading && !d.free);
  const paidDoc = docs.find((d) => !d.free && !d.adUnlock && !d.aiGrading && d.id !== aiDoc?.id);
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

  // --- Paiement : initiation + webhook de confirmation (simulateur Bankily) ---
  r = await req('POST', '/payments/initiate', { token: studentToken, device: deviceA, body: { documentId: paidDoc.id, method: 'bankily' } });
  check('POST /payments/initiate -> 201 pending', r.status === 201 && r.data.status === 'pending', r.data);
  const providerRef = r.data.providerRef;

  r = await req('POST', '/payments/webhook/bankily', { body: { providerRef, status: 'confirmed' } });
  check('webhook bankily confirmed -> 200', r.status === 200, r.data);

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
  const ref2 = r.data.providerRef;
  await req('POST', '/payments/webhook/masrivi', { body: { providerRef: ref2, status: 'confirmed' } });
  r = await req('POST', `/documents/${aiDoc.id}/ai-grade`, { token: studentToken, device: deviceA, body: { answerText: 'Voici ma réponse détaillée avec plusieurs étapes de calcul et justifications solides.' } });
  check('ai-grade après déblocage -> 201 avec une note', r.status === 201 && typeof r.data.submission.note === 'number', r.data);

  // --- Portefeuille professeur : le paiement confirmé doit avoir crédité le solde ---
  r = await req('GET', '/wallet', { token: profToken, device: deviceA });
  check('GET /wallet -> solde > 0 après ventes', r.status === 200 && r.data.balance > 0, r.data);

  // Assez de ventes pour couvrir le prix du Boost (500 MRU) : achète un 3e document.
  const thirdDoc = docs.find((d) => !d.free && d.id !== paidDoc.id && d.id !== aiDoc.id);
  if (thirdDoc) {
    r = await req('POST', '/payments/initiate', { token: studentToken, device: deviceA, body: { documentId: thirdDoc.id, method: 'sedad' } });
    if (r.status === 201) await req('POST', '/payments/webhook/sedad', { body: { providerRef: r.data.providerRef, status: 'confirmed' } });
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

  console.log('\n' + (failures === 0 ? `TOUS LES TESTS SONT PASSÉS ✔` : `${failures} TEST(S) EN ÉCHEC ✘`));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
