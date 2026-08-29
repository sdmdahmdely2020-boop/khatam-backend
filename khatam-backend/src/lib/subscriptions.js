// Abonnements Basic / Premium — modèle HYBRIDE décidé le 29/08 : ceci
// s'ajoute au système existant d'achat de document à l'unité (Bankily/
// Masrivi/Sedad, voir lib/payments.js), ça ne le remplace pas. Un élève peut
// continuer à acheter des documents un par un ET/OU souscrire à un abonnement :
//   - BASIC   : accès à une partie du contenu (documents "adUnlock" gratuits
//               via pub restent gratuits comme avant) + réduction sur les
//               documents payants achetés à l'unité.
//   - PREMIUM : accès complet à tous les documents sans achat individuel, pas
//               de publicité, contenu bonus (TD de la semaine, voir
//               routes/documents.js côté app).
//
// Comme pour purchases (voir payments.js), la confirmation reste TOUJOURS
// manuelle par l'administrateur après vérification du paiement — jamais
// automatique. Aucun contrat marchand réel n'existe encore avec Bankily/
// Masrivi/Sedad (voir la note en tête de payments.js) : initiatePayment()
// est réutilisée telle quelle, c'est la même simulation.

const db = require('./db');
const { getSetting, setSetting } = require('./settings');

// Valeurs par défaut si l'administrateur n'a encore rien configuré depuis
// admin.html — volontairement des nombres ronds et raisonnables plutôt que de
// bloquer cette livraison en attendant des prix exacts. Modifiables à tout
// moment sans redéploiement (stockées dans platform_settings, même mécanisme
// que les numéros Bankily/Masrivi/Sedad).
const DEFAULTS = {
  basicPrice: 300,
  premiumPrice: 800,
  durationDays: 30,
  basicDiscountPercent: 20,
};

const SETTING_KEYS = {
  basicPrice: 'subscription_basicPrice',
  premiumPrice: 'subscription_premiumPrice',
  durationDays: 'subscription_durationDays',
  basicDiscountPercent: 'subscription_basicDiscountPercent',
};

function getSubscriptionSettings() {
  const out = {};
  for (const key of Object.keys(SETTING_KEYS)) {
    const raw = getSetting(SETTING_KEYS[key]);
    const n = raw === null ? NaN : Number(raw);
    out[key] = Number.isFinite(n) ? n : DEFAULTS[key];
  }
  return out;
}

function setSubscriptionSetting(key, value) {
  if (!Object.prototype.hasOwnProperty.call(SETTING_KEYS, key)) {
    const err = new Error(`Réglage d'abonnement inconnu: ${key}`); err.status = 400; throw err;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    const err = new Error(`${key} doit être un nombre positif.`); err.status = 400; throw err;
  }
  setSetting(SETTING_KEYS[key], String(n));
}

function priceForPlan(plan) {
  const settings = getSubscriptionSettings();
  if (plan === 'basic') return settings.basicPrice;
  if (plan === 'premium') return settings.premiumPrice;
  const err = new Error(`Offre inconnue: ${plan}`); err.status = 400; throw err;
}

// Calcule le plan RÉELLEMENT actif à l'instant présent, à partir des colonnes
// brutes users.subscriptionPlan/subscriptionExpiresAt. Volontairement sans
// tâche planifiée : un abonnement expiré redevient 'free' de lui-même dès la
// prochaine lecture, sans avoir besoin de repasser par la base pour l'écrire.
// user peut être soit la ligne users complète, soit juste
// { subscriptionPlan, subscriptionExpiresAt }.
function effectivePlan(user) {
  if (!user || !user.subscriptionPlan || user.subscriptionPlan === 'free') {
    return { plan: 'free', expiresAt: null };
  }
  if (!user.subscriptionExpiresAt || new Date(user.subscriptionExpiresAt) <= new Date()) {
    return { plan: 'free', expiresAt: null };
  }
  return { plan: user.subscriptionPlan, expiresAt: user.subscriptionExpiresAt };
}

