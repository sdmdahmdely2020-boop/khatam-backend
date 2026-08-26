// Panneau d'administration — réservé au propriétaire de la plateforme.
// Toutes les routes ici exigent l'en-tête X-Admin-Key (voir middleware/auth.js,
// requireAdminKey). Il n'y a volontairement pas de système de comptes
// multi-administrateurs pour l'instant : une seule clé secrète, définie dans
// la variable d'environnement ADMIN_KEY côté serveur.

const express = require('express');
const fs = require('fs');
const db = require('../lib/db');
const { newId } = require('../lib/id');
const { requireAdminKey } = require('../middleware/auth');
const { adminLimiter } = require('../middleware/rateLimit');
const { confirmPurchase, rejectPurchase, PROVIDERS } = require('../lib/payments');
const { getPaymentNumbers, setPaymentNumber } = require('../lib/settings');
const { adUpload } = require('../lib/adUpload');
const { deleteDocumentCascade, deleteUserCascade } = require('../lib/cascade');

const router = express.Router();
// adminLimiter avant requireAdminKey : on veut limiter le débit des essais de
// clé eux-mêmes (brute-force), pas seulement les requêtes déjà authentifiées.
router.use(adminLimiter);
router.use(requireAdminKey);

// GET /api/admin/settings — numéros Bankily/Masrivi/Sedad actuellement configurés.
router.get('/settings', (req, res) => {
  res.json({ paymentNumbers: getPaymentNumbers() });
});

// PATCH /api/admin/settings  { bankily?, masrivi?, sedad? }
router.patch('/settings', (req, res) => {
  const body = req.body || {};
  for (const method of PROVIDERS) {
    if (Object.prototype.hasOwnProperty.call(body, method)) {
      setPaymentNumber(method, body[method]);
    }
  }
  res.json({ paymentNumbers: getPaymentNumbers() });
});

// GET /api/admin/purchases/pending — achats en attente de vérification manuelle.
router.get('/purchases/pending', (req, res) => {
  const rows = db.prepare(`
    SELECT pu.id, pu.amount, pu.method, pu.studentRef, pu.providerRef, pu.createdAt,
           d.title AS documentTitle,
           s.fullName AS studentName, s.phone AS studentPhone,
           p.fullName AS professorName
    FROM purchases pu
    JOIN documents d ON d.id = pu.documentId
    JOIN users s ON s.id = pu.userId
    JOIN users p ON p.id = d.professorId
    WHERE pu.status = 'pending'
    ORDER BY pu.createdAt ASC
  `).all();
  res.json({ purchases: rows });
});

// POST /api/admin/purchases/:id/confirm — l'argent est bien arrivé, on débloque et on crédite le professeur.
router.post('/purchases/:id/confirm', (req, res) => {
  try {
    const purchase = confirmPurchase(req.params.id);
    res.json({ purchase });
  } catch (e) {
    res.status(e.status || 500).json({ error: 'ERROR', message: e.message });
  }
});

// POST /api/admin/purchases/:id/reject — aucun paiement reçu correspondant, on annule.
router.post('/purchases/:id/reject', (req, res) => {
  try {
    const purchase = rejectPurchase(req.params.id);
    res.json({ purchase });
  } catch (e) {
    res.status(e.status || 500).json({ error: 'ERROR', message: e.message });
  }
});

// --- Approbation des comptes professeurs ---
//
// Un professeur qui s'inscrit peut se connecter et préparer ses documents
// (voir routes/documents.js), mais rien n'est visible aux élèves tant que son
// compte n'a pas été examiné et approuvé ici — l'inscription seule ne suffit
// pas ("je veux inscrire juste de vraies personnes pas de personnes au
// hasard"). L'approbation ne publie PAS automatiquement les brouillons déjà
// créés : le professeur doit les publier lui-même ensuite (certains
// brouillons peuvent avoir été laissés ainsi volontairement).

// GET /api/admin/professors/pending — comptes professeurs en attente d'examen.
router.get('/professors/pending', (req, res) => {
  const rows = db.prepare(`
    SELECT id, fullName, phone, email, etablissement, matieres, experienceYears, createdAt,
           (SELECT COUNT(*) FROM documents d WHERE d.professorId = users.id) AS documentsCount
    FROM users
    WHERE role = 'PROFESSOR' AND professorStatus = 'pending'
    ORDER BY createdAt ASC
  `).all();
  res.json({ professors: rows });
});

