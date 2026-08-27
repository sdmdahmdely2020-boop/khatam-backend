// Contenu public éditable sans redéploiement — FAQ et page "À propos".
// Stocké dans platform_settings (voir lib/settings.js) et modifiable par
// l'administrateur via PATCH /api/admin/content (routes/admin.js).

const express = require('express');
const { getSetting } = require('../lib/settings');

const router = express.Router();

// GET /api/content — { faq: [{question, reponse}], about: string }
router.get('/', (req, res) => {
  const faqRaw = getSetting('faq_json');
  let faq = [];
  try { faq = faqRaw ? JSON.parse(faqRaw) : []; } catch (e) { faq = []; }
  res.json({ faq, about: getSetting('about_text') || '' });
});

module.exports = router;
