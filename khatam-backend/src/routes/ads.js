// Annonces publicitaires — routes publiques (lecture + suivi). La gestion
// (créer/modifier/supprimer une annonce) est réservée à l'administrateur,
// voir routes/admin.js. Deux emplacements possibles : "banner" (bandeau sur
// le catalogue) et "ad-gate" (affichée pendant le déblocage gratuit par pub).
//
// Ces annonces sont des annonceurs locaux (mauritaniens) démarchés et gérés
// directement par la plateforme, payés hors-ligne (Bankily/Masrivi/Sedad,
// comme le reste). Pour la publicité étrangère (Google AdSense), voir la
// note dans docs/ADS.md — ça nécessite un compte AdSense personnel, distinct
// de ce système, et s'ajoute simplement à côté dans les mêmes emplacements.

const express = require('express');
const db = require('../lib/db');

const router = express.Router();

// GET /api/ads/active?placement=banner|ad-gate
// Renvoie les annonces actives (active=1, dans leur fenêtre de dates si définie),
// une au hasard si plusieurs existent pour le même emplacement (rotation simple).
router.get('/active', (req, res) => {
  const { placement } = req.query;
  if (!placement || !['banner', 'ad-gate'].includes(placement)) {
    return res.status(400).json({ error: 'INVALID_PLACEMENT' });
  }
  const now = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT * FROM ads
    WHERE placement = ? AND active = 1
      AND (startDate IS NULL OR startDate <= ?)
      AND (endDate IS NULL OR endDate >= ?)
  `).all(placement, now, now);

  if (!rows.length) return res.json({ ad: null });
  const chosen = rows[Math.floor(Math.random() * rows.length)];
  res.json({
    ad: {
      id: chosen.id,
      advertiserName: chosen.advertiserName,
      imageUrl: chosen.imagePath ? `/uploads/ads/${chosen.imagePath}` : null,
      targetUrl: chosen.targetUrl,
      placement: chosen.placement,
    },
  });
});

// POST /api/ads/:id/impression — appelé côté client quand l'annonce est affichée.
router.post('/:id/impression', (req, res) => {
  const result = db.prepare('UPDATE ads SET impressions = impressions + 1 WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ ok: true });
});

// POST /api/ads/:id/click — appelé côté client quand l'élève clique sur l'annonce.
router.post('/:id/click', (req, res) => {
  const result = db.prepare('UPDATE ads SET clicks = clicks + 1 WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ ok: true });
});

module.exports = router;