// POST /api/admin/professors/:id/approve — le compte peut désormais publier.
router.post('/professors/:id/approve', (req, res) => {
  const user = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'PROFESSOR'`).get(req.params.id);
  if (!user) return res.status(404).json({ error: 'NOT_FOUND' });
  db.prepare(`UPDATE users SET professorStatus = 'approved' WHERE id = ?`).run(user.id);
  res.json({ professor: db.prepare('SELECT id, fullName, phone, professorStatus FROM users WHERE id = ?').get(user.id) });
});

// POST /api/admin/professors/:id/reject — le compte reste créé (l'élève/le
// professeur peut se reconnecter et voir pourquoi), mais ne pourra jamais
// publier tant qu'un administrateur ne l'approuve pas explicitement ensuite
// via la route ci-dessus.
router.post('/professors/:id/reject', (req, res) => {
  const user = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'PROFESSOR'`).get(req.params.id);
  if (!user) return res.status(404).json({ error: 'NOT_FOUND' });
  db.prepare(`UPDATE users SET professorStatus = 'rejected' WHERE id = ?`).run(user.id);
  res.json({ professor: db.prepare('SELECT id, fullName, phone, professorStatus FROM users WHERE id = ?').get(user.id) });
});

// GET /api/admin/withdrawals/pending — demandes de retrait des professeurs à traiter.
router.get('/withdrawals/pending', (req, res) => {
  const rows = db.prepare(`
    SELECT w.id, w.amount, w.method, w.accountRef, w.createdAt,
           p.fullName AS professorName, p.phone AS professorPhone
    FROM withdrawals w
    JOIN users p ON p.id = w.professorId
    WHERE w.status = 'pending'
    ORDER BY w.createdAt ASC
  `).all();
  res.json({ withdrawals: rows });
});

// POST /api/admin/withdrawals/:id/mark-paid — à utiliser une fois que TOI tu as
// réellement envoyé l'argent au professeur via Bankily/Masrivi/Sedad.
router.post('/withdrawals/:id/mark-paid', (req, res) => {
  const withdrawal = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(req.params.id);
  if (!withdrawal) return res.status(404).json({ error: 'NOT_FOUND' });
  db.prepare(`UPDATE withdrawals SET status = 'paid' WHERE id = ?`).run(withdrawal.id);
  res.json({ withdrawal: db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(withdrawal.id) });
});

// --- Annonces publicitaires (annonceurs locaux mauritaniens) ---

// GET /api/admin/ads — toutes les annonces avec leurs statistiques.
router.get('/ads', (req, res) => {
  const rows = db.prepare('SELECT * FROM ads ORDER BY createdAt DESC').all();
  res.json({ ads: rows });
});

// POST /api/admin/ads — multipart/form-data : advertiserName, targetUrl, placement,
// startDate?, endDate?, image (fichier).
router.post('/ads', adUpload.single('image'), (req, res) => {
  const { advertiserName, targetUrl, placement, startDate, endDate } = req.body || {};
  if (!advertiserName || !placement) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'advertiserName et placement sont requis.' });
  }
  if (!['banner', 'ad-gate'].includes(placement)) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'INVALID_PLACEMENT' });
  }
  const id = newId('ad');
  db.prepare(`
    INSERT INTO ads (id, advertiserName, imagePath, targetUrl, placement, startDate, endDate)
    VALUES (@id, @advertiserName, @imagePath, @targetUrl, @placement, @startDate, @endDate)
  `).run({
    id, advertiserName,
    imagePath: req.file ? req.file.filename : null,
    targetUrl: targetUrl || null,
    placement,
    startDate: startDate || null,
    endDate: endDate || null,
  });
  res.status(201).json({ ad: db.prepare('SELECT * FROM ads WHERE id = ?').get(id) });
});

