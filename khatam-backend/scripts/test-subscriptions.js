// Test de bout en bout pour le système d'abonnement Basic/Premium (modèle
// HYBRIDE, 29/08 — voir lib/subscriptions.js). Complète scripts/test-api.js
// (qui couvre déjà tout le flux d'achat à l'unité) sans le dupliquer :
// vérifie uniquement ce que l'abonnement AJOUTE, et qu'il ne casse rien
// d'existant (achat à l'unité toujours possible, prix inchangé côté "prix").
//
// Usage : npm start (dans un terminal, avec une base de test) puis
//         node scripts/test-subscriptions.js

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
  // Préfixe "2229" (4) + suffix (1) + rand à 6 chiffres fixes = 11 chiffres
  // pile — le suffixe DOIT être placé avant rand, sinon un .slice(0, 11) sur
  // un numéro trop long le coupe et deux appels avec le même `rand` (mais un
  // suffix différent) produisent le même numéro tronqué -> PHONE_TAKEN.
  const phone = `2229${suffix}${rand}`.slice(0, 11);
  const email = `eleve.sub.${rand}${suffix}@khatam.mr`;
  const device = `device-sub-${rand}${suffix}`;
  const body = { role: 'STUDENT', fullName: `Élève Abonnement ${suffix}`, phone, email, password: 'demo1234', serie: 'C' };
  let r = await req('POST', '/auth/signup', { body });
  check(`signup élève ${suffix} -> 201`, r.status === 201, r.data);
  const code = readVerificationCode(email);
  r = await req('POST', '/auth/verify-email', { body: { email, code, deviceId: device, deviceLabel: 'test' } });
  check(`verify-email élève ${suffix} -> 200 + token`, r.status === 200 && !!r.data.token, r.data);
  return { token: r.data.token, userId: r.data.user.id, phone, email, device };
}

