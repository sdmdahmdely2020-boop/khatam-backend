const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const { newId } = require('../lib/id');
const { JWT_SECRET, requireAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const { photoUpload, PHOTO_DIR } = require('../lib/photoUpload');
const { sendVerificationEmail, checkVerificationCode } = require('../lib/email');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
}

function publicUser(u) {
  const { passwordHash, ...rest } = u;
  return { ...rest, photoUrl: u.photoPath ? `/uploads/photos/${u.photoPath}` : null };
}

// Lie l'appareil courant à un compte, ou vérifie qu'il correspond déjà à
// celui lié — logique partagée entre /login et /verify-email (la
// vérification de l'email connecte directement l'élève/professeur, sans lui
// faire refaire un /login séparé juste après).
function bindDeviceOrThrow(user, deviceId, deviceLabel) {
  if (!user.deviceId) {
    db.prepare(`UPDATE users SET deviceId = ?, deviceBoundAt = datetime('now'), deviceLabel = ? WHERE id = ?`)
      .run(deviceId, deviceLabel || null, user.id);
  } else if (user.deviceId !== deviceId) {
    const err = new Error('Ce compte est déjà utilisé sur un autre téléphone. Un seul appareil est autorisé par compte.');
    err.status = 409;
    err.code = 'DEVICE_MISMATCH';
    err.boundAt = user.deviceBoundAt;
    throw err;
  }
}

// POST /api/auth/signup
// N'active PAS le compte immédiatement : envoie un code de vérification par
// email et attend POST /verify-email pour terminer l'inscription (voir plus
// bas). Le téléphone reste requis (contact, Bankily/Masrivi) mais n'est plus
// lui-même vérifié par code — voir la mise à jour du 26/08 (SMS payant
// abandonné au profit d'un email gratuit). Un professeur doit en plus
// indiquer son établissement, la matière enseignée et ses années
// d'expérience — son compte reste en attente d'approbation par un
// administrateur avant de pouvoir publier quoi que ce soit (voir
// routes/documents.js et routes/admin.js), même une fois l'email vérifié.
router.post('/signup', authLimiter, async (req, res) => {
  const {
    role, fullName, phone, email, password, serie, bio, matieres,
    etablissement, experienceYears,
  } = req.body || {};

  if (!role || !['STUDENT', 'PROFESSOR'].includes(role)) {
    return res.status(400).json({ error: 'INVALID_ROLE', message: "Le rôle doit être STUDENT ou PROFESSOR." });
  }
  if (!fullName || !phone || !password || !email) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Nom complet, téléphone, email et mot de passe requis.' });
  }
  if (!EMAIL_RE.test(String(email).trim())) {
    return res.status(400).json({ error: 'INVALID_EMAIL', message: 'Adresse email invalide.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'WEAK_PASSWORD', message: 'Mot de passe trop court (6 caractères minimum).' });
  }
  let experienceYearsNum = null;
  if (role === 'PROFESSOR') {
    if (!etablissement || !String(etablissement).trim() || !matieres || !String(matieres).trim()) {
      return res.status(400).json({ error: 'MISSING_FIELDS', message: "Établissement et matière enseignée requis pour un compte professeur." });
    }
    experienceYearsNum = Number(experienceYears);
    if (!Number.isInteger(experienceYearsNum) || experienceYearsNum < 0 || experienceYearsNum > 60) {
      return res.status(400).json({ error: 'INVALID_EXPERIENCE', message: "Années d'expérience invalides." });
    }
  }

  const existingPhone = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
  if (existingPhone) {
    return res.status(409).json({ error: 'PHONE_TAKEN', message: 'Ce numéro de téléphone est déjà utilisé.' });
  }
  const existingEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email).trim());
  if (existingEmail) {
    return res.status(409).json({ error: 'EMAIL_TAKEN', message: 'Cette adresse email est déjà utilisée.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const id = newId('user');

  db.prepare(`
    INSERT INTO users (id, role, fullName, phone, email, passwordHash, serie, bio, matieres, etablissement, experienceYears, professorStatus, emailVerified)
    VALUES (@id, @role, @fullName, @phone, @email, @passwordHash, @serie, @bio, @matieres, @etablissement, @experienceYears, @professorStatus, 0)
  `).run({
    id, role, fullName, phone,
    email: String(email).trim(),
    passwordHash,
    serie: role === 'STUDENT' ? (serie || 'C') : null,
    bio: bio || null,
    matieres: matieres || null,
    etablissement: role === 'PROFESSOR' ? String(etablissement).trim() : null,
    experienceYears: role === 'PROFESSOR' ? experienceYearsNum : null,
    professorStatus: role === 'PROFESSOR' ? 'pending' : null,
  });

  try {
    await sendVerificationEmail(String(email).trim());
  } catch (e) {
    // Le compte est créé mais pas encore vérifiable par email — on prévient
    // clairement plutôt que de laisser un compte fantôme sans explication.
    return res.status(e.status || 502).json({ error: e.code || 'EMAIL_SEND_FAILED', message: e.message });
  }

  res.status(201).json({ needsVerification: true, email: String(email).trim() });
});

// POST /api/auth/verify-email  { email, code, deviceId, deviceLabel }
// Termine l'inscription (ou une nouvelle vérification si besoin) : vérifie
// le code envoyé par email, marque le compte vérifié, lie l'appareil comme le
// ferait /login, et renvoie directement un jeton — pas besoin de refaire un
// /login séparé juste après.
router.post('/verify-email', authLimiter, async (req, res) => {
  const { email, code, deviceId, deviceLabel } = req.body || {};
  if (!email || !code || !deviceId) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Email, code et identifiant d’appareil requis.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim());
  if (!user) return res.status(404).json({ error: 'NOT_FOUND', message: 'Aucun compte avec cet email.' });
  if (user.emailVerified) {
    return res.status(400).json({ error: 'ALREADY_VERIFIED', message: 'Ce compte est déjà vérifié — connectez-vous normalement.' });
  }

  const ok = checkVerificationCode(String(email).trim(), code);
  if (!ok) return res.status(400).json({ error: 'INVALID_CODE', message: 'Code invalide ou expiré.' });

  db.prepare('UPDATE users SET emailVerified = 1 WHERE id = ?').run(user.id);

  try {
    bindDeviceOrThrow(user, deviceId, deviceLabel);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.code || 'ERROR', message: e.message, boundAt: e.boundAt });
  }

  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  const token = signToken(fresh);
  res.json({ token, user: publicUser(fresh) });
});

