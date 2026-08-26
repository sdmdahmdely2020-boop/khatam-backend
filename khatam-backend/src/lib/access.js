const db = require('./db');

// Un document est accessible en entier à un utilisateur si : il est gratuit,
// il/elle est le professeur propriétaire, il/elle a un achat confirmé, ou
// il/elle l'a débloqué en regardant une publicité (uniquement si le document
// l'autorise).
function hasAccess(userId, doc) {
  if (!doc) return false;
  // Le professeur propriétaire garde toujours accès à son propre document,
  // même dépublié (brouillon) — tout le monde d'autre doit d'abord voir le
  // document publié pour pouvoir y accéder, quel que soit le prix/free/pub.
  if (userId && doc.professorId === userId) return true;
  if (doc.statut !== 'publie') return false;
  if (doc.free) return true;
  if (!userId) return false;

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
