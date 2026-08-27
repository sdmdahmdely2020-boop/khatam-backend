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
const { getPaymentNumbers, setPaymentNumber, getSetting, setSetting } = require('../lib/settings');
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
           pu.receiptImagePath,
           d.title AS documentTitle,
           s.fullName AS studentName, s.phone AS studentPhone,
           p.fullName AS professorName
    FROM purchases pu
    JOIN documents d ON d.id = pu.documentId
    JOIN users s ON s.id = pu.userId
    JOIN users p ON p.id = d.professorId
    WHERE pu.status = 'pending'
    ORDER BY pu.createdAt ASC
  `).all().map((r) => ({ ...r, hasReceipt: !!r.receiptImagePath, receiptImagePath: undefined }));
  res.json({ purchases: rows });
});

// GET /api/admin/purchases/:id/receipt — sert l'image de la capture d'écran
// envoyée par l'élève (voir routes/payments.js, POST /:id/receipt), pour que
// l'admin puisse la regarder au moment de confirmer/rejeter. Ce n'est qu'un
// appui visuel, jamais une preuve automatique (une image peut être modifiée
// ou réutilisée) — la décision reste manuelle (confirm/reject ci-dessus).
router.get('/purchases/:id/receipt', (req, res) => {
  const purchase = db.prepare('SELECT receiptImagePath FROM purchases WHERE id = ?').get(req.params.id);
  if (!purchase || !purchase.receiptImagePath) return res.status(404).json({ error: 'NOT_FOUND' });
  if (!fs.existsSync(purchase.receiptImagePath)) return res.status(404).json({ error: 'NOT_FOUND' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(purchase.receiptImagePath);
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
// zone? (catalog|dashboard, uniquement pertinent pour placement="banner" — voir
// GET /api/ads/list, routes/ads.js), startDate?, endDate?, image (fichier).
router.post('/ads', adUpload.single('image'), (req, res) => {
  const { advertiserName, targetUrl, placement, zone, startDate, endDate } = req.body || {};
  if (!advertiserName || !placement) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'advertiserName et placement sont requis.' });
  }
  if (!['banner', 'ad-gate'].includes(placement)) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'INVALID_PLACEMENT' });
  }
  if (zone !== undefined && !['catalog', 'dashboard'].includes(zone)) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'INVALID_ZONE', message: "zone doit être 'catalog' ou 'dashboard'." });
  }
  const id = newId('ad');
  db.prepare(`
    INSERT INTO ads (id, advertiserName, imagePath, targetUrl, placement, zone, startDate, endDate)
    VALUES (@id, @advertiserName, @imagePath, @targetUrl, @placement, @zone, @startDate, @endDate)
  `).run({
    id, advertiserName,
    imagePath: req.file ? req.file.filename : null,
    targetUrl: targetUrl || null,
    placement,
    zone: zone || 'catalog',
    startDate: startDate || null,
    endDate: endDate || null,
  });
  res.status(201).json({ ad: db.prepare('SELECT * FROM ads WHERE id = ?').get(id) });
});

// PATCH /api/admin/ads/:id — { active?, advertiserName?, targetUrl?, zone?, startDate?, endDate? }
router.patch('/ads/:id', (req, res) => {
  const ad = db.prepare('SELECT * FROM ads WHERE id = ?').get(req.params.id);
  if (!ad) return res.status(404).json({ error: 'NOT_FOUND' });

  // better-sqlite3 ne peut pas binder un booléen JS natif (TypeError au
  // .run()) — le client envoie `active: true/false` en JSON, il faut donc le
  // convertir en 0/1 avant toute écriture, comme partout ailleurs (voir
  // toBit() dans routes/documents.js).
  const fields = ['active', 'advertiserName', 'targetUrl', 'zone', 'startDate', 'endDate'];
  const updates = {};
  for (const f of fields) if (req.body[f] !== undefined) updates[f] = req.body[f];
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'NO_FIELDS' });

  if (Object.prototype.hasOwnProperty.call(updates, 'active')) {
    updates.active = updates.active === true || updates.active === 1 || updates.active === '1' ? 1 : 0;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'advertiserName') && !String(updates.advertiserName).trim()) {
    return res.status(400).json({ error: 'INVALID_ADVERTISER_NAME', message: "advertiserName ne peut pas être vide." });
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'zone') && !['catalog', 'dashboard'].includes(updates.zone)) {
    return res.status(400).json({ error: 'INVALID_ZONE', message: "zone doit être 'catalog' ou 'dashboard'." });
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
  const failed = [];
  for (const phone of SEED_PHONES) {
    const u = db.prepare('SELECT id, fullName FROM users WHERE phone = ?').get(phone);
    if (!u) continue;
    // Un compte à la fois, chacun dans son propre try/catch : si l'un
    // échoue (ex. une table oubliée dans deleteUserCascade — bug vécu le
    // 27/08 avec feedback/app_ratings/admin_messages, désormais corrigé),
    // les autres comptes de la liste continuent d'être supprimés au lieu de
    // stopper toute la boucle sur une erreur 500 opaque.
    try { deleteUserCascade(u.id); deleted.push(u.fullName); }
    catch (e) { console.error('reset-demo-data — échec suppression', u.fullName, e && e.message); failed.push(u.fullName); }
  }
  res.json({
    message: `${deleted.length} compte(s) de démonstration supprimé(s), avec leurs documents et données associées.`
      + (failed.length ? ` ATTENTION : ${failed.length} compte(s) n'ont pas pu être supprimés (voir les logs serveur).` : ''),
    deleted, failed,
  });
});

