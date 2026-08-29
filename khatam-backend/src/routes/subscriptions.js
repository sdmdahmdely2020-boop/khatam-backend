// Abonnements Basic / Premium — modèle HYBRIDE (29/08), voir lib/subscriptions.js
// pour le détail de la logique. S'ajoute à routes/payments.js (achat de
// document à l'unité), ne le remplace pas : les deux circuits coexistent.

const express = require('express');
const db = require('../lib/db');
const { requireAuth } = require('../middleware/auth');
const { getPaymentNumbers } = require('../lib/settings');
const { PROVIDERS } = require('../lib/payments');
const {
  getSubscriptionSettings,
  effectivePlan,
  purchaseSubscription,
} = require('../lib/subscriptions');

const router = express.Router();

// GET /api/subscriptions/plans — public (affiché avant connexion aussi,
// écran d'upsell). Prix/durée/réduction configurables par l'administrateur
// (voir routes/admin.js), jamais codés en dur côté app.
router.get('/plans', (req, res) => {
  const settings = getSubscriptionSettings();
  res.json({
    plans: {
      basic: { price: settings.basicPrice, durationDays: settings.durationDays, discountPercent: settings.basicDiscountPercent },
      premium: { price: settings.premiumPrice, durationDays: settings.durationDays },
    },
  });
});

// GET /api/subscriptions/me — abonnement actuel de l'élève connecté.
router.get('/me', requireAuth({ roles: ['STUDENT'] }), (req, res) => {
  const current = effectivePlan(req.user);
  res.json({
    plan: current.plan,
    expiresAt: current.expiresAt,
  });
});

// POST /api/subscriptions/purchase  { plan: 'basic'|'premium', method }
// Même circuit que POST /api/payments/initiate : crée une ligne "pending",
// renvoie le numéro Bankily/Masrivi/Sedad réel. Confirmation TOUJOURS
// manuelle par l'administrateur (jamais automatique) — voir routes/admin.js.
//
// Racheter le MÊME plan pendant qu'il est déjà actif est volontairement
// autorisé : c'est un renouvellement (voir confirmSubscription() dans
// lib/subscriptions.js, qui prolonge l'expiration existante au lieu de
// repartir de zéro). Seul cas bloqué : un abonné Premium qui tenterait
// d'acheter Basic (régression sans intérêt, Premium inclut déjà tout Basic).
router.post('/purchase', requireAuth({ roles: ['STUDENT'] }), async (req, res) => {
  const { plan, method } = req.body || {};
  if (!plan || !method) return res.status(400).json({ error: 'MISSING_FIELDS' });
  if (!['basic', 'premium'].includes(plan)) return res.status(400).json({ error: 'INVALID_PLAN' });
  if (!PROVIDERS.includes(method)) return res.status(400).json({ error: 'INVALID_METHOD' });

  const current = effectivePlan(req.user);
  if (plan === 'basic' && current.plan === 'premium') {
    return res.status(409).json({ error: 'ALREADY_PREMIUM', message: 'Vous avez déjà un abonnement Premium actif, qui inclut tout ce que propose Basic.' });
  }

  const payTo = getPaymentNumbers()[method];
  if (!payTo) {
    return res.status(400).json({
      error: 'PAYMENT_METHOD_NOT_CONFIGURED',
      message: `Le paiement par ${method} n'est pas encore configuré. Essayez un autre moyen de paiement.`,
    });
  }

  try {
    const result = await purchaseSubscription({ userId: req.user.id, plan, method, phone: req.user.phone });
    res.status(201).json({
      purchaseId: result.id,
      status: 'pending',
      providerRef: result.providerRef,
      amount: result.amount,
      durationDays: result.durationDays,
      payTo,
      instructions: `Envoyez ${result.amount} MRU au numéro ${payTo} via ${method}, puis entrez ici le numéro de reçu que votre application vous donne.`,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: 'ERROR', message: e.message });
  }
});

// POST /api/subscriptions/:id/submit-reference  { reference }
router.post('/:id/submit-reference', requireAuth({ roles: ['STUDENT'] }), (req, res) => {
  const { reference } = req.body || {};
  if (!reference || !reference.trim()) return res.status(400).json({ error: 'MISSING_REFERENCE', message: 'Numéro de reçu requis.' });

  const purchase = db.prepare('SELECT * FROM subscription_purchases WHERE id = ? AND userId = ?').get(req.params.id, req.user.id);
  if (!purchase) return res.status(404).json({ error: 'NOT_FOUND' });
  if (purchase.status !== 'pending') return res.status(400).json({ error: 'NOT_PENDING', message: 'Cet abonnement a déjà été traité.' });

  db.prepare('UPDATE subscription_purchases SET studentRef = ? WHERE id = ?').run(reference.trim(), purchase.id);
  res.json({ purchase: db.prepare('SELECT * FROM subscription_purchases WHERE id = ?').get(purchase.id) });
});

// GET /api/subscriptions/:id/status — le frontend/app sonde cette route en attendant la confirmation admin.
router.get('/:id/status', requireAuth({ roles: ['STUDENT'] }), (req, res) => {
  const purchase = db.prepare('SELECT * FROM subscription_purchases WHERE id = ? AND userId = ?').get(req.params.id, req.user.id);
  if (!purchase) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ purchase });
});

module.exports = router;
