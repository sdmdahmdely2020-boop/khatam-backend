const db = require('./db');
const { effectivePlan } = require('./subscriptions');

// Un document est accessible en entier à un utilisateur si : il est gratuit,
// il/elle est le professeur propriétaire, il/elle a un achat confirmé,
// il/elle l'a débloqué en regardant une publicité (uniquement si le document
// l'autorise), ou il/elle a un abonnement Premium actif (modèle hybride,
// 29/08 — voir lib/subscriptions.js).
function hasAccess(userId, doc) {
  if (!doc) return false;
  // Le professeur propriétaire garde toujours accès à son propre document,
  // même dépublié (brouillon) — tout le monde d'autre doit d'abord voir le
  // document publié pour pouvoir y accéder, quel que soit le prix/free/pub.
  if (userId && doc.professorId === userId) return true;
  if (doc.statut !== 'publie') return false;
  if (doc.free) return true;
  if (!userId) return false;

  // Abonnement Premium : accès complet, sans achat individuel. Vérifié ici
  // (le seul point de passage pour l'accès réel, utilisé à la fois par
  // toPublicDoc() et par les routes qui servent le contenu) pour qu'aucun
  // autre endroit du code n'ait besoin de connaître cette règle séparément.
  const subscriber = db.prepare('SELECT subscriptionPlan, subscriptionExpiresAt FROM users WHERE id = ?').get(userId);
  if (subscriber && effectivePlan(subscriber).plan === 'premium') return true;

  const purchase = db.prepare(
    `SELECT id FROM purchases WHERE userId = ? AND documentId = ? AND status = 'confirmed' LIMIT 1`
  ).get(userId, doc.id);
  if (purchase) return true;

  if (doc.adUnlock) {
    const ad = db.prepare(`SELECT id FROM ad_unlocks WHERE userId = ? AND documentId = ?`).get(userId, doc.id);
    if (ad) return true;
  }

  return false;
}

module.exports = { hasAccess };