// POST /api/admin/reset-all-users  { confirm: "SUPPRIMER TOUT" }
// Supprime absolument TOUS les comptes (élèves ET professeurs, démo ou réels)
// et toutes leurs données (documents, achats, favoris, likes, retraits,
// corrections IA, photos de profil) en une seule fois. Contrairement à
// /reset-demo-data (qui ne cible que les numéros de démo connus), celui-ci
// vide entièrement la table users, sans distinction. Pensé pour un lancement
// propre avant l'arrivée des premiers vrais utilisateurs (demande de sidi,
// 27/08) — n'importe qui pourra ensuite s'inscrire comme élève ou professeur
// sur une base vide. Irréversible : protégé par une phrase de confirmation
// explicite dans le corps de la requête, en plus de la clé ADMIN_KEY déjà
// exigée par toutes les routes de ce fichier — pour éviter qu'un simple clic
// accidentel ne déclenche une suppression catastrophique.
router.post('/reset-all-users', (req, res) => {
  const { confirm } = req.body || {};
  if (confirm !== 'SUPPRIMER TOUT') {
    return res.status(400).json({
      error: 'CONFIRMATION_REQUISE',
      message: 'Envoyez { "confirm": "SUPPRIMER TOUT" } dans le corps de la requête pour confirmer cette action irréversible.',
    });
  }
  const users = db.prepare('SELECT id, fullName, role FROM users').all();
  const deleted = [];
  const failed = [];
  // Même principe que reset-demo-data ci-dessus : un échec sur UN compte ne
  // doit plus jamais interrompre la suppression des autres (bug du 27/08).
  for (const u of users) {
    try { deleteUserCascade(u.id); deleted.push(u.fullName); }
    catch (e) { console.error('reset-all-users — échec suppression', u.fullName, e && e.message); failed.push(u.fullName); }
  }
  res.json({
    message: `${deleted.length} compte(s) supprimé(s) définitivement, avec toutes leurs données.`
      + (failed.length ? ` ATTENTION : ${failed.length} compte(s) n'ont pas pu être supprimés (voir les logs serveur).` : ''),
    count: deleted.length, failed,
  });
});

