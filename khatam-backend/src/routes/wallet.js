const express = require('express');
const db = require('../lib/db');
const { newId } = require('../lib/id');
const { requireAuth } = require('../middleware/auth');
const { PROVIDERS } = require('../lib/payments');

const router = express.Router();

// GET /api/wallet — solde + historique des ventes et retraits du professeur connecté
router.get('/', requireAuth({ roles: ['PROFESSOR'] }), (req, res) => {
  const sales = db.prepare(`
    SELECT pu.id, pu.amount, pu.method, pu.confirmedAt, d.title
    FROM purchases pu JOIN documents d ON d.id = pu.documentId
    WHERE d.professorId = ? AND pu.status = 'confirmed'
    ORDER BY pu.confirmedAt DESC
  `).all(req.user.id);

  const withdrawals = db.prepare(`
    SELECT * FROM withdrawals WHERE professorId = ? ORDER BY createdAt DESC
  `).all(req.user.id);

  res.json({
    balance: req.user.walletBalance,
    withdrawn: req.user.walletWithdrawn,
    sales,
    withdrawals,
  });
});

// POST /api/wallet/withdraw  { amount, method, accountRef }
// Demande de retrait vers Bankily/Masrivi/Sedad. En production, ceci
// déclencherait un virement réel via l'API du fournisseur (ou un traitement
// manuel mensuel par l'équipe) ; ici la demande passe en status "pending"
// et un administrateur (ou un script) la marque "paid" une fois le virement
// effectué (voir scripts/test-api.js pour un exemple).
router.post('/withdraw', requireAuth({ roles: ['PROFESSOR'] }), (req, res) => {
  const { amount, method, accountRef } = req.body || {};
  if (!amount || !method || !accountRef) return res.status(400).json({ error: 'MISSING_FIELDS' });
  if (!PROVIDERS.includes(method)) return res.status(400).json({ error: 'INVALID_METHOD' });
  if (amount <= 0 || amount > req.user.walletBalance) {
    return res.status(400).json({ error: 'INVALID_AMOUNT', message: 'Montant invalide ou supérieur au solde disponible.' });
  }

  const id = newId('wd');
  db.prepare(`INSERT INTO withdrawals (id, professorId, amount, method, accountRef) VALUES (?, ?, ?, ?, ?)`)
    .run(id, req.user.id, amount, method, accountRef);
  db.prepare(`UPDATE users SET walletBalance = walletBalance - ?, walletWithdrawn = walletWithdrawn + ? WHERE id = ?`)
    .run(amount, amount, req.user.id);

  res.status(201).json({ withdrawal: { id, amount, method, accountRef, status: 'pending' } });
});

module.exports = router;
