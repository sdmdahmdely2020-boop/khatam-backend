const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const { newId } = require('../lib/id');
const { requireAuth } = require('../middleware/auth');
const { hasAccess } = require('../lib/access');
const { submissionUpload, SUBMISSION_DIR } = require('../lib/submissionUpload');
const { gradeSubmission, apiKeyConfigured } = require('../lib/aiGrading');

const router = express.Router();

const PLACEHOLDER_TEXT = '[Réponse envoyée en photo/PDF]';

// Traduit les codes d'erreur levés par lib/aiGrading.js en réponses HTTP
// claires, en français, plutôt que de laisser passer une erreur 500 générique.
function sendGradingError(res, err) {
  console.error(err);
  if (err.code === 'AI_NOT_CONFIGURED') {
    return res.status(503).json({
      error: 'AI_NOT_CONFIGURED',
      message: "La correction IA n'est pas encore activée sur ce serveur. Réessayez un peu plus tard.",
    });
  }
  if (err.code === 'AI_CALL_FAILED' || err.code === 'AI_BAD_RESPONSE') {
    return res.status(502).json({
      error: err.code,
      message: "La correction IA n'a pas pu analyser cette copie pour le moment. Réessayez dans quelques instants.",
    });
  }
  return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Une erreur est survenue pendant la correction.' });
}

// POST /api/documents/:id/ai-grade — corrige la copie d'un élève avec l'IA.
// Deux façons d'envoyer la copie :
//  - multipart/form-data avec un champ "answerFile" (photo ou PDF) — méthode
//    principale, celle utilisée par l'appareil photo / le sélecteur de fichier ;
//  - JSON classique avec { answerText } — texte tapé directement, conservé en
//    solution de repli. submissionUpload.single() ne touche pas aux requêtes
//    JSON (il ne s'active que sur un Content-Type multipart), donc les deux
//    formes cohabitent sans souci sur la même route.
router.post('/documents/:id/ai-grade', requireAuth({ roles: ['STUDENT'] }), submissionUpload.single('answerFile'), async (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });
  if (!doc.aiGrading) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch (e) {} }
    return res.status(400).json({ error: 'NOT_AI_ELIGIBLE', message: "La correction IA n'est pas activée pour ce document." });
  }
  if (!hasAccess(req.user.id, doc)) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch (e) {} }
    return res.status(403).json({ error: 'LOCKED' });
  }

  const answerText = (req.body && req.body.answerText) || '';
  if (!req.file && answerText.trim().length < 10) {
    return res.status(400).json({ error: 'ANSWER_TOO_SHORT', message: 'Envoyez une photo/PDF de votre copie, ou tapez une réponse plus longue.' });
  }

  try {
    const result = await gradeSubmission({
      correctionFilePath: doc.filePath,
      submissionFilePath: req.file ? req.file.path : null,
      submissionMimeType: req.file ? req.file.mimetype : null,
      submissionText: req.file ? null : answerText,
    });

    const id = newId('sub');
    db.prepare(`
      INSERT INTO ai_submissions (id, studentId, documentId, answerText, answerFilePath, answerFileType, note, feedback, strengthsJson, weaknessesJson, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'graded')
    `).run(
      id, req.user.id, doc.id,
      req.file ? PLACEHOLDER_TEXT : answerText,
      req.file ? req.file.filename : null,
      req.file ? req.file.mimetype : null,
      result.note, result.feedback,
      JSON.stringify(result.strengths), JSON.stringify(result.weaknesses)
    );

    res.status(201).json({
      submission: {
        id, note: result.note, feedback: result.feedback,
        strengths: result.strengths, weaknesses: result.weaknesses,
        status: 'graded',
      },
    });
  } catch (e) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch (e2) {} }
    return sendGradingError(res, e);
  }
});

// GET /api/ai/history — historique des corrections IA de l'élève connecté.
// (Remarque : le chemin était auparavant "/history" tout court, en décalage
// avec le commentaire de montage dans app.js — corrigé en "/ai/history" pour
// que le chemin réel corresponde enfin à ce que le frontend appelle.)
router.get('/ai/history', requireAuth({ roles: ['STUDENT'] }), (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, d.title FROM ai_submissions s JOIN documents d ON d.id = s.documentId
    WHERE s.studentId = ? ORDER BY s.createdAt DESC
  `).all(req.user.id);
  res.json({
    submissions: rows.map((r) => ({
      ...r,
      hasFile: !!r.answerFilePath,
      strengths: r.strengthsJson ? JSON.parse(r.strengthsJson) : [],
      weaknesses: r.weaknessesJson ? JSON.parse(r.weaknessesJson) : [],
    })),
  });
});

// GET /api/ai/submissions/:id/file — ouvre la photo/PDF envoyé par l'élève.
// Accès réservé à l'élève qui l'a envoyé et au professeur propriétaire du
// document corrigé (pour qu'il puisse vérifier la correction de l'IA) —
// jamais public, ce n'est pas un document à vendre.
router.get('/ai/submissions/:id/file', requireAuth({ roles: ['STUDENT', 'PROFESSOR'] }), (req, res) => {
  const row = db.prepare(`
    SELECT s.*, d.professorId FROM ai_submissions s JOIN documents d ON d.id = s.documentId
    WHERE s.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
  if (!row.answerFilePath) return res.status(404).json({ error: 'NO_FILE', message: 'Cette copie a été envoyée sous forme de texte.' });

  const isOwnerStudent = req.user.id === row.studentId;
  const isOwnerProfessor = req.user.id === row.professorId;
  if (!isOwnerStudent && !isOwnerProfessor) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  const filePath = path.join(SUBMISSION_DIR, row.answerFilePath);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'NOT_FOUND' });

  res.setHeader('Content-Type', row.answerFileType || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(filePath).pipe(res);
});

// GET /api/ai/status — indique simplement si la correction IA est configurée
// (clé API présente), pour que le frontend puisse afficher un message clair
// plutôt qu'une erreur si l'admin n'a pas encore activé la fonctionnalité.
router.get('/ai/status', (req, res) => {
  res.json({ configured: apiKeyConfigured() });
});

module.exports = router;
