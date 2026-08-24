const express = require('express');
const fs = require('fs');
const db = require('../lib/db');
const { newId } = require('../lib/id');
const { requireAuth } = require('../middleware/auth');
const { hasAccess } = require('../lib/access');
const { watermarkPdf } = require('../lib/watermark');

const router = express.Router();

// GET /api/documents/:id/view — visionneuse sécurisée.
// Ne renvoie JAMAIS le fichier original : uniquement un PDF filigrané à la
// volée avec l'identité du lecteur, servi en "inline" (pas de
// Content-Disposition: attachment) pour rester dans la visionneuse intégrée
// de l'application plutôt que dans le gestionnaire de téléchargements du
// téléphone.
router.get('/documents/:id/view', requireAuth({ roles: ['STUDENT', 'PROFESSOR'] }), async (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });

  if (!hasAccess(req.user.id, doc)) {
    return res.status(403).json({ error: 'LOCKED', message: 'Document non débloqué. Achetez-le ou regardez une publicité.' });
  }

  db.prepare('UPDATE documents SET views = views + 1 WHERE id = ?').run(doc.id);

  try {
    const sourceBytes = fs.readFileSync(doc.filePath);
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const label = `${req.user.fullName} · ${req.user.phone}`;
    const watermarked = await watermarkPdf(sourceBytes, { label, timestamp });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="document-securise.pdf"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(watermarked));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'WATERMARK_FAILED', message: "Impossible d'ouvrir ce document pour le moment." });
  }
});

// POST /api/documents/:id/ad-unlock — débloque gratuitement après visionnage d'une pub.
// body: { watchedMs } — validation minimale pour la démo ; en production,
// remplacer par une confirmation signée venant du SDK du fournisseur de pub
// (AdMob, Unity Ads...) qui atteste que la vidéo a été vue en entier.
router.post('/documents/:id/ad-unlock', requireAuth({ roles: ['STUDENT'] }), (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });
  if (!doc.adUnlock) return res.status(400).json({ error: 'NOT_AD_ELIGIBLE', message: "Ce document ne propose pas de déblocage par publicité." });

  const { watchedMs } = req.body || {};
  if (!watchedMs || watchedMs < 4000) {
    return res.status(400).json({ error: 'AD_NOT_COMPLETED', message: 'La publicité doit être visionnée en entier.' });
  }

  const existing = db.prepare('SELECT id FROM ad_unlocks WHERE userId = ? AND documentId = ?').get(req.user.id, doc.id);
  if (!existing) {
    db.prepare('INSERT INTO ad_unlocks (id, userId, documentId) VALUES (?, ?, ?)').run(newId('ad'), req.user.id, doc.id);
  }
  res.json({ unlocked: true });
});

// POST /api/documents/:id/favorite — bascule favori
router.post('/documents/:id/favorite', requireAuth({ roles: ['STUDENT'] }), (req, res) => {
  const doc = db.prepare('SELECT id FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });

  const existing = db.prepare('SELECT id FROM favorites WHERE userId = ? AND documentId = ?').get(req.user.id, doc.id);
  if (existing) {
    db.prepare('DELETE FROM favorites WHERE id = ?').run(existing.id);
    return res.json({ favorited: false });
  }
  db.prepare('INSERT INTO favorites (id, userId, documentId) VALUES (?, ?, ?)').run(newId('fav'), req.user.id, doc.id);
  res.json({ favorited: true });
});

// GET /api/favorites
router.get('/favorites', requireAuth({ roles: ['STUDENT'] }), (req, res) => {
  const rows = db.prepare(`
    SELECT d.* FROM favorites f JOIN documents d ON d.id = f.documentId
    WHERE f.userId = ? ORDER BY f.createdAt DESC
  `).all(req.user.id);
  res.json({ documents: rows });
});

module.exports = router;
