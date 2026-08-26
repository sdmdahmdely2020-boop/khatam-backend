// Module de paiement — interface commune pour Bankily, Masrivi et Sedad.
//
// IMPORTANT (à lire avant mise en production) : Bankily, Masrivi et Sedad ne
// publient pas d'API publique en libre-service. Pour accepter de vrais
// paiements, il faut signer un contrat marchand avec chaque opérateur
// (Attijariwafa Bank / BCM / etc.), qui fournit alors : des identifiants
// d'API, la documentation technique exacte de leur passerelle "push USSD"
// (paiement confirmé par le client sur son téléphone), et une URL de webhook
// à laquelle ils notifient la confirmation. Ce fichier définit la forme que
// doit avoir cette intégration, avec une implémentation "mock" qui simule le
// comportement réel (délai + confirmation par webhook) pour que tout le
// reste du backend (déblocage de document, crédit du portefeuille
// professeur) fonctionne dès aujourd'hui sans ces contrats.
//
// Pour brancher un vrai fournisseur : implémenter initiatePayment() pour
// qu'elle appelle son API (numéro de téléphone -> push de paiement), puis
// exposer la route de webhook correspondante (déjà prête dans
// src/routes/payments.js) à l'opérateur.

const PROVIDERS = ['bankily', 'masrivi', 'sedad'];

function assertProvider(method) {
  if (!PROVIDERS.includes(method)) {
    const err = new Error(`Méthode de paiement inconnue: ${method}`);
    err.status = 400;
    throw err;
  }
}

/**
 * Démarre un paiement. En production, ceci appellerait l'API du fournisseur
 * avec le numéro de téléphone du payeur et déclencherait la notification
 * push sur son téléphone. Ici, on simule un identifiant de transaction et on
 * indique au frontend que la confirmation arrivera via webhook (comme dans
 * la vraie intégration).
 */
async function initiatePayment({ method, phone, amount, reference }) {
  assertProvider(method);
  // Simule la référence que renverrait la passerelle réelle.
  const providerRef = `${method.toUpperCase()}-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`;
  return {
    providerRef,
    status: 'pending',
    // Le frontend affiche ce message pendant qu'il attend le webhook de confirmation.
    instructions: `Confirmez le paiement de ${amount} MRU sur votre téléphone ${phone} via ${method}.`,
  };
}

/**
 * Vérifie la signature/authenticité d'un appel de webhook. En mock, on
 * accepte tout appel local. En production, chaque opérateur fournit un
 * mécanisme de signature (HMAC avec une clé secrète partagée, ou IP allowlist)
 * à vérifier ici avant de faire confiance à la notification.
 */
function verifyWebhookSignature(method, req) {
  assertProvider(method);
  if (process.env.NODE_ENV === 'production') {
    // TODO production : vérifier req.headers['x-signature'] avec la clé
    // secrète du fournisseur avant de continuer.
  }
  return true;
}

const db = require('./db');

/**
 * Confirme un achat en attente : marque la ligne "confirmed" et crédite le
 * portefeuille du professeur concerné. Appelée soit par le webhook (futur
 * vrai opérateur), soit par le panneau d'administration (confirmation
 * manuelle après vérification du numéro de reçu — voir routes/admin.js).
 * Pas de commission appliquée pour l'instant (le professeur reçoit 100% du
 * prix) — à ajuster ici le jour où un taux de commission est décidé.
 */
function confirmPurchase(purchaseId) {
  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchaseId);
  if (!purchase) {
    const err = new Error('Achat introuvable.'); err.status = 404; throw err;
  }
  if (purchase.status === 'confirmed') return purchase;
  // Un achat déjà rejeté ne doit pas pouvoir être confirmé après coup sans
  // repasser par une nouvelle tentative de paiement explicite.
  if (purchase.status === 'failed') {
    const err = new Error('Cet achat a déjà été refusé.'); err.status = 409; throw err;
  }

  // Transaction : le statut de l'achat et le crédit du portefeuille du
  // professeur doivent changer ensemble, jamais l'un sans l'autre (sinon un
  // crash entre les deux UPDATE laisserait un état incohérent avec de
  // l'argent réel en jeu).
  const tx = db.transaction(() => {
    db.prepare(`UPDATE purchases SET status = 'confirmed', confirmedAt = datetime('now') WHERE id = ?`).run(purchase.id);
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(purchase.documentId);
    db.prepare('UPDATE users SET walletBalance = walletBalance + ? WHERE id = ?').run(purchase.amount, doc.professorId);
  });
  tx();
  return db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchase.id);
}

function rejectPurchase(purchaseId) {
  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchaseId);
  if (!purchase) {
    const err = new Error('Achat introuvable.'); err.status = 404; throw err;
  }
  // Garde essentielle : un achat déjà confirmé (portefeuille du professeur
  // déjà crédité) ne doit jamais pouvoir être rebasculé à "failed" — sinon
  // l'élève perd son accès alors que le professeur a déjà été payé, sans que
  // personne ne s'en aperçoive. Voir confirmPurchase() pour le garde symétrique.
  if (purchase.status === 'confirmed') {
    const err = new Error('Cet achat est déjà confirmé et ne peut plus être refusé.'); err.status = 409; throw err;
  }
  db.prepare(`UPDATE purchases SET status = 'failed' WHERE id = ?`).run(purchase.id);
  return db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchase.id);
}

module.exports = { PROVIDERS, initiatePayment, verifyWebhookSignature, confirmPurchase, rejectPurchase };
