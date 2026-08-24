const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../lib/db');
const { newId } = require('../lib/id');
const { JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
}

function publicUser(u) {
  const { passwordHash, ...rest } = u;
  return rest;
}

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  const { role, fullName, phone, email, password, serie, bio, matieres } = req.body || {};

  if (!role || !['STUDENT', 'PROFESSOR'].includes(role)) {
    return res.status(400).json({ error: 'INVALID_ROLE', message: "Le rôle doit être STUDENT ou PROFESSOR." });
  }
  if (!fullName || !phone || !password) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Nom complet, téléphone et mot de passe requis.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'WEAK_PASSWORD', message: 'Mot de passe trop court (6 caractères minimum).' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
  if (existing) {
    return res.status(409).json({ error: 'PHONE_TAKEN', message: 'Ce numéro de téléphone est déjà utilisé.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const id = newId('user');

  db.prepare(`
    INSERT INTO users (id, role, fullName, phone, email, passwordHash, serie, bio, matieres)
    VALUES (@id, @role, @fullName, @phone, @email, @passwordHash, @serie, @bio, @matieres)
  `).run({
    id, role, fullName, phone,
    email: email || null,
    passwordHash,
    serie: role === 'STUDENT' ? (serie || 'C') : null,
    bio: bio || null,
    matieres: matieres || null,
  });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const token = signToken(user);
  res.status(201).json({ token, user: publicUser(user) });
});

// POST /api/auth/login
// body: { phone, password, deviceId, deviceLabel }
// Si le compte n'a encore aucun appareil lié -> on lie cet appareil (premher login).
// Si le compte est déjà lié à un autre appareil -> connexion refusée (409),
// c'est ici que la règle "un seul téléphone par compte" est réellement appliquée.
router.post('/login', async (req, res) => {
  const { phone, password, deviceId, deviceLabel } = req.body || {};
  if (!phone || !password || !deviceId) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Téléphone, mot de passe et identifiant d’appareil requis.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user) return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Identifiants invalides.' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Identifiants invalides.' });

  if (!user.deviceId) {
    db.prepare(`UPDATE users SET deviceId = ?, deviceBoundAt = datetime('now'), deviceLabel = ? WHERE id = ?`)
      .run(deviceId, deviceLabel || null, user.id);
  } else if (user.deviceId !== deviceId) {
    return res.status(409).json({
      error: 'DEVICE_MISMATCH',
      message: 'Ce compte est déjà utilisé sur un autre téléphone. Un seul appareil est autorisé par compte.',
      boundAt: user.deviceBoundAt,
    });
  }

  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  const token = signToken(fresh);
  res.json({ token, user: publicUser(fresh) });
});

// POST /api/auth/device/release
// Permet de délier l'appareil actuel (ex: l'élève a changé de téléphone).
// En production, cette route DOIT être protégée par une vérification
// supplémentaire (code OTP envoyé par SMS au numéro du compte) avant
// d'autoriser le changement d'appareil — sinon la protection ne sert à rien.
// Ici, elle est volontairement simple pour la démonstration.
router.post('/device/release', async (req, res) => {
  const { phone, password } = req.body || {};
  if (!phone || !password) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Téléphone et mot de passe requis.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user) return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Identifiants invalides.' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Identifiants invalides.' });

  db.prepare(`UPDATE users SET deviceId = NULL, deviceBoundAt = NULL, deviceLabel = NULL WHERE id = ?`).run(user.id);
  res.json({ message: 'Appareil délié. La prochaine connexion liera un nouvel appareil.' });
});

module.exports = router;
