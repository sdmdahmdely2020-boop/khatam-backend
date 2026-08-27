// Formulaire de retour ("feedback") public — accessible aux visiteurs non
// connectés comme aux élèves/professeurs connectés. Toujours enregistré en
// base (voir lib/db.js, table feedback), et une notification WhatsApp est en
// plus tentée vers l'administrateur (voir lib/whatsapp.js) — mais un échec de
// cette notification n'empêche jamais l'enregistrement de réussir : le
// panneau admin (GET /api/admin/feedback, routes/admin.js) reste la source de
// vérité, WhatsApp n'est qu'un canal d'alerte en plus.

const express = require('express');
const db = require('../lib/db');
const { newId } = require('../lib/id');
const { authLimiter } = require('../middleware/rateLimit');
const { optionalAuth } = require('../middleware/auth');
const { sendWhatsAppNotification } = require('../lib/whatsapp');

const router = express.Router();

// POST /api/feedback  { name?, contact?, message }
// name/contact facultatifs : un visiteur non connecté peut rester anonyme
// (on utilise alors "Utilisateur anonyme" côté notification), un utilisateur
// connecté qui ne les remplit pas voit son nom/téléphone de compte utilisés
// à la place.
router.post('/', authLimiter, optionalAuth(), async (req, res) => {
  const { name, contact, message } = req.body || {};
  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Message requis.' });
  }
  const trimmedMessage = String(message).trim().slice(0, 2000);
  const trimmedName = name && String(name).trim() ? String(name).trim().slice(0, 120) : null;
  const trimmedContact = contact && String(contact).trim() ? String(contact).trim().slice(0, 120) : null;

  const id = newId('fb');
  db.prepare(`
    INSERT INTO feedback (id, userId, name, contact, message)
    VALUES (@id, @userId, @name, @contact, @message)
  `).run({
    id,
    userId: req.user ? req.user.id : null,
    name: trimmedName,
    contact: trimmedContact,
    message: trimmedMessage,
  });

  const who = trimmedName || (req.user ? req.user.fullName : 'Utilisateur anonyme');
  const contactInfo = trimmedContact || (req.user ? req.user.phone : 'non renseigné');
  const result = await sendWhatsAppNotification([who, contactInfo, trimmedMessage]);
  if (result.sent) {
    db.prepare('UPDATE feedback SET whatsappSent = 1 WHERE id = ?').run(id);
  }

  res.status(201).json({ message: 'Merci pour votre retour !' });
});

module.exports = router;
