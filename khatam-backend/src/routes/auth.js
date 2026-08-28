const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const { newId } = require('../lib/id');
const { JWT_SECRET, requireAuth, ENFORCE_SINGLE_DEVICE } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const { photoUpload, PHOTO_DIR } = require('../lib/photoUpload');
const { sendVerificationEmail, checkVerificationCode } = require('../lib/email');
const { deleteUserCascade } = require('../lib/cascade');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// EMAIL_RE seule laissait passer des adresses invalides comme
// "nom@.gmail.com" (point juste après le "@") : les deux groupes
// [^\s@]+ peuvent se répartir n'importe où autour du point littéral, donc
// un domaine commençant par un point matchait quand même. Bug découvert le
// 27/08 en production : plusieurs élèves ont tapé cette faute de frappe
// (fréquente au clavier mobile), Gmail refusait ensuite l'envoi (voir
// lib/email.js), et le compte restait bloqué en "fantôme" (voir plus bas).
// isValidEmail() ajoute les vérifications qu'un simple pattern regex gère
// mal : pas de point en tout début/fin de la partie locale OU du domaine,
// pas de points consécutifs.
function isValidEmail(raw) {
  const email = String(raw || '').trim();
  if (!EMAIL_RE.test(email)) return false;
  const atIndex = email.lastIndexOf('@');
  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;
  return true;
}

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
  // Désactivée pour le moment (voir ENFORCE_SINGLE_DEVICE dans
  // middleware/auth.js) : ne bloque plus, et ne réécrit plus non plus
  // deviceId à chaque connexion tant que c'est désactivé — pour ne pas
  // perdre silencieusement l'ancienne valeur si la règle est un jour
  // réactivée avec des comptes déjà liés à un appareil différent entre
  // temps.
  if (!ENFORCE_SINGLE_DEVICE) return;

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
  if (!isValidEmail(email)) {
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
    // L'envoi a échoué (adresse rejetée par Gmail, ou panne passagère) — on
    // SUPPRIME immédiatement le compte qu'on venait de créer plutôt que de
    // le laisser en "fantôme" (bug découvert le 27/08 : un compte non
    // vérifiable bloquait pour toujours le téléphone ET l'email utilisés,
    // empêchant la personne de recommencer même après avoir corrigé sa
    // faute de frappe — jusqu'ici il fallait une suppression manuelle par
    // l'admin). Comme personne n'a encore rien pu faire avec ce compte
    // (email jamais vérifié), le supprimer immédiatement est sans risque.
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
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

// POST /api/auth/forgot-password  { email }
// Envoie un code de réinitialisation par email si un compte existe pour cette
// adresse — répond TOUJOURS { sent: true } même si aucun compte ne correspond
// (pour ne jamais laisser un visiteur deviner quelles adresses sont
// inscrites, comme le fait déjà PHONE_TAKEN/EMAIL_TAKEN à l'inscription ne
// le permet pas ici puisque cette route est publique et anonyme). purpose
// 'reset' (voir lib/email.js) — indépendant de tout code d'inscription en
// attente pour la même adresse.
router.post('/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body || {};
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'INVALID_EMAIL', message: 'Adresse email valide requise.' });
  }
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email).trim());
  if (user) {
    try {
      await sendVerificationEmail(String(email).trim(), 'reset');
    } catch (e) {
      // On ne révèle jamais si l'email existe ou non via le statut d'erreur —
      // mais un vrai échec d'envoi (Gmail down) reste signalé pour ne pas
      // laisser croire à tort qu'un code est parti.
      return res.status(e.status || 502).json({ error: e.code || 'EMAIL_SEND_FAILED', message: e.message });
    }
  }
  res.json({ sent: true, message: 'Si un compte existe avec cet email, un code de réinitialisation vient de lui être envoyé.' });
});

// POST /api/auth/reset-password  { email, code, newPassword }
// Vérifie le code de réinitialisation puis change le mot de passe. Ne lie ni
// ne délie aucun appareil, et n'invalide pas les jetons JWT déjà émis (comme
// pour DELETE /me, requireAuth() recharge l'utilisateur à chaque requête —
// mais changer le mot de passe ne rend pas un jeton existant invalide pour
// autant, ce n'est pas un souci ici : la personne qui vient de prouver
// qu'elle contrôle l'email du compte a de toute façon un accès légitime).
router.post('/reset-password', authLimiter, async (req, res) => {
  const { email, code, newPassword } = req.body || {};
  if (!email || !code || !newPassword) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Email, code et nouveau mot de passe requis.' });
  }
  if (String(newPassword).length < 6) {
    return res.status(400).json({ error: 'WEAK_PASSWORD', message: 'Mot de passe trop court (6 caractères minimum).' });
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim());
  if (!user) return res.status(400).json({ error: 'INVALID_CODE', message: 'Code invalide ou expiré.' });

  const ok = checkVerificationCode(String(email).trim(), code, 'reset');
  if (!ok) return res.status(400).json({ error: 'INVALID_CODE', message: 'Code invalide ou expiré.' });

  const passwordHash = await bcrypt.hash(String(newPassword), 10);
  db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run(passwordHash, user.id);
  res.json({ message: 'Mot de passe réinitialisé. Vous pouvez maintenant vous connecter.' });
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

// DELETE /api/auth/me  { password }
// Suppression définitive et en libre-service du compte de l'utilisateur
// connecté (élève ou professeur) — demandée explicitement par sidi (27/08) :
// chaque utilisateur doit pouvoir supprimer son propre compte. Redemande le
// mot de passe pour confirmer (même logique que /device/release : une action
// aussi destructive et irréversible mérite une confirmation explicite, le
// jeton seul — qui peut avoir fuité ou être resté ouvert sur un appareil
// partagé — ne suffit pas). Utilise deleteUserCascade (lib/cascade.js, déjà
// utilisé par le panneau admin) pour supprimer aussi tout ce qui dépend du
// compte : documents (et fichiers PDF/aperçus associés), achats, favoris,
// likes, retraits, corrections IA (et copies envoyées), photo de profil.
// Rien n'a besoin d'invalider le jeton JWT explicitement : requireAuth()
// recharge l'utilisateur depuis la base à chaque requête (voir
// middleware/auth.js), donc toute requête suivante avec ce jeton échoue déjà
// naturellement avec 401 INVALID_TOKEN une fois le compte supprimé.
router.delete('/me', authLimiter, requireAuth(), async (req, res) => {
  const { password } = req.body || {};
  if (!password) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Mot de passe requis pour confirmer la suppression du compte.' });
  }
  const full = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const ok = await bcrypt.compare(password, full.passwordHash);
  if (!ok) return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Mot de passe incorrect.' });

  deleteUserCascade(req.user.id);
  res.json({ message: 'Compte supprimé définitivement.' });
});

module.exports = router;
