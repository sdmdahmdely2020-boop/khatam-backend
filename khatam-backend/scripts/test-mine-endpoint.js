// Test de bout en bout pour GET /api/documents/mine (profil élève — documents
// achetés + progression simple, 29/08). Complète test-api.js et
// test-subscriptions.js sans les dupliquer : vérifie uniquement ce que cette
// nouvelle route ajoute.
//
// Usage : npm start (dans un terminal, avec une base de test qui a déjà été
//         seedée : SEED_DEMO_DATA=true node scripts/seed.js si besoin) puis
//         node scripts/test-mine-endpoint.js

const db = require('../src/lib/db');

const BASE = process.env.API_BASE || 'http://localhost:4000/api';
const ADMIN_KEY = process.env.ADMIN_KEY || 'testadminkey';

function readVerificationCode(email) {
  const row = db.prepare('SELECT code FROM email_codes WHERE email = ? ORDER BY createdAt DESC LIMIT 1').get(email);
  if (!row) throw new Error(`Aucun code trouvé en base pour ${email}`);
  return row.code;
}

let failures = 0;
function check(label, cond, extra) {
  if (cond) { console.log(`OK   - ${label}`); }
  else { failures++; console.log(`FAIL - ${label}`, extra ?? ''); }
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

async function signupAndVerify(rand, suffix) {
  const phone = `2229${suffix}${rand}`.slice(0, 11);
  const email = `eleve.mine.${rand}${suffix}@khatam.mr`;
  const device = `device-mine-${rand}${suffix}`;
  const body = { role: 'STUDENT', fullName: `Élève Mine ${suffix}`, phone, email, password: 'demo1234', serie: 'C' };
  let r = await req('POST', '/auth/signup', { body });
  check(`signup élève ${suffix} -> 201`, r.status === 201, r.data);
  const code = readVerificationCode(email);
  r = await req('POST', '/auth/verify-email', { body: { email, code, deviceId: device, deviceLabel: 'test' } });
  check(`verify-email élève ${suffix} -> 200 + token`, r.status === 200 && !!r.data.token, r.data);
  return { token: r.data.token, userId: r.data.user.id, phone, email, device };
}

async function main() {
  let r = await req('PATCH', '/admin/settings', { admin: true, body: { bankily: '22200099999', masrivi: '22200088888', sedad: '22200077777' } });
  check('PATCH /admin/settings -> 200', r.status === 200, r.data);

  r = await req('GET', '/documents?serie=C');
  const docs = r.data.documents;
  const paidDoc = docs.find((d) => !d.free && !d.adUnlock);
  const adDoc = docs.find((d) => !d.free && d.adUnlock);
  check('un document payant (non-pub) existe pour le test', !!paidDoc);
  check('un document à débloquer par pub existe pour le test', !!adDoc);

  const rand = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
  const s1 = await signupAndVerify(rand, '1');

  // --- Avant toute action : liste vide, progression à zéro ---
  r = await req('GET', '/documents/mine', { token: s1.token, device: s1.device });
  check('GET /documents/mine avant toute action -> 200, liste vide, progression à zéro',
    r.status === 200 && r.data.documents.length === 0 && r.data.progress.totalUnlocked === 0 && r.data.progress.totalSpentMru === 0 && r.data.progress.isPremium === false,
    r.data);

  // --- Achat confirmé d'un document ---
  r = await req('POST', '/payments/initiate', { token: s1.token, device: s1.device, body: { documentId: paidDoc.id, method: 'bankily' } });
  check('POST /payments/initiate -> 201', r.status === 201, r.data);
  const purchaseId = r.data.purchaseId;
  await req('POST', `/payments/${purchaseId}/submit-reference`, { token: s1.token, device: s1.device, body: { reference: 'BKY-MINE-0001' } });
  r = await req('POST', `/admin/purchases/${purchaseId}/confirm`, { admin: true });
  check('confirmation admin achat -> 200', r.status === 200, r.data);

  // --- Déblocage par publicité d'un deuxième document ---
  r = await req('POST', `/documents/${adDoc.id}/ad-unlock`, { token: s1.token, device: s1.device, body: { watchedMs: 5000 } });
  check('POST ad-unlock -> unlocked true', r.status === 200 && r.data.unlocked === true, r.data);

  // --- GET /documents/mine reflète les deux ---
  r = await req('GET', '/documents/mine', { token: s1.token, device: s1.device });
  check('GET /documents/mine -> 2 documents', r.status === 200 && r.data.documents.length === 2, r.data);
  const purchasedEntry = r.data.documents.find((d) => d.id === paidDoc.id);
  const adEntry = r.data.documents.find((d) => d.id === adDoc.id);
  check('le document acheté a acquiredVia=purchase et amountPaid=prix', !!purchasedEntry && purchasedEntry.acquiredVia === 'purchase' && purchasedEntry.amountPaid === paidDoc.prix, purchasedEntry);
  check('le document débloqué par pub a acquiredVia=ad et amountPaid=0', !!adEntry && adEntry.acquiredVia === 'ad' && adEntry.amountPaid === 0, adEntry);
  check('progress.totalUnlocked = 2', r.data.progress.totalUnlocked === 2, r.data.progress);
  check('progress.totalSpentMru = prix du document acheté', r.data.progress.totalSpentMru === paidDoc.prix, r.data.progress);
  check('progress.byMatiere contient bien les deux matières', Object.values(r.data.progress.byMatiere).reduce((a, b) => a + b, 0) === 2, r.data.progress.byMatiere);
  check('chaque document renvoyé porte bien previewUrl/professor (forme enrichie, comme le catalogue)', !!purchasedEntry.previewUrl && !!purchasedEntry.professor, purchasedEntry);

  // --- Achat d'un même document une deuxième fois (déjà débloqué) doit être refusé plus haut dans le flux, donc pas testé ici ---
  // --- Passage à Premium : la liste "documents/mine" reste basée sur les actions concrètes, pas sur l'accès Premium ---
  r = await req('POST', '/subscriptions/purchase', { token: s1.token, device: s1.device, body: { plan: 'premium', method: 'sedad' } });
  const subId = r.data.purchaseId;
  await req('POST', `/admin/subscriptions/${subId}/confirm`, { admin: true });

  r = await req('GET', '/documents/mine', { token: s1.token, device: s1.device });
  check('GET /documents/mine après passage Premium -> toujours 2 documents (pas tout le catalogue), isPremium=true',
    r.status === 200 && r.data.documents.length === 2 && r.data.progress.isPremium === true, r.data.progress);

  console.log('\n--- Résumé ---');
  if (failures === 0) console.log('Tous les tests sont passés.');
  else console.log(`${failures} test(s) en échec.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
