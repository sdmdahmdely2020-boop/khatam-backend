const express = require('express');
const db = require('../lib/db');
const { newId } = require('../lib/id');
const { requireAuth } = require('../middleware/auth');
const { hasAccess } = require('../lib/access');

const router = express.Router();

// POST /api/documents/:id/ai-grade  { answerText }
//
// IMPORTANT : ceci est un STUB. La vraie fonctionnalité ("l'IA compare la
// réponse de l'élève à la correction du professeur et attribue une note")
// nécessite d'appeler un vrai modèle de langage (ex. l'API Claude
// d'Anthropic) avec le texte de la correction officielle et la réponse de
// l'élève, ce qui suppose : (1) extraire le texte de la correction PDF,
// (2) une clé API, (3) un prompt de correction soigneusement conçu par
// matière. Le code ci-dessous simule un délai et renvoie une note
// heuristique simple, pour que le reste du produit (historique, workflow)
// soit démontrable dès maintenant. Voir README section "Brancher la vraie
// correction IA" pour le plan d'implémentation.
router.post('/documents/:id/ai-grade', requireAuth({ roles: ['STUDENT'] }), async (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });
  if (!doc.aiGrading) return res.status(400).json({ error: 'NOT_AI_ELIGIBLE', message: 'La correction IA n’est pas activée pour ce document.' });
  if (!hasAccess(req.user.id, doc)) return res.status(403).json({ error: 'LOCKED' });

  const { answerText } = req.body || {};
  if (!answerText || answerText.trim().length < 10) {
    return res.status(400).json({ error: 'ANSWER_TOO_SHORT', message: 'Réponse trop courte pour être corrigée.' });
  }

  // Heuristique de démonstration (À REMPLACER par un appel LLM réel) :
  // note basée sur la longueur / densité de la réponse, plafonnée à 20.
  const words = answerText.trim().split(/\s+/).length;
  const note = Math.min(20, Math.max(4, Math.round((words / 12) * 10) / 10));
  const feedback = note >= 14
    ? "Bonne maîtrise des notions clés. Continuez à détailler chaque étape du raisonnement."
    : "Des notions importantes manquent ou sont mal justifiées. Revoyez la correction du professeur point par point.";

  const id = newId('sub');
  db.prepare(`
    INSERT INTO ai_submissions (id, studentId, documentId, answerText, note, feedback, status)
    VALUES (?, ?, ?, ?, ?, ?, 'graded')
  `).run(id, req.user.id, doc.id, answerText, note, feedback);

  res.status(201).json({ submission: { id, note, feedback, status: 'graded' } });
});

// GET /api/ai/history — historique des corrections IA de l'élève connecté
router.get('/history', requireAuth({ roles: ['STUDENT'] }), (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, d.title FROM ai_submissions s JOIN documents d ON d.id = s.documentId
    WHERE s.studentId = ? ORDER BY s.createdAt DESC
  `).all(req.user.id);
  res.json({ submissions: rows });
});

module.exports = router;