// PATCH /api/admin/ads/:id — { active?, advertiserName?, targetUrl?, startDate?, endDate? }
router.patch('/ads/:id', (req, res) => {
  const ad = db.prepare('SELECT * FROM ads WHERE id = ?').get(req.params.id);
  if (!ad) return res.status(404).json({ error: 'NOT_FOUND' });

  // better-sqlite3 ne peut pas binder un booléen JS natif (TypeError au
  // .run()) — le client envoie `active: true/false` en JSON, il faut donc le
  // convertir en 0/1 avant toute écriture, comme partout ailleurs (voir
  // toBit() dans routes/documents.js).
  const fields = ['active', 'advertiserName', 'targetUrl', 'startDate', 'endDate'];
  const updates = {};
  for (const f of fields) if (req.body[f] !== undefined) updates[f] = req.body[f];
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'NO_FIELDS' });

  if (Object.prototype.hasOwnProperty.call(updates, 'active')) {
    updates.active = updates.active === true || updates.active === 1 || updates.active === '1' ? 1 : 0;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'advertiserName') && !String(updates.advertiserName).trim()) {
    return res.status(400).json({ error: 'INVALID_ADVERTISER_NAME', message: "advertiserName ne peut pas être vide." });
  }

  const setClause = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE ads SET ${setClause} WHERE id = @id`).run({ ...updates, id: ad.id });
  res.json({ ad: db.prepare('SELECT * FROM ads WHERE id = ?').get(ad.id) });
});

// DELETE /api/admin/ads/:id
router.delete('/ads/:id', (req, res) => {
  const ad = db.prepare('SELECT * FROM ads WHERE id = ?').get(req.params.id);
  if (!ad) return res.status(404).json({ error: 'NOT_FOUND' });
  db.prepare('DELETE FROM ads WHERE id = ?').run(ad.id);
  if (ad.imagePath) {
    const { AD_IMAGES_DIR } = require('../lib/adUpload');
    try { fs.unlinkSync(require('path').join(AD_IMAGES_DIR, ad.imagePath)); } catch (e) {}
  }
  res.json({ message: 'Annonce supprimée.' });
});

// --- Vue d'ensemble des données + suppression (comptes, documents) ---
//
// Numéros de téléphone des comptes de démonstration créés par scripts/seed.js
// (voir ce fichier) — utilisés uniquement par /reset-demo-data ci-dessous pour
// cibler précisément ces comptes sans jamais toucher à un vrai compte utilisateur.
const SEED_PHONES = ['22200000001', '22200000002', '22211111111', '22211111112'];

// GET /api/admin/overview — tous les comptes et documents actuellement en base,
// avec les compteurs globaux (achats, retraits, annonces, favoris, likes, IA).
router.get('/overview', (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.role, u.fullName, u.phone, u.email, u.emailVerified, u.professorStatus, u.createdAt, u.walletBalance,
           (SELECT COUNT(*) FROM documents d WHERE d.professorId = u.id) AS documentsCount
    FROM users u
    ORDER BY u.createdAt ASC
  `).all().map((u) => ({ ...u, isSeedAccount: SEED_PHONES.includes(u.phone) }));

  const documents = db.prepare(`
    SELECT doc.id, doc.title, doc.matiere, doc.annee, doc.type, doc.prix, doc.free, doc.createdAt,
           p.id AS professorId, p.fullName AS professorName
    FROM documents doc
    JOIN users p ON p.id = doc.professorId
    ORDER BY doc.createdAt ASC
  `).all();

  const counts = {
    purchases: db.prepare('SELECT COUNT(*) n FROM purchases').get().n,
    withdrawals: db.prepare('SELECT COUNT(*) n FROM withdrawals').get().n,
    ads: db.prepare('SELECT COUNT(*) n FROM ads').get().n,
    favorites: db.prepare('SELECT COUNT(*) n FROM favorites').get().n,
    likes: db.prepare('SELECT COUNT(*) n FROM likes').get().n,
    aiSubmissions: db.prepare('SELECT COUNT(*) n FROM ai_submissions').get().n,
  };

  res.json({ users, documents, counts });
});

// DELETE /api/admin/users/:id — supprime un compte (élève ou professeur) et tout
// ce qui en dépend : ses documents (s'il est professeur), achats, favoris, likes,
// retraits, corrections IA. Irréversible.
router.delete('/users/:id', (req, res) => {
  const user = deleteUserCascade(req.params.id);
  if (!user) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ message: 'Compte et toutes ses données associées supprimés.', deletedUser: { id: user.id, fullName: user.fullName } });
});

// DELETE /api/admin/documents/:id — supprime un document et tout ce qui en dépend
// (achats, favoris, corrections IA le concernant) ainsi que le fichier PDF. Irréversible.
router.delete('/documents/:id', (req, res) => {
  const doc = deleteDocumentCascade(req.params.id);
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ message: 'Document et toutes ses données associées supprimés.', deletedDocument: { id: doc.id, title: doc.title } });
});

// POST /api/admin/reset-demo-data — supprime uniquement les comptes de démonstration
// créés par scripts/seed.js (voir SEED_PHONES ci-dessus), et donc leurs documents/
// achats/etc. Ne touche à aucun vrai compte créé par un vrai utilisateur. Irréversible.
router.post('/reset-demo-data', (req, res) => {
  const deleted = [];
  for (const phone of SEED_PHONES) {
    const u = db.prepare('SELECT id, fullName FROM users WHERE phone = ?').get(phone);
    if (u) { deleteUserCascade(u.id); deleted.push(u.fullName); }
  }
  res.json({ message: `${deleted.length} compte(s) de démonstration supprimé(s), avec leurs documents et données associées.`, deleted });
});

module.exports = router;
