const express = require('express');
const fs = require('fs');
const db = require('../lib/db');
const { newId } = require('../lib/id');
const { requireAuth, requireWebhookKey } = require('../middleware/auth');
const { initiatePayment, verifyWebhookSignature, confirmPurchase, rejectPurchase, PROVIDERS } = require('../lib/payments');
const { getPaymentNumbers } = require('../lib/settings');
const { receiptUpload } = require('../lib/receiptUpload');

const router = express.Router();

// POST /api/payments/initiate  { documentId, method }
// Crée un achat "pending" et renvoie le numéro Bankily/Masrivi/Sedad réel sur
// lequel l'élève doit envoyer l'argent (configuré par l'administrateur, voir
// /api/admin/settings). Le déblocage n'arrive qu'après confirmation manuelle
// par l'administrateur (POST /api/admin/purchases/:id/confirm) une fois le
// paiement vérifié — jamais automatiquement côté client.
router.post('/initiate', requireAuth({ roles: ['STUDENT'] }), async (req, res) => {
  const { documentId, method } = req.body || {};
  if (!documentId || !method) return res.status(400).json({ error: 'MISSING_FIELDS' });
  if (!PROVIDERS.includes(method)) return res.status(400).json({ error: 'INVALID_METHOD' });

  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND', message: 'Document introuvable.' });
  if (doc.free) return res.status(400).json({ error: 'ALREADY_FREE', message: 'Ce document est déjà gratuit.' });

  const payTo = getPaymentNumbers()[method];
  if (!payTo) {
    return res.status(400).json({
      error: 'PAYMENT_METHOD_NOT_CONFIGURED',
      message: `Le paiement par ${method} n'est pas encore configuré. Essayez un autre moyen de paiement.`,
    });
  }

  const already = db.prepare(
    `SELECT id FROM purchases WHERE userId = ? AND documentId = ? AND status = 'confirmed'`
  ).get(req.user.id, documentId);
  if (already) return res.status(409).json({ error: 'ALREADY_UNLOCKED', message: 'Déjà débloqué.' });

  const id = newId('pur');
  const result = await initiatePayment({ method, phone: req.user.phone, amount: doc.prix, reference: id });

  db.prepare(`
    INSERT INTO purchases (id, userId, documentId, amount, method, status, providerRef)
    VALUES (@id, @userId, @documentId, @amount, @method, 'pending', @providerRef)
  `).run({ id, userId: req.user.id, documentId, amount: doc.prix, method, providerRef: result.providerRef });

  res.status(201).json({
    purchaseId: id,
    status: 'pending',
    providerRef: result.providerRef,
    amount: doc.prix,
    payTo,
    instructions: `Envoyez ${doc.prix} MRU au numéro ${payTo} via ${method}, puis entrez ici le numéro de reçu que votre application vous donne.`,
  });
});

// POST /api/payments/:id/submit-reference  { reference }
// L'élève a payé sur son téléphone (en dehors du site) et colle ici le numéro
// de reçu/référence donné par son app Bankily/Masrivi/Sedad. L'achat reste
// "pending" — c'est l'administrateur qui vérifie et confirme (voir routes/admin.js).
router.post('/:id/submit-reference', requireAuth({ roles: ['STUDENT'] }), (req, res) => {
  const { reference } = req.body || {};
  if (!reference || !reference.trim()) return res.status(400).json({ error: 'MISSING_REFERENCE', message: 'Numéro de reçu requis.' });

  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ? AND userId = ?').get(req.params.id, req.user.id);
  if (!purchase) return res.status(404).json({ error: 'NOT_FOUND' });
  if (purchase.status !== 'pending') return res.status(400).json({ error: 'NOT_PENDING', message: 'Cet achat a déjà été traité.' });

  db.prepare('UPDATE purchases SET studentRef = ? WHERE id = ?').run(reference.trim(), purchase.id);
  res.json({ purchase: db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchase.id) });
});

// POST /api/payments/:id/receipt  (multipart, champ "receipt")
// Envoi FACULTATIF d'une capture d'écran du reçu de paiement, en complément
// du numéro de reçu (voir /submit-reference ci-dessus) — demandé par sidi
// (27/08) comme appui visuel pour l'admin. Ce n'est PAS une vérification
// automatique du paiement : une image peut être modifiée ou réutilisée, elle
// aide simplement l'administrateur à confirmer visuellement en plus du
// numéro de reçu (voir POST /api/admin/purchases/:id/confirm, toujours une
// action manuelle). Remplace l'image précédente si l'élève réessaie.
router.post('/:id/receipt', requireAuth({ roles: ['STUDENT'] }), receiptUpload.single('receipt'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'MISSING_FILE', message: 'Image de reçu requise (champ "receipt").' });

  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ? AND userId = ?').get(req.params.id, req.user.id);
  if (!purchase) return res.status(404).json({ error: 'NOT_FOUND' });
  if (purchase.status !== 'pending') return res.status(400).json({ error: 'NOT_PENDING', message: 'Cet achat a déjà été traité.' });

  if (purchase.receiptImagePath) {
    try { fs.unlinkSync(purchase.receiptImagePath); } catch (e) {}
  }
  db.prepare('UPDATE purchases SET receiptImagePath = ? WHERE id = ?').run(req.file.path, purchase.id);
  res.json({ purchase: db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchase.id) });
});

// GET /api/payments/:id/status — le frontend sonde cette route en attendant la confirmation admin.
router.get('/:id/status', requireAuth({ roles: ['STUDENT'] }), (req, res) => {
  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ? AND userId = ?').get(req.params.id, req.user.id);
  if (!purchase) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ purchase });
});

// POST /api/payments/webhook/:provider
// C'est l'URL qu'un vrai opérateur (Bankily/Masrivi/Sedad) appellerait en
// production, une fois un contrat marchand signé, pour notifier automatiquement
// la confirmation d'un paiement. Body attendu : { providerRef, status }.
// Tant qu'aucun contrat n'existe, cette route est protégée par une clé dédiée
// (X-Webhook-Key, voir PAYMENTS_WEBHOOK_KEY) distincte de la clé complète du
// panneau d'administration, pour limiter les dégâts si elle fuite un jour
// vers un opérateur externe.
router.post('/webhook/:provider', requireWebhookKey, (req, res) => {
  const { provider } = req.params;
  const { providerRef, status } = req.body || {};
  if (!PROVIDERS.includes(provider)) return res.status(400).json({ error: 'INVALID_PROVIDER' });
  if (!verifyWebhookSignature(provider, req)) {
    return res.status(401).json({ error: 'INVALID_SIGNATURE', message: 'Signature de webhook invalide.' });
  }

  const purchase = db.prepare('SELECT * FROM purchases WHERE providerRef = ?').get(providerRef);
  if (!purchase) return res.status(404).json({ error: 'PURCHASE_NOT_FOUND' });

  if (status === 'confirmed') confirmPurchase(purchase.id);
  else if (status === 'failed') rejectPurchase(purchase.id);
  else return res.status(400).json({ error: 'INVALID_STATUS' });

  res.json({ received: true });
});

module.exports = router;