// --- Retours des utilisateurs ("feedback") ---
//
// Formulaire public, voir routes/feedback.js. Enregistré ici quel que soit le
// succès de la notification WhatsApp (voir lib/whatsapp.js) — whatsappSent
// indique juste si l'alerte est aussi partie sur WhatsApp, ce panneau reste
// la source de vérité en cas d'échec/absence de configuration WhatsApp.

// GET /api/admin/feedback — les 200 derniers retours, les plus récents en premier.
router.get('/feedback', (req, res) => {
  const rows = db.prepare(`
    SELECT f.id, f.name, f.contact, f.message, f.whatsappSent, f.createdAt,
           u.fullName AS userFullName, u.role AS userRole
    FROM feedback f
    LEFT JOIN users u ON u.id = f.userId
    ORDER BY f.createdAt DESC
    LIMIT 200
  `).all();
  res.json({ feedback: rows });
});

// --- Note de l'application (étoiles) ---
//
// Un avis par utilisateur (voir routes/ratings.js) — visible uniquement ici,
// jamais publiquement sur le site.

// GET /api/admin/ratings — tous les avis + la moyenne.
router.get('/ratings', (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.stars, r.comment, r.role, r.createdAt, u.fullName AS userFullName
    FROM app_ratings r
    JOIN users u ON u.id = r.userId
    ORDER BY r.createdAt DESC
  `).all();
  const avgRow = db.prepare('SELECT AVG(stars) AS avg, COUNT(*) AS count FROM app_ratings').get();
  res.json({ ratings: rows, average: avgRow.avg, count: avgRow.count });
});

// --- Messagerie admin ↔ professeur ---
//
// Un seul fil par professeur (voir lib/db.js, table admin_messages). Envoyer
// un message ici le marque automatiquement "lu côté admin" (on vient de
// l'écrire) et "non lu côté professeur" — l'inverse de GET, qui marque les
// messages du professeur comme lus par l'admin au moment de la consultation.

// GET /api/admin/professors/:id/messages — tout le fil pour ce professeur ;
// marque les messages envoyés PAR le professeur comme lus par l'admin.
router.get('/professors/:id/messages', (req, res) => {
  const prof = db.prepare(`SELECT id FROM users WHERE id = ? AND role = 'PROFESSOR'`).get(req.params.id);
  if (!prof) return res.status(404).json({ error: 'NOT_FOUND' });
  const rows = db.prepare(`SELECT * FROM admin_messages WHERE professorId = ? ORDER BY createdAt ASC`).all(prof.id);
  db.prepare(`UPDATE admin_messages SET readByAdmin = 1 WHERE professorId = ? AND sender = 'professor'`).run(prof.id);
  res.json({ messages: rows });
});

// POST /api/admin/professors/:id/messages  { body }
router.post('/professors/:id/messages', (req, res) => {
  const prof = db.prepare(`SELECT id FROM users WHERE id = ? AND role = 'PROFESSOR'`).get(req.params.id);
  if (!prof) return res.status(404).json({ error: 'NOT_FOUND' });
  const { body } = req.body || {};
  if (!body || !String(body).trim()) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Message requis.' });
  }
  const id = newId('msg');
  db.prepare(`
    INSERT INTO admin_messages (id, professorId, sender, body, readByAdmin, readByProfessor)
    VALUES (?, ?, 'admin', ?, 1, 0)
  `).run(id, prof.id, String(body).trim().slice(0, 2000));
  res.status(201).json({ message: db.prepare('SELECT * FROM admin_messages WHERE id = ?').get(id) });
});

// GET /api/admin/professors/unread-messages-count — nombre de professeurs
// ayant au moins un message non lu par l'admin, pour un badge dans admin.html.
router.get('/professors/unread-messages-count', (req, res) => {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT professorId) AS n FROM admin_messages WHERE sender = 'professor' AND readByAdmin = 0
  `).get();
  res.json({ count: row.n });
});

