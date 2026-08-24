const jwt = require('jsonwebtoken');
const db = require('../lib/db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

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

module.exports = { requireAuth, requireAdminKey, JWT_SECRET };