// Démarre un achat d'abonnement (statut "pending", comme purchases). Le
// blocage "déjà Premium actif" / "méthode de paiement non configurée" est
// géré côté route (routes/subscriptions.js) pour rester cohérent avec le
// style de routes/payments.js.
async function purchaseSubscription({ userId, plan, method, phone }) {
  const { newId } = require('./id');
  const { initiatePayment } = require('./payments');
  const settings = getSubscriptionSettings();
  const amount = priceForPlan(plan);
  const id = newId('sub');
  const result = await initiatePayment({ method, phone, amount, reference: id });

  db.prepare(`
    INSERT INTO subscription_purchases (id, userId, plan, amount, durationDays, method, status, providerRef)
    VALUES (@id, @userId, @plan, @amount, @durationDays, @method, 'pending', @providerRef)
  `).run({
    id, userId, plan, amount,
    durationDays: settings.durationDays,
    method,
    providerRef: result.providerRef,
  });

  return { id, amount, providerRef: result.providerRef, durationDays: settings.durationDays };
}

// Confirme un abonnement en attente : marque la ligne "confirmed" et met à
// jour users.subscriptionPlan/subscriptionExpiresAt. Renouvellement ADDITIF :
// si le même plan est déjà actif, la nouvelle durée s'ajoute à la date
// d'expiration existante (au lieu de repartir de zéro) — un élève qui
// renouvelle en avance ne perd pas les jours restants. Changer de plan
// (ex. Basic -> Premium) repart en revanche de maintenant, plus simple à
// raisonner qu'un mélange de deux plans différents.
//
// Contrairement à confirmPurchase() (achat de document), AUCUN portefeuille
// professeur n'est crédité ici : un abonnement n'est pas rattaché à un
// document ni à un professeur précis, c'est un revenu direct de la
// plateforme. Pas de ligne de vente fictive créée non plus (volontaire — voir
// discussion du 29/08 : éviter de polluer les statistiques de vente réelles
// tant qu'il n'y a pas de vrais professeurs externes).
function confirmSubscription(purchaseId) {
  const purchase = db.prepare('SELECT * FROM subscription_purchases WHERE id = ?').get(purchaseId);
  if (!purchase) { const err = new Error('Abonnement introuvable.'); err.status = 404; throw err; }
  if (purchase.status === 'confirmed') return purchase;
  if (purchase.status === 'failed') {
    const err = new Error('Cet abonnement a déjà été refusé.'); err.status = 409; throw err;
  }

  const tx = db.transaction(() => {
    db.prepare(`UPDATE subscription_purchases SET status = 'confirmed', confirmedAt = datetime('now') WHERE id = ?`).run(purchase.id);

    const user = db.prepare('SELECT subscriptionPlan, subscriptionExpiresAt FROM users WHERE id = ?').get(purchase.userId);
    const now = new Date();
    const currentlyActiveSamePlan =
      user.subscriptionPlan === purchase.plan &&
      user.subscriptionExpiresAt &&
      new Date(user.subscriptionExpiresAt) > now;

    const base = currentlyActiveSamePlan ? new Date(user.subscriptionExpiresAt) : now;
    const newExpiry = new Date(base.getTime() + purchase.durationDays * 24 * 60 * 60 * 1000);

    db.prepare('UPDATE users SET subscriptionPlan = ?, subscriptionExpiresAt = ? WHERE id = ?')
      .run(purchase.plan, newExpiry.toISOString(), purchase.userId);
  });
  tx();

  return db.prepare('SELECT * FROM subscription_purchases WHERE id = ?').get(purchase.id);
}

function rejectSubscription(purchaseId) {
  const purchase = db.prepare('SELECT * FROM subscription_purchases WHERE id = ?').get(purchaseId);
  if (!purchase) { const err = new Error('Abonnement introuvable.'); err.status = 404; throw err; }
  if (purchase.status === 'confirmed') {
    const err = new Error('Cet abonnement est déjà confirmé et ne peut plus être refusé.'); err.status = 409; throw err;
  }
  db.prepare(`UPDATE subscription_purchases SET status = 'failed' WHERE id = ?`).run(purchase.id);
  return db.prepare('SELECT * FROM subscription_purchases WHERE id = ?').get(purchase.id);
}

module.exports = {
  DEFAULTS,
  getSubscriptionSettings,
  setSubscriptionSetting,
  priceForPlan,
  effectivePlan,
  purchaseSubscription,
  confirmSubscription,
  rejectSubscription,
};
