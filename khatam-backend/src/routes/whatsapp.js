// Webhook WhatsApp Business Cloud API — reçoit les messages entrants
// (élèves/professeurs qui écrivent sur le numéro WhatsApp Business de sidi)
// et fait répondre le bot automatiquement (voir lib/whatsappBot.js), sauf
// pour les sujets délicats qui sont escaladés à sidi (aucune réponse auto
// envoyée ; le message reste visible dans admin.html pour qu'il réponde
// lui-même, en direct, depuis son téléphone).
//
// Deux routes exigées par Meta sur la même URL :
//   GET  /api/whatsapp/webhook — vérification lors de la configuration du
//        webhook dans le tableau de bord développeur Meta (doit renvoyer
//        EXACTEMENT hub.challenge, en texte brut, si hub.verify_token
//        correspond à WHATSAPP_WEBHOOK_VERIFY_TOKEN).
//   POST /api/whatsapp/webhook — reçoit chaque événement. Répond 200
//        immédiatement (avant même le traitement) car Meta considère un
//        webhook lent/en échec comme une livraison ratée et réessaie
//        d'envoyer le même événement en boucle pendant plusieurs heures.

const express = require('express');
const db = require('../lib/db');
const { newId } = require('../lib/id');
const { sendWhatsAppFreeform } = require('../lib/whatsapp');
const { generateReply } = require('../lib/whatsappBot');

const router = express.Router();

const VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

// GET /api/whatsapp/webhook — vérification Meta.
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

function insertMessage({ fromNumber, direction, body, escalated = 0, autoReplied = 0 }) {
  const id = newId('wam');
  db.prepare(`
    INSERT INTO whatsapp_messages (id, fromNumber, direction, body, escalated, autoReplied)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, fromNumber, direction, String(body || '').slice(0, 4000), escalated ? 1 : 0, autoReplied ? 1 : 0);
  return id;
}

// Traite un événement webhook déjà accusé réception (voir POST ci-dessous).
// Séparé en fonction nommée pour pouvoir être appelé directement par les
// tests locaux (scripts/test-whatsapp-bot.js) sans passer par une vraie
// requête HTTP express.
async function processWebhookPayload(body) {
  const entries = (body && body.entry) || [];
  for (const entry of entries) {
    const changes = entry.changes || [];
    for (const change of changes) {
      const value = change.value || {};
      const messages = value.messages || [];
      for (const msg of messages) {
        if (msg.type !== 'text' || !msg.text || !msg.text.body) {
          // Types non gérés par le bot (image, audio, document, accusé de
          // statut...) — journalisé quand même, escaladé d'office, pour que
          // sidi le voie dans admin.html et réponde à la main si besoin.
          insertMessage({
            fromNumber: msg.from || 'inconnu',
            direction: 'in',
            body: `[message de type "${msg.type}", non traité automatiquement par le bot]`,
            escalated: 1,
          });
          continue;
        }

        const from = msg.from; // numéro au format international, sans "+"
        const text = msg.text.body;
        const inId = insertMessage({ fromNumber: from, direction: 'in', body: text });

        const { reply, needsHuman } = await generateReply(text);

        if (needsHuman || !reply) {
          db.prepare('UPDATE whatsapp_messages SET escalated = 1 WHERE id = ?').run(inId);
          continue;
        }

        const sendResult = await sendWhatsAppFreeform(from, reply);
        insertMessage({ fromNumber: from, direction: 'out', body: reply, autoReplied: 1 });
        if (!sendResult.sent) {
          console.error("WhatsApp bot — échec de l'envoi de la réponse automatique à", from, sendResult.reason);
        }
      }
    }
  }
}

// POST /api/whatsapp/webhook — réception des événements.
router.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    await processWebhookPayload(req.body);
  } catch (e) {
    console.error('Webhook WhatsApp — erreur de traitement :', e && e.message);
  }
});

module.exports = router;
module.exports.processWebhookPayload = processWebhookPayload;
