const express = require('express');
const db = require('../lib/db');
const { newId } = require('../lib/id');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const BOOST_PRICE_MRU = Number(process.env.BOOST_PRICE_MRU || 500);
const BOOST_DURATION_DAYS = Number(process.env.BOOST_DURATION_DAYS || 30);

function likesCount(professorId) {
  return db.prepare('SELECT COUNT(*) as n FROM likes WHERE professorId = ?').get(professorId).n;
}
function isBoosted(professor) {
  return !!(professor.boostActiveUntil && new Date(professor.boostActiveUntil) > new Date());
}

// GET /api/professors/:id — profil public
router.get('/:id', (req, res) => {
  const p = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'PROFESSOR'`).get(req.params.id);
  if (!p) return res.status(404).json({ error: 'NOT_FOUND' });
  const docs = db.prepare(`SELECT COUNT(*) as n FROM documents WHERE professorId = ? AND statut = 'publie'`).get(p.id).n;
  res.json({
    professor: {
      id: p.id, fullName: p.fullName, bio: p.bio, matieres: p.matieres,
      photoUrl: p.photoPath ? `/uploads/photos/${p.photoPath}` : null,
      likes: likesCount(p.id), boosted: isBoosted(p), documentsCount: docs,
    },
  });
});

// POST /api/professors/:id/like — bascule like/unlike par un élève
router.post('/:id/like', requireAuth({ roles: ['STUDENT'] }), (req, res) => {
  const p = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'PROFESSOR'`).get(req.params.id);
  if (!p) return res.status(404).json({ error: 'NOT_FOUND' });

  const existing = db.prepare('SELECT id FROM likes WHERE studentId = ? AND professorId = ?').get(req.user.id, p.id);
  if (existing) {
    db.prepare('DELETE FROM likes WHERE id = ?').run(existing.id);
    return res.json({ liked: false, likes: likesCount(p.id) });
  }
  db.prepare('INSERT INTO likes (id, studentId, professorId) VALUES (?, ?, ?)').run(newId('like'), req.user.id, p.id);
  res.json({ liked: true, likes: likesCount(p.id) });
});

// GET /api/professors/me/ai-submissions — corrections IA réalisées sur les
// documents du professeur connecté (élève, document, note, date). Remplace
// l'ancienne donnée d'illustration figée côté frontend (PROF_AI_SUBMISSIONS)
// par de vraies soumissions, désormais que de vrais professeurs/élèves
// utilisent la plateforme.
router.get('/me/ai-submissions', requireAuth({ roles: ['PROFESSOR'] }), (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.note, s.createdAt, d.title AS documentTitle, u.fullName AS studentName
    FROM ai_submissions s
    JOIN documents d ON d.id = s.documentId
    JOIN users u ON u.id = s.studentId
    WHERE d.professorId = ? AND s.status = 'graded'
    ORDER BY s.createdAt DESC
    LIMIT 200
  `).all(req.user.id);
  res.json({ submissions: rows });
});

// POST /api/professors/me/boost — active le mode Boost (payant) pour le
// professeur connecté. Débite directement le solde du portefeuille pour
// cette démo ; en production on ferait normalement passer ceci par le même
// module de paiement que les achats de documents (src/lib/payments.js).
router.post('/me/boost', requireAuth({ roles: ['PROFESSOR'] }), (req, res) => {
  const p = req.user;
  if (p.walletBalance < BOOST_PRICE_MRU) {
    return res.status(402).json({
      error: 'INSUFFICIENT_BALANCE',
      message: `Solde insuffisant. Le Boost coûte ${BOOST_PRICE_MRU} MRU, votre solde est de ${p.walletBalance} MRU.`,
    });
  }
  const until = new Date(Date.now() + BOOST_DURATION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE users SET walletBalance = walletBalance - ?, boostActiveUntil = ? WHERE id = ?')
    .run(BOOST_PRICE_MRU, until, p.id);
  res.json({ boosted: true, boostActiveUntil: until });
});

// GET /api/professors/me/messages — fil de discussion (un seul, admin <->
// ce professeur) du professeur connecté. Marque les messages envoyés par
// l'admin comme lus par le professeur (miroir de la route admin équivalente
// dans routes/admin.js, qui marque les messages du professeur comme lus par
// l'admin).
router.get('/me/messages', requireAuth({ roles: ['PROFESSOR'] }), (req, res) => {
  const rows = db.prepare(`SELECT * FROM admin_messages WHERE professorId = ? ORDER BY createdAt ASC`).all(req.user.id);
  db.prepare(`UPDATE admin_messages SET readByProfessor = 1 WHERE professorId = ? AND sender = 'admin'`).run(req.user.id);
  res.json({ messages: rows });
});

// POST /api/professors/me/messages  { body } — le professeur connecté
// envoie un message à l'administrateur.
router.post('/me/messages', requireAuth({ roles: ['PROFESSOR'] }), (req, res) => {
  const { body } = req.body || {};
  if (!body || !String(body).trim()) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Message requis.' });
  }
  const id = newId('msg');
  db.prepare(`
    INSERT INTO admin_messages (id, professorId, sender, body, readByAdmin, readByProfessor)
    VALUES (?, ?, 'professor', ?, 0, 1)
  `).run(id, req.user.id, String(body).trim().slice(0, 2000));
  res.status(201).json({ message: db.prepare('SELECT * FROM admin_messages WHERE id = ?').get(id) });
});

// GET /api/professors/me/messages/unread-count — badge "non lu" côté
// professeur (nombre de messages de l'admin pas encore lus).
router.get('/me/messages/unread-count', requireAuth({ roles: ['PROFESSOR'] }), (req, res) => {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM admin_messages WHERE professorId = ? AND sender = 'admin' AND readByProfessor = 0
  `).get(req.user.id);
  res.json({ count: row.n });
});

module.exports = router;
