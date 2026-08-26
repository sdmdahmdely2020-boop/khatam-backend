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
  // Number.isFinite() rejette explicitement les valeurs non numériques (ex.
  // amount="abc") : sans ça, "abc" <= 0 et "abc" > walletBalance valent tous
  // les deux false (comparaison avec NaN), donc la validation suivante
  // passait à tort — un montant absurde pouvait être enregistré alors qu'il
  // s'agit d'une vraie demande de virement Bankily/Masrivi/Sedad.
  const amountNum = Number(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0 || amountNum > req.user.walletBalance) {
    return res.status(400).json({ error: 'INVALID_AMOUNT', message: 'Montant invalide ou supérieur au solde disponible.' });
  }

  // Transaction : la ligne de retrait et le débit du solde doivent changer
  // ensemble (même raisonnement que confirmPurchase/rejectPurchase).
  const id = newId('wd');
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO withdrawals (id, professorId, amount, method, accountRef) VALUES (?, ?, ?, ?, ?)`)
      .run(id, req.user.id, amountNum, method, accountRef);
    db.prepare(`UPDATE users SET walletBalance = walletBalance - ?, walletWithdrawn = walletWithdrawn + ? WHERE id = ?`)
      .run(amountNum, amountNum, req.user.id);
  });
  tx();

  res.status(201).json({ withdrawal: { id, amount: amountNum, method, accountRef, status: 'pending' } });
});

module.exports = router;