// --- Contenu FAQ / À propos (éditable sans redéploiement) ---
//
// Réutilise platform_settings (déjà utilisée pour les numéros Bankily/
// Masrivi/Sedad, voir lib/settings.js) — FAQ stockée en JSON (tableau de
// {question, reponse}), À propos en texte simple.

// GET /api/admin/content — contenu FAQ + À propos actuellement configurés.
router.get('/content', (req, res) => {
  const faqRaw = getSetting('faq_json');
  let faq = [];
  try { faq = faqRaw ? JSON.parse(faqRaw) : []; } catch (e) { faq = []; }
  res.json({ faq, about: getSetting('about_text') || '' });
});

// PATCH /api/admin/content  { faq?: [{question, reponse}], about?: string }
router.patch('/content', (req, res) => {
  const { faq, about } = req.body || {};
  if (faq !== undefined) {
    if (!Array.isArray(faq) || !faq.every((f) => f && typeof f.question === 'string' && typeof f.reponse === 'string')) {
      return res.status(400).json({ error: 'INVALID_FAQ', message: 'faq doit être un tableau de { question, reponse }.' });
    }
    setSetting('faq_json', JSON.stringify(faq));
  }
  if (about !== undefined) {
    setSetting('about_text', String(about));
  }
  const faqRaw = getSetting('faq_json');
  let savedFaq = [];
  try { savedFaq = faqRaw ? JSON.parse(faqRaw) : []; } catch (e) { savedFaq = []; }
  res.json({ faq: savedFaq, about: getSetting('about_text') || '' });
});

// --- Bot WhatsApp automatique — conversations et escalades ---
//
// Le bot lui-même (réception + réponse auto) vit dans routes/whatsapp.js ;
// ici, sidi consulte depuis admin.html ce que le bot a échangé, et voit
// clairement les conversations "escaladées" (sujet délicat détecté ou bot
// non configuré) auxquelles il doit répondre lui-même, en direct sur son
// téléphone — répondre depuis WhatsApp marque naturellement la conversation
// comme prise en charge une fois qu'il clique "Marquer comme traité" ici.

// GET /api/admin/whatsapp/conversations — une ligne par numéro, dernier
// message + nombre de messages escaladés en attente, les plus récentes en premier.
router.get('/whatsapp/conversations', (req, res) => {
  const rows = db.prepare(`
    SELECT
      fromNumber,
      MAX(createdAt) AS lastAt,
      COUNT(*) AS total,
      SUM(CASE WHEN escalated = 1 THEN 1 ELSE 0 END) AS escalatedCount,
      (SELECT body FROM whatsapp_messages w2 WHERE w2.fromNumber = w1.fromNumber ORDER BY w2.createdAt DESC LIMIT 1) AS lastBody
    FROM whatsapp_messages w1
    GROUP BY fromNumber
    ORDER BY lastAt DESC
  `).all();
  res.json({ conversations: rows });
});

// GET /api/admin/whatsapp/conversations/:number/messages — fil complet pour un numéro.
router.get('/whatsapp/conversations/:number/messages', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM whatsapp_messages WHERE fromNumber = ? ORDER BY createdAt ASC
  `).all(req.params.number);
  res.json({ messages: rows });
});

// POST /api/admin/whatsapp/conversations/:number/resolve — sidi a répondu
// lui-même depuis son téléphone : on lève les escalades en attente pour ce
// numéro (n'efface aucun message, juste le statut "en attente").
router.post('/whatsapp/conversations/:number/resolve', (req, res) => {
  db.prepare(`UPDATE whatsapp_messages SET escalated = 0 WHERE fromNumber = ? AND escalated = 1`).run(req.params.number);
  res.json({ ok: true });
});

// GET /api/admin/whatsapp/unread-count — nombre de numéros ayant au moins
// une escalade en attente, pour un badge dans admin.html.
router.get('/whatsapp/unread-count', (req, res) => {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT fromNumber) AS n FROM whatsapp_messages WHERE escalated = 1
  `).get();
  res.json({ count: row.n });
});

module.exports = router;