async function main() {
  // --- Réglages : numéros de paiement (nécessaires pour initier quoi que ce soit) ---
  let r = await req('PATCH', '/admin/settings', { admin: true, body: { bankily: '22200099999', masrivi: '22200088888', sedad: '22200077777' } });
  check('PATCH /admin/settings -> 200', r.status === 200, r.data);

  // --- Réglages d'abonnement : valeurs par défaut, puis on en fixe des connues pour le test ---
  r = await req('GET', '/admin/subscription-settings', { admin: true });
  check('GET /admin/subscription-settings -> 200 avec des valeurs par défaut', r.status === 200 && r.data.settings.basicPrice > 0, r.data);

  r = await req('PATCH', '/admin/subscription-settings', { admin: true, body: { basicPrice: 300, premiumPrice: 800, durationDays: 30, basicDiscountPercent: 20 } });
  check('PATCH /admin/subscription-settings -> 200', r.status === 200 && r.data.settings.basicDiscountPercent === 20, r.data);

  // --- Plans publics (pas besoin d'être connecté) ---
  r = await req('GET', '/subscriptions/plans');
  check('GET /subscriptions/plans -> 200, prix cohérents avec les réglages', r.status === 200 && r.data.plans.basic.price === 300 && r.data.plans.premium.price === 800, r.data);

  const rand = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
  const s1 = await signupAndVerify(rand, '1'); // élève principal : basic -> achat réduit -> premium -> cascade delete
  const s2 = await signupAndVerify(rand, '2'); // élève secondaire : renouvellement additif

  // --- Avant tout abonnement : plan = free ---
  r = await req('GET', '/subscriptions/me', { token: s1.token, device: s1.device });
  check('GET /subscriptions/me avant abonnement -> free', r.status === 200 && r.data.plan === 'free', r.data);

  // --- Achat Basic : initiate -> submit-reference -> confirmation admin ---
  r = await req('POST', '/subscriptions/purchase', { token: s1.token, device: s1.device, body: { plan: 'basic', method: 'bankily' } });
  check('POST /subscriptions/purchase (basic) -> 201, montant = 300', r.status === 201 && r.data.amount === 300 && !!r.data.payTo, r.data);
  const subPurchase1 = r.data.purchaseId;

  r = await req('POST', `/subscriptions/${subPurchase1}/submit-reference`, { token: s1.token, device: s1.device, body: { reference: 'BKY-SUB-0001' } });
  check('submit-reference abonnement -> 200', r.status === 200, r.data);

  r = await req('POST', `/admin/subscriptions/${subPurchase1}/confirm`, { admin: true });
  check('confirmation admin abonnement -> 200 confirmed', r.status === 200 && r.data.purchase.status === 'confirmed', r.data);

  r = await req('GET', '/subscriptions/me', { token: s1.token, device: s1.device });
  check('GET /subscriptions/me après confirmation -> basic, expire dans le futur', r.status === 200 && r.data.plan === 'basic' && new Date(r.data.expiresAt) > new Date(), r.data);

  // --- Le modèle existant (achat à l'unité) doit continuer à fonctionner, avec réduction Basic ---
  r = await req('GET', '/documents?serie=C');
  const docs = r.data.documents;
  const paidDoc = docs.find((d) => !d.free && !d.adUnlock);
  check('un document payant existe pour tester la réduction', !!paidDoc);

  r = await req('GET', `/documents/${paidDoc.id}`, { token: s1.token, device: s1.device });
  const docDetail = r.data.document;
  const expectedDiscounted = Math.round(paidDoc.prix * 0.8);
  // "prix" doit rester INCHANGÉ (compatibilité site web), seul "effectivePrix" reflète la réduction.
  check('GET /documents/:id -> prix inchangé, effectivePrix réduit de 20% pour un abonné Basic',
    docDetail.prix === paidDoc.prix && docDetail.effectivePrix === expectedDiscounted && docDetail.subscriptionDiscountApplied === true,
    { prix: docDetail.prix, effectivePrix: docDetail.effectivePrix, expectedDiscounted });

  // Mais côté catalogue public (pas connecté), pas de réduction affichée.
  const paidDocPublicView = docs.find((d) => d.id === paidDoc.id);
  check('GET /documents (public, non connecté) -> pas de réduction affichée', paidDocPublicView.subscriptionDiscountApplied === false, paidDocPublicView);

  // --- Achat à l'unité : le MONTANT FACTURÉ doit lui aussi être réduit (pas seulement l'affichage) ---
  r = await req('POST', '/payments/initiate', { token: s1.token, device: s1.device, body: { documentId: paidDoc.id, method: 'masrivi' } });
  check('POST /payments/initiate (abonné Basic) -> montant réduit facturé', r.status === 201 && r.data.amount === expectedDiscounted && r.data.subscriptionDiscountApplied === true, r.data);
  const docPurchaseId = r.data.purchaseId;

  // Le portefeuille du professeur doit être crédité du montant RÉDUIT (jamais du prix plein).
  const profBefore = db.prepare('SELECT walletBalance FROM users WHERE id = ?').get(paidDoc.professor.id);
  await req('POST', `/payments/${docPurchaseId}/submit-reference`, { token: s1.token, device: s1.device, body: { reference: 'MSV-SUB-0001' } });
  await req('POST', `/admin/purchases/${docPurchaseId}/confirm`, { admin: true });
  const profAfter = db.prepare('SELECT walletBalance FROM users WHERE id = ?').get(paidDoc.professor.id);
  check('portefeuille professeur crédité du montant réduit (pas du prix plein)', profAfter.walletBalance - profBefore.walletBalance === expectedDiscounted, { before: profBefore, after: profAfter, expectedDiscounted });

  // --- Passage à Premium : achat, confirmation, accès total sans achat individuel ---
  r = await req('POST', '/subscriptions/purchase', { token: s1.token, device: s1.device, body: { plan: 'premium', method: 'sedad' } });
  check('POST /subscriptions/purchase (premium, en ayant déjà Basic) -> 201', r.status === 201 && r.data.amount === 800, r.data);
  const subPurchase2 = r.data.purchaseId;
  r = await req('POST', `/admin/subscriptions/${subPurchase2}/confirm`, { admin: true });
  check('confirmation admin premium -> 200 confirmed', r.status === 200, r.data);

  r = await req('GET', '/subscriptions/me', { token: s1.token, device: s1.device });
  check('GET /subscriptions/me après passage Premium -> premium', r.status === 200 && r.data.plan === 'premium', r.data);

  // Un DEUXIÈME document payant, jamais acheté, jamais vu par ce compte -> accessible directement (Premium).
  const otherPaidDoc = docs.find((d) => !d.free && d.id !== paidDoc.id && !d.adUnlock) || docs.find((d) => !d.free && d.id !== paidDoc.id);
  if (otherPaidDoc) {
    r = await req('GET', `/documents/${otherPaidDoc.id}/view`, { token: s1.token, device: s1.device });
    check('accès direct (sans achat) à un document payant pour un abonné Premium -> 200', r.status === 200, r.status);
  } else {
    console.log('SKIP - pas de deuxième document payant disponible pour ce test');
  }

  // Un abonné Premium ne doit plus pouvoir "acheter" un document (bloqué explicitement).
  r = await req('POST', '/payments/initiate', { token: s1.token, device: s1.device, body: { documentId: paidDoc.id, method: 'bankily' } });
  check('POST /payments/initiate en étant Premium -> 409 ALREADY_PREMIUM', r.status === 409 && r.data.error === 'ALREADY_PREMIUM', r.data);

  // Un abonné Premium ne doit pas pouvoir "redescendre" en achetant Basic (régression sans intérêt).
  r = await req('POST', '/subscriptions/purchase', { token: s1.token, device: s1.device, body: { plan: 'basic', method: 'bankily' } });
  check('achat Basic en étant Premium -> 409 ALREADY_PREMIUM', r.status === 409 && r.data.error === 'ALREADY_PREMIUM', r.data);

  // --- Sécurité "money-safety" : un abonnement déjà confirmé ne peut pas être rejeté après coup ---
  r = await req('POST', `/admin/subscriptions/${subPurchase1}/reject`, { admin: true });
  check('reject un abonnement déjà confirmé -> 409', r.status === 409, r.data);

  // --- Suppression cascade : le compte a des lignes dans subscription_purchases,
  // ne doit PAS échouer (c'était exactement la classe de bug corrigée le 27/08
  // pour d'autres tables — voir lib/cascade.js). ---
  r = await req('DELETE', `/admin/users/${s1.userId}`, { admin: true });
  check('DELETE /admin/users/:id (compte avec abonnements) -> 200, pas de 500 FOREIGN KEY', r.status === 200, r.data);

  // --- Renouvellement additif : deux confirmations Basic successives pour le même
  // compte doivent ÉTENDRE l'expiration (durée cumulée), pas repartir de zéro. ---
  r = await req('POST', '/subscriptions/purchase', { token: s2.token, device: s2.device, body: { plan: 'basic', method: 'bankily' } });
  const sub2a = r.data.purchaseId;
  await req('POST', `/admin/subscriptions/${sub2a}/confirm`, { admin: true });
  r = await req('GET', '/subscriptions/me', { token: s2.token, device: s2.device });
  const firstExpiry = new Date(r.data.expiresAt);

  r = await req('POST', '/subscriptions/purchase', { token: s2.token, device: s2.device, body: { plan: 'basic', method: 'bankily' } });
  check('renouvellement Basic pendant qu\'il est déjà actif -> 201 (autorisé, additif)', r.status === 201, r.data);
  const sub2b = r.data.purchaseId;
  r = await req('POST', `/admin/subscriptions/${sub2b}/confirm`, { admin: true });
  check('confirmation admin du renouvellement -> 200', r.status === 200, r.data);

  r = await req('GET', '/subscriptions/me', { token: s2.token, device: s2.device });
  const secondExpiry = new Date(r.data.expiresAt);
  const daysExtended = Math.round((secondExpiry - firstExpiry) / (24 * 60 * 60 * 1000));
  check('renouvellement additif -> expiration prolongée d\'environ 30 jours de plus (pas repartie de zéro)', daysExtended >= 29 && daysExtended <= 31, { firstExpiry, secondExpiry, daysExtended });

  console.log('\n--- Résumé ---');
  if (failures === 0) console.log('Tous les tests sont passés.');
  else console.log(`${failures} test(s) en échec.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
