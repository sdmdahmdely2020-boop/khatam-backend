const jwt = require('jsonwebtoken');
const db = require('../lib/db');

// AUCUNE valeur par défaut ici volontairement : un secret JWT deviné/fixe
// (ex. l'ancien "dev-secret") permettrait à n'importe qui de forger un jeton
// valide pour n'importe quel compte (y compris professeur, avec accès au
// portefeuille/retraits). Si la variable n'est pas configurée, le serveur
// refuse de démarrer plutôt que de tourner avec un secret faible connu de
// tous ceux qui lisent ce code source.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error(
    "JWT_SECRET n'est pas configurée. Définissez une variable d'environnement JWT_SECRET " +
    "(chaîne longue et aléatoire, ex. générée avec `node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"`) " +
    'avant de démarrer le serveur.'
  );
}

// Vérifie le JWT et charge l'utilisateur. Vérifie aussi que la requête vient
// bien de l'appareil lié au compte (en-tête X-Device-Id) — c'est ici que la
// règle "un compte = un seul téléphone" est réellement appliquée côté serveur.
function requireAuth(opts = {}) {
  const { roles, enforceDevice = true } = opts;

  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Connexion requise.' });

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ error: 'INVALID_TOKEN', message: 'Session invalide ou expirée.' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
    if (!user) return res.status(401).json({ error: 'INVALID_TOKEN', message: 'Compte introuvable.' });

    if (roles && !roles.includes(user.role)) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Accès réservé à un autre type de compte.' });
    }

    if (enforceDevice && user.deviceId) {
      const incomingDevice = req.headers['x-device-id'];
      if (!incomingDevice || incomingDevice !== user.deviceId) {
        return res.status(409).json({
          error: 'DEVICE_MISMATCH',
          message: "Ce compte est déjà lié à un autre appareil. Connexion refusée depuis cet appareil.",
        });
      }
    }

    delete user.passwordHash;
    req.user = user;
    next();
  };
}

// Variante "optionnelle" de requireAuth : ne bloque jamais la requête, mais
// pose req.user si (et seulement si) un jeton valide est fourni. Utilisée
// pour les routes publiques (catalogue) qui veulent quand même savoir si un
// document est débloqué pour le visiteur connecté — sans jamais faire
// confiance à un identifiant fourni "en clair" par le client (voir l'ancien
// en-tête X-Viewer-Id, qui n'était pas vérifié et permettait à n'importe qui
// de sonder l'accès à un document pour n'importe quel compte deviné).
function optionalAuth() {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) { req.user = null; return next(); }
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
      if (user) { delete user.passwordHash; req.user = user; } else { req.user = null; }
    } catch (e) {
      req.user = null;
    }
    next();
  };
}

// Protège les routes d'administration (panneau de confirmation des paiements,
// réglages des numéros Bankily/Masrivi/Sedad). Volontairement simple (une clé
// secrète unique, pas de compte) car il n'y a qu'un seul administrateur pour
// l'instant. La clé doit être définie dans la variable d'environnement
// ADMIN_KEY ; si elle n'est pas définie, toutes les routes admin sont
// refusées par défaut (fail closed) plutôt que de rester ouvertes.
function requireAdminKey(req, res, next) {
  const configured = process.env.ADMIN_KEY;
  const provided = req.headers['x-admin-key'];
  if (!configured) {
    return res.status(503).json({ error: 'ADMIN_NOT_CONFIGURED', message: "ADMIN_KEY n'est pas configurée côté serveur." });
  }
  if (!provided || provided !== configured) {
    return res.status(401).json({ error: 'INVALID_ADMIN_KEY', message: 'Clé administrateur invalide.' });
  }
  next();
}

// Protège le webhook de paiement (routes/payments.js). Accepte PAYMENTS_WEBHOOK_KEY
// si elle est configurée, sinon retombe sur ADMIN_KEY (comportement historique) —
// mais définir une clé dédiée réduit le risque : si cette clé fuite un jour vers
// un vrai opérateur de paiement, elle ne donne pas accès au reste du panneau
// d'administration (suppression de comptes, réglages...).
function requireWebhookKey(req, res, next) {
  const configured = process.env.PAYMENTS_WEBHOOK_KEY || process.env.ADMIN_KEY;
  const provided = req.headers['x-webhook-key'] || req.headers['x-admin-key'];
  if (!configured) {
    return res.status(503).json({ error: 'WEBHOOK_NOT_CONFIGURED', message: "La clé de webhook n'est pas configurée côté serveur." });
  }
  if (!provided || provided !== configured) {
    return res.status(401).json({ error: 'INVALID_WEBHOOK_KEY', message: 'Clé de webhook invalide.' });
  }
  next();
}

module.exports = { requireAuth, optionalAuth, requireAdminKey, requireWebhookKey, JWT_SECRET };
