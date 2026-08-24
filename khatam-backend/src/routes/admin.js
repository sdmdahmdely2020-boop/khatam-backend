// Panneau d'administration — réservé au propriétaire de la plateforme.
// Toutes les routes ici exigent l'en-tête X-Admin-Key (voir middleware/auth.js,
// requireAdminKey). Il n'y a volontairement pas de système de comptes
// multi-administrateurs pour l'instant : une seule clé secrète, définie dans
// la variable d'environnement ADMIN_KEY côté serveur.

const express = require('express');
const db = require('../lib/db');
const { requireAdminKey } = require('../middleware/auth');
const { confirmPurchase, rejectPurchase, PROVIDERS } = require('../lib/payments');
const { getPaymentNumbers, setPaymentNumber } = require('../lib/settings');

const router = express.Router();
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

module.exports = router;
