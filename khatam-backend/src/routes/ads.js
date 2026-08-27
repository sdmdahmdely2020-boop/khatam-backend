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

// GET /api/ads/list?placement=banner&zone=catalog|dashboard
// Renvoie TOUTES les annonces actives (pas une seule au hasard) pour cette
// combinaison placement/zone, afin que le frontend en fasse un vrai carrousel
// qui change automatiquement toutes les quelques secondes (demande de sidi,
// 27/08 : "des ads qui sont déplacé change au cours du temps") — sans zone,
// suppose 'catalog' (comportement historique du bandeau public). ad-gate
// n'utilise pas de zone (un seul emplacement, pendant le déblocage par pub).
router.get('/list', (req, res) => {
  const { placement } = req.query;
  const zone = req.query.zone || 'catalog';
  if (!placement || !['banner', 'ad-gate'].includes(placement)) {
    return res.status(400).json({ error: 'INVALID_PLACEMENT' });
  }
  if (!['catalog', 'dashboard'].includes(zone)) {
    return res.status(400).json({ error: 'INVALID_ZONE' });
  }
  const now = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT * FROM ads
    WHERE placement = ? AND active = 1 AND zone = ?
      AND (startDate IS NULL OR startDate <= ?)
      AND (endDate IS NULL OR endDate >= ?)
    ORDER BY createdAt ASC
  `).all(placement, zone, now, now);

  res.json({
    ads: rows.map((ad) => ({
      id: ad.id,
      advertiserName: ad.advertiserName,
      imageUrl: ad.imagePath ? `/uploads/ads/${ad.imagePath}` : null,
      targetUrl: ad.targetUrl,
      placement: ad.placement,
      zone: ad.zone,
    })),
  });
});

// GET /api/ads/active?placement=banner|ad-gate
// Renvoie UNE annonce active au hasard (route historique, conservée pour
// compatibilité — voir /list ci-dessus pour un vrai carrousel de plusieurs
// annonces). Suppose zone='catalog'.
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
