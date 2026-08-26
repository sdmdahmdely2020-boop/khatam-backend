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
// verrouillage — sans limite de débit, elle serait brute-forçable. 30
// requêtes/15 min est confortable pour un usage humain normal du panneau
// d'admin, mais rend un brute-force impraticable.
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'TOO_MANY_ATTEMPTS', message: 'Trop de requêtes. Réessayez dans quelques minutes.' },
});

module.exports = { authLimiter, adminLimiter };
