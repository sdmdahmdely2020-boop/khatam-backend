// Notifications WhatsApp automatiques — envoi via l'API officielle Meta
// WhatsApp Cloud API (PAS Twilio, PAS une lib tierce non officielle : demande
// explicite de sidi le 27/08 d'un envoi "automatique direct" vers son propre
// WhatsApp, après avoir été prévenu que l'automatisation complète (sans clic
// de sa part) nécessite une vraie intégration API — pas juste un lien
// wa.me/... que lui seul peut cliquer).
//
// Pourquoi la Cloud API de Meta plutôt qu'un service tiers (Twilio, etc.) :
// c'est l'API officielle et gratuite pour ce cas d'usage précis (un seul
// destinataire, son propre numéro). Elle NE NÉCESSITE PAS la lourde
// "vérification d'entreprise" (Meta Business Verification) tant que le
// numéro qui reçoit les messages reste un "numéro de test" ajouté et
// vérifié à la main dans le compte développeur Meta (jusqu'à 5 numéros
// autorisés gratuitement) — c'est exactement ce cas : sidi reçoit sur SON
// propre téléphone.
//
// Mise en place à faire par sidi lui-même (impossible de le faire à sa place,
// ça nécessite son identité Meta) :
//   1. Créer un compte développeur sur developers.facebook.com (gratuit).
//   2. Créer une "App" de type "Business", y ajouter le produit "WhatsApp".
//      Meta crée automatiquement un compte WhatsApp Business de test + un
//      numéro d'expéditeur de test (gratuit, pas besoin d'un vrai numéro).
//   3. Dans la configuration WhatsApp de l'app, section "Numéros de
//      destinataires de test" : ajouter le numéro WhatsApp personnel de sidi
//      et le vérifier (code reçu par WhatsApp).
//   4. Créer un modèle de message ("Message Template") dans Meta Business
//      Suite, par ex. nommé "khatam_notification", catégorie "Utility",
//      avec un corps du style : "Nouveau message sur Khatam.\n\nDe : {{1}}\n
//      Contact : {{2}}\nMessage : {{3}}" — la validation Meta prend
//      généralement de quelques minutes à quelques heures (PAS plusieurs
//      jours comme la vérification d'entreprise complète).
//   5. Récupérer sur le tableau de bord de l'app : le "Temporary access
//      token" (ou, mieux, un jeton permanent via Business Suite > Utilisateurs
//      système, pour ne pas avoir à le renouveler toutes les 24h) et le
//      "Phone number ID" (identifiant du numéro d'expéditeur de test).
//   6. Transmettre à Claude : WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
//      WHATSAPP_RECIPIENT_NUMBER (le numéro de sidi, format international
//      sans "+", ex. 22200000000), et le nom exact du modèle créé à l'étape 4
//      (WHATSAPP_TEMPLATE_NAME) — Claude les configure ensuite sur Render.
//
// Tant que ces variables ne sont pas configurées, ce module ne bloque JAMAIS
// la fonctionnalité qui l'utilise (voir routes/feedback.js) : il journalise
// seulement côté serveur et renvoie sent:false — même principe de repli que
// lib/email.js (mode de secours) et lib/receiptUpload.js.

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_RECIPIENT_NUMBER = process.env.WHATSAPP_RECIPIENT_NUMBER;
const WHATSAPP_TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_NAME || 'hello_world';
const WHATSAPP_TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || 'en_US';
const GRAPH_API_VERSION = 'v21.0';

function whatsappConfigured() {
  return !!(WHATSAPP_TOKEN && WHATSAPP_PHONE_NUMBER_ID && WHATSAPP_RECIPIENT_NUMBER);
}

/**
 * Envoie une notification WhatsApp au numéro de l'administrateur
 * (WHATSAPP_RECIPIENT_NUMBER), via le modèle configuré. `params` est un
 * tableau de chaînes qui remplissent les variables {{1}}, {{2}}, ... du
 * modèle, dans l'ordre. Ne lève JAMAIS d'exception : renvoie toujours un
 * objet { sent: boolean, reason?: string } que l'appelant peut journaliser,
 * sans jamais faire échouer la requête HTTP d'origine à cause d'un souci
 * WhatsApp (voir routes/feedback.js — le feedback est enregistré même si
 * cette notification échoue).
 */
async function sendWhatsAppNotification(params = []) {
  if (!whatsappConfigured()) {
    console.log('[WhatsApp non configuré — mode de secours] Notification non envoyée :', params.join(' | '));
    return { sent: false, reason: 'NOT_CONFIGURED' };
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: WHATSAPP_RECIPIENT_NUMBER,
          type: 'template',
          template: {
            name: WHATSAPP_TEMPLATE_NAME,
            language: { code: WHATSAPP_TEMPLATE_LANG },
            ...(params.length
              ? { components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p) })) }] }
              : {}),
          },
        }),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('WhatsApp Cloud API — erreur :', JSON.stringify(data));
      return { sent: false, reason: 'API_ERROR', detail: data };
    }
    return { sent: true };
  } catch (e) {
    console.error('WhatsApp Cloud API — exception :', e && e.message);
    return { sent: false, reason: 'NETWORK_ERROR' };
  }
}

/**
 * Envoie un message texte libre (pas un modèle) à un numéro quelconque —
 * utilisé par le bot WhatsApp (voir lib/whatsappBot.js et
 * routes/whatsapp.js) pour répondre à un élève/professeur qui vient
 * d'écrire. Contrairement à sendWhatsAppNotification (qui envoie toujours
 * un modèle pré-approuvé au SEUL numéro de sidi), l'API Meta autorise le
 * texte libre vers N'IMPORTE QUEL numéro tant qu'on répond dans les 24h
 * suivant son dernier message ("fenêtre de service client") — ce qui est
 * toujours le cas ici puisqu'on répond directement à un message reçu par
 * webhook. Même principe de repli que sendWhatsAppNotification : ne lève
 * jamais d'exception, journalise et renvoie { sent: false } si le token/
 * l'ID du numéro d'expéditeur ne sont pas configurés.
 */
async function sendWhatsAppFreeform(to, text) {
  if (!(WHATSAPP_TOKEN && WHATSAPP_PHONE_NUMBER_ID)) {
    console.log('[WhatsApp non configuré — mode de secours] Réponse du bot non envoyée à', to, ':', text);
    return { sent: false, reason: 'NOT_CONFIGURED' };
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: String(to),
          type: 'text',
          text: { body: String(text).slice(0, 4096) },
        }),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('WhatsApp Cloud API (texte libre) — erreur :', JSON.stringify(data));
      return { sent: false, reason: 'API_ERROR', detail: data };
    }
    return { sent: true };
  } catch (e) {
    console.error('WhatsApp Cloud API (texte libre) — exception :', e && e.message);
    return { sent: false, reason: 'NETWORK_ERROR' };
  }
}

module.exports = { whatsappConfigured, sendWhatsAppNotification, sendWhatsAppFreeform };
