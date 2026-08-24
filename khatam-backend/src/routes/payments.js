const express = require('express');
const db = require('../lib/db');
const { newId } = require('../lib/id');
const { requireAuth } = require('../middleware/auth');
const { initiatePayment, verifyWebhookSignature, PROVIDERS } = require('../lib/payments');

const router = express.Router();

// POST /api/payments/initiate  { documentId, method }
// Crée un achat "pending" et démarre le paiement côté passerelle (push sur le
// téléphone de l'élève). Le déblocage réel n'arrive qu'après confirmation
// via /api/payments/webhook/:provider (voir plus bas) — jamais côté client.
router.post('/initiate', requireAuth({ roles: ['STUDENT'] }), async (req, res) => {
  const { documentId, method } = req.body || {};
  if (!documentId || !method) return res.status(400).json({ error: 'MISSING_FIELDS' });
  if (!PROVIDERS.includes(method)) return res.status(400).json({ error: 'INVALID_METHOD' });

  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND', message: 'Document introuvable.' });
  if (doc.free) return res.status(400).json({ error: 'ALREADY_FREE', message: 'Ce document est déjà gratuit.' });

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

  res.status(201).json({ purchaseId: id, status: 'pending', providerRef: result.providerRef, instructions: result.instructions });
});

// GET /api/payments/:id/status — le frontend sonde cette route en attendant le webhook.
router.get('/:id/status', requireAuth({ roles: ['STUDENT'] }), (req, res) => {
  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ? AND userId = ?').get(req.params.id, req.user.id);
  if (!purchase) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ purchase });
});

// POST /api/payments/webhook/:provider
// C'est l'URL que Bankily/Masrivi/Sedad appellerait en production pour
// notifier la confirmation (ou l'échec) d'un paiement. Body attendu :
// { providerRef, status: 'confirmed'|'failed' }
// En mock, on peut aussi appeler cette route nous-mêmes (voir scripts/test-api.js)
// pour simuler la confirmation reçue du téléphone de l'élève.
router.post('/webhook/:provider', (req, res) => {
  const { provider } = req.params;
  const { providerRef, status } = req.body || {};
  if (!PROVIDERS.includes(provider)) return res.status(400).json({ error: 'INVALID_PROVIDER' });
  verifyWebhookSignature(provider, req);

  const purchase = db.prepare('SELECT * FROM purchases WHERE providerRef = ?').get(providerRef);
  if (!purchase) return res.status(404).json({ error: 'PURCHASE_NOT_FOUND' });

  if (status === 'confirmed') {
    db.prepare(`UPDATE purchases SET status = 'confirmed', confirmedAt = datetime('now') WHERE id = ?`).run(purchase.id);
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(purchase.documentId);
    // Crédite le portefeuille du professeur (commission plateforme simplifiée à 0% ici,
    // à ajuster : ex. db.prepare('UPDATE users SET walletBalance = walletBalance + ? WHERE id = ?').run(Math.round(purchase.amount*0.85), doc.professorId))
    db.prepare('UPDATE users SET walletBalance = walletBalance + ? WHERE id = ?').run(purchase.amount, doc.professorId);
  } else if (status === 'failed') {
    db.prepare(`UPDATE purchases SET status = 'failed' WHERE id = ?`).run(purchase.id);
  } else {
    return res.status(400).json({ error: 'INVALID_STATUS' });
  }

  res.json({ received: true });
});

module.exports = router;