// POST /api/auth/resend-code  { email }
// Renvoie un nouveau code si le compte existe et n'est pas déjà vérifié.
// Limité par authLimiter (voir middleware/rateLimit.js).
router.post('/resend-code', authLimiter, async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Email requis.' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim());
  if (!user) return res.status(404).json({ error: 'NOT_FOUND', message: 'Aucun compte avec cet email.' });
  if (user.emailVerified) {
    return res.status(400).json({ error: 'ALREADY_VERIFIED', message: 'Ce compte est déjà vérifié — connectez-vous normalement.' });
  }
  try {
    await sendVerificationEmail(String(email).trim());
  } catch (e) {
    return res.status(e.status || 502).json({ error: e.code || 'EMAIL_SEND_FAILED', message: e.message });
  }
  res.json({ sent: true });
});

// POST /api/auth/login
// body: { phone, password, deviceId, deviceLabel }
// Si le compte n'a encore aucun appareil lié -> on lie cet appareil (premher login).
// Si le compte est déjà lié à un autre appareil -> connexion refusée (409),
// c'est ici que la règle "un seul téléphone par compte" est réellement appliquée.
// Bloque aussi tant que l'email n'a pas été vérifié (voir /verify-email) — un
// compte créé mais jamais vérifié ne peut pas se connecter. On renvoie
// l'email du compte dans la réponse : le formulaire de connexion ne demande
// que le téléphone, le frontend a besoin de cette adresse pour renvoyer un
// code sans redemander à l'utilisateur de la retaper.
router.post('/login', authLimiter, async (req, res) => {
  const { phone, password, deviceId, deviceLabel } = req.body || {};
  if (!phone || !password || !deviceId) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Téléphone, mot de passe et identifiant d’appareil requis.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user) return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Identifiants invalides.' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Identifiants invalides.' });

  if (!user.emailVerified) {
    return res.status(403).json({
      error: 'EMAIL_NOT_VERIFIED',
      message: 'Vérifiez votre adresse email avant de vous connecter.',
      email: user.email,
    });
  }

  try {
    bindDeviceOrThrow(user, deviceId, deviceLabel);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.code || 'ERROR', message: e.message, boundAt: e.boundAt });
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
router.post('/device/release', authLimiter, async (req, res) => {
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

// GET /api/auth/me — renvoie les données à jour du compte connecté. Utilisé
// par le frontend pour rafraîchir currentUser (ex. professorStatus après une
// approbation admin) sans devoir se reconnecter — sans cette route, une
// session restaurée depuis le stockage local du navigateur resterait figée
// sur les données telles qu'elles étaient au moment du dernier login.
router.get('/me', requireAuth(), (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// POST /api/auth/me/photo — dépose/remplace la photo de profil de
// l'utilisateur connecté (élève ou professeur), champ multipart "photo".
router.post('/me/photo', requireAuth(), photoUpload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'MISSING_FILE', message: 'Image requise (champ "photo").' });

  const prev = db.prepare('SELECT photoPath FROM users WHERE id = ?').get(req.user.id);
  db.prepare('UPDATE users SET photoPath = ? WHERE id = ?').run(req.file.filename, req.user.id);
  if (prev && prev.photoPath) {
    try { fs.unlinkSync(path.join(PHOTO_DIR, prev.photoPath)); } catch (e) {}
  }

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(updated) });
});

// DELETE /api/auth/me/photo — retire la photo de profil (retour à l'avatar
// à initiales, déjà affiché par défaut côté frontend).
router.delete('/me/photo', requireAuth(), (req, res) => {
  const prev = db.prepare('SELECT photoPath FROM users WHERE id = ?').get(req.user.id);
  if (prev && prev.photoPath) {
    try { fs.unlinkSync(path.join(PHOTO_DIR, prev.photoPath)); } catch (e) {}
  }
  db.prepare('UPDATE users SET photoPath = NULL WHERE id = ?').run(req.user.id);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(updated) });
});

module.exports = router;
