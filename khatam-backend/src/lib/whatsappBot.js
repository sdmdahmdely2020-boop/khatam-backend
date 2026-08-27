// Bot WhatsApp automatique — répond aux élèves/professeurs qui écrivent sur
// le numéro WhatsApp Business de Khatam (demande de sidi, 27/08 : "je veux
// ca" en réponse à la proposition d'un vrai bot branché sur l'API WhatsApp
// Business Cloud, après avoir précisé qu'il vient d'ouvrir un WhatsApp
// Business avec son numéro).
//
// Fonctionnement : reçoit le texte d'un message entrant (routes/whatsapp.js),
// construit un contexte à partir des réglages déjà stockés en base (FAQ, à
// propos, numéros de paiement — voir lib/settings.js), puis appelle l'API
// Claude (même schéma d'appel direct par fetch() que lib/aiGrading.js) pour
// générer une réponse courte en français.
//
// Sécurité : les sujets délicats (paiement contesté, remboursement, plainte,
// problème de compte...) ne sont JAMAIS répondus automatiquement — deux
// filets successifs : une liste de mots-clés vérifiée AVANT même d'appeler
// l'IA, puis une instruction donnée à l'IA elle-même (champ "needsHuman").
// Dans les deux cas, le message est simplement marqué "escaladé" (voir
// routes/whatsapp.js) pour que sidi réponde lui-même, en direct, depuis son
// téléphone — le bot ne renvoie alors AUCUNE réponse automatique.
//
// Comme aiGrading.js, ce module ne bloque jamais l'appelant si
// ANTHROPIC_API_KEY n'est pas configurée : generateReply() renvoie alors
// simplement needsHuman:true (mode de secours = tout est escaladé à sidi),
// au lieu d'échouer ou de faire planter le webhook.

const { getSetting } = require('./settings');

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.WHATSAPP_BOT_MODEL || process.env.AI_GRADING_MODEL || 'claude-haiku-4-5';

function isBotConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

// Mots-clés qui déclenchent toujours une escalade humaine, indépendamment de
// ce que l'IA aurait décidé — filet de sécurité supplémentaire pour ne
// jamais laisser le bot gérer seul un désaccord d'argent ou une plainte,
// même si l'IA se trompait sur needsHuman.
const ESCALATION_KEYWORDS = [
  'rembours', 'litige', 'plainte', 'arnaque', 'fraude', 'escroqu',
  'pas reçu', "n'ai pas reçu", 'avocat', 'police', 'urgent',
  'problème de paiement', 'probleme de paiement', 'argent perdu',
  'compte bloqué', 'compte bloque', 'compte suspendu',
];

function containsEscalationKeyword(text) {
  const t = String(text || '').toLowerCase();
  return ESCALATION_KEYWORDS.some((k) => t.includes(k));
}

// Construit le contexte factuel donné à l'IA — uniquement des données déjà
// stockées en base (jamais inventées), pour que le bot ne puisse pas
// "halluciner" un prix ou une procédure qui n'existe pas.
function buildContext() {
  let faq = [];
  try { faq = JSON.parse(getSetting('faq_json') || '[]'); } catch (e) { faq = []; }
  const about = getSetting('about_text') || '';
  const bankily = getSetting('payTo_bankily') || '';
  const masrivi = getSetting('payTo_masrivi') || '';
  const sedad = getSetting('payTo_sedad') || '';

  const faqText = faq.length
    ? faq.map((f) => `Q: ${f.question}\nR: ${f.reponse || ''}`).join('\n\n')
    : '(aucune FAQ renseignée pour le moment sur la plateforme)';

  return `À propos de Khatam : ${about || '(texte "à propos" pas encore renseigné par l\'administrateur)'}

FAQ :
${faqText}

Numéros de paiement à communiquer si demandé (Mauritanie) :
Bankily : ${bankily || 'non renseigné pour le moment'}
Masrivi : ${masrivi || 'non renseigné pour le moment'}
Sedad : ${sedad || 'non renseigné pour le moment'}`;
}

function buildSystemPrompt(context) {
  return `Tu es l'assistant WhatsApp automatique de Khatam, une plateforme mauritanienne qui vend des sujets et corrigés du Baccalauréat aux élèves, et permet aux professeurs de vendre leurs propres documents.

Règles strictes :
- Réponds UNIQUEMENT en français, en 2 à 4 phrases maximum, sur un ton clair et chaleureux adapté à WhatsApp.
- Base-toi UNIQUEMENT sur les informations fournies ci-dessous. Si l'information demandée n'y figure pas, dis-le simplement et propose que sidi (le fondateur) réponde directement — n'invente jamais un prix, un délai ou une procédure.
- Réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte avant ou après, exactement sous cette forme :
{"reply": "<ta réponse>", "needsHuman": <true ou false>}
- Mets "needsHuman" à true (et laisse "reply" vide) si la question porte sur un paiement contesté, un remboursement, une plainte, un problème de compte, ou toute situation où une vraie personne doit intervenir plutôt que le bot.

Informations disponibles sur la plateforme :
${context}`;
}

async function callClaude(userMessage) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      system: buildSystemPrompt(buildContext()),
      messages: [{ role: 'user', content: String(userMessage).slice(0, 2000) }],
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    const err = new Error(`Appel à l'API Claude échoué (${res.status}) : ${bodyText.slice(0, 300)}`);
    err.code = 'AI_CALL_FAILED';
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) {
    const err = new Error("Réponse inattendue de l'IA (aucun texte renvoyé).");
    err.code = 'AI_BAD_RESPONSE';
    throw err;
  }

  let parsed;
  try {
    const match = textBlock.text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : textBlock.text);
  } catch (e) {
    const err = new Error("Impossible d'interpréter la réponse de l'IA.");
    err.code = 'AI_BAD_RESPONSE';
    throw err;
  }

  return {
    reply: String(parsed.reply || '').slice(0, 1500),
    needsHuman: !!parsed.needsHuman,
  };
}

// generateReply(userMessage) -> { reply: string|null, needsHuman: boolean, reason?: string }
// Ne lève JAMAIS d'exception : en cas de souci (clé absente, appel API en
// échec, réponse imprévisible, mot-clé sensible détecté), renvoie
// needsHuman:true avec reply:null — routes/whatsapp.js escalade alors
// systématiquement plutôt que de risquer une réponse incorrecte ou de faire
// planter le webhook (Meta réessaierait sinon d'envoyer le même événement en
// boucle pendant plusieurs heures).
async function generateReply(userMessage) {
  if (containsEscalationKeyword(userMessage)) {
    return { reply: null, needsHuman: true, reason: 'KEYWORD' };
  }
  if (!isBotConfigured()) {
    return { reply: null, needsHuman: true, reason: 'NOT_CONFIGURED' };
  }
  try {
    const result = await callClaude(userMessage);
    if (result.needsHuman || !result.reply) {
      return { reply: null, needsHuman: true, reason: 'AI_DECIDED' };
    }
    return { reply: result.reply, needsHuman: false };
  } catch (e) {
    console.error('WhatsApp bot — génération de réponse échouée :', e && e.message);
    return { reply: null, needsHuman: true, reason: 'AI_ERROR' };
  }
}

module.exports = { generateReply, isBotConfigured, containsEscalationKeyword };
