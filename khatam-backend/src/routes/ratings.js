// Note de l'application Khatam elle-même (pas d'un document précis) —
// demandé par sidi le 27/08. Un seul avis par utilisateur (UPSERT), visible
// uniquement par l'administrateur (voir GET /api/admin/ratings, routes/admin.js).

const express = require('express');
const db = require('../lib/db');
const { newId } = require('../lib/id');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /api/ratings  { stars: 1-5, comment? }
// Réservé aux utilisateurs connectés (élève ou professeur) — un envoi
// remplace le précédent avis du même utilisateur (UNIQUE(userId) en base).
router.post('/', requireAuth({ roles: ['STUDENT', 'PROFESSOR'] }), (req, res) => {
  const { stars, comment } = req.body || {};
  const starsNum = Number(stars);
  if (!Number.isInteger(starsNum) || starsNum < 1 || starsNum > 5) {
    return res.status(400).json({ error: 'INVALID_STARS', message: 'stars doit être un entier entre 1 et 5.' });
  }
  const existing = db.prepare('SELECT id FROM app_ratings WHERE userId = ?').get(req.user.id);
  if (existing) {
    db.prepare('UPDATE app_ratings SET stars = ?, comment = ?, role = ?, createdAt = datetime(\'now\') WHERE id = ?')
      .run(starsNum, comment ? String(comment).trim().slice(0, 1000) : null, req.user.role, existing.id);
  } else {
    db.prepare(`
      INSERT INTO app_ratings (id, userId, role, stars, comment)
      VALUES (?, ?, ?, ?, ?)
    `).run(newId('rat'), req.user.id, req.user.role, starsNum, comment ? String(comment).trim().slice(0, 1000) : null);
  }
  res.status(201).json({ message: 'Merci pour votre avis !' });
});

// GET /api/ratings/me — l'avis déjà envoyé par l'utilisateur connecté, s'il existe
// (pour préremplir le formulaire au lieu de lui faire ré-écrire à chaque fois).
router.get('/me', requireAuth({ roles: ['STUDENT', 'PROFESSOR'] }), (req, res) => {
  const rating = db.prepare('SELECT stars, comment FROM app_ratings WHERE userId = ?').get(req.user.id);
  res.json({ rating: rating || null });
});

module.exports = router;
