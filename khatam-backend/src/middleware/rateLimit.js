const rateLimit = require('express-rate-limit');

// Limite les tentatives de connexion/inscription par IP — sans ça, un
// attaquant peut essayer des milliers de mots de passe par minute contre un
// numéro de téléphone connu (brute-force) ou énumérer quels numéros sont déjà
// inscrits (PHONE_TAKEN). 20 essais / 15 min est large pour un usage normal
// (un élève qui se trompe de mot de passe plusieurs fois) mais bloque un
// script automatisé.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'TOO_MANY_ATTEMPTS', message: 'Trop de tentatives. Réessayez dans quelques minutes.' },
});

// La clé d'administration (X-Admin-Key) est un secret unique, sans compte ni
// verrouillage — sans limite de débit, elle serait brute-forçable. 120
// requêtes/15 min reste largement suffisant pour rendre un brute-force
// impraticable (la clé elle-même est un secret long, pas un code à 4
// chiffres), tout en laissant de la marge pour un usage humain normal du
// panneau d'admin. Relevé de 30 à 120 le 29/08 : admin.html charge
// maintenant ~16 routes /admin/* en parallèle à chaque ouverture/actualisation
// (ajout de la section abonnements), ce qui épuisait la limite précédente en
// à peine deux actualisations.
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'TOO_MANY_ATTEMPTS', message: 'Trop de requêtes. Réessayez dans quelques minutes.' },
});

module.exports = { authLimiter, adminLimiter };
