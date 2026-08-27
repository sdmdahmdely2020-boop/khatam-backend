// Test de bout en bout pour le bot WhatsApp automatique (routes/whatsapp.js,
// lib/whatsappBot.js) ajouté le 27/08 à la demande de sidi. Couvre : la
// vérification du webhook exigée par Meta, la réception d'un message texte
// (escaladé automatiquement puisque ANTHROPIC_API_KEY n'est volontairement
// pas configurée dans cet environnement de test, comme pour test-api.js),
// la détection par mot-clé sensible, les messages non-texte, et les routes
// admin de consultation/résolution des conversations.
// Usage : npm start (dans un terminal, avec WHATSAPP_WEBHOOK_VERIFY_TOKEN=testverifytoken)
//         puis node scripts/test-whatsapp-bot.js
const db = require('../src/lib/db');

const BASE = process.env.API_BASE || 'http://localhost:4000/api';
const ADMIN_KEY = process.env.ADMIN_KEY || 'testadminkey';
const VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'testverifytoken';

let failures = 0;
function check(label, cond, extra) {
  if (cond) { console.log(`OK   - ${label}`); }
  else { failures++; console.log(`FAIL - ${label}`, extra ?? ''); }
}

async function req(method, path, { body, admin, isText } = {}) {
  const headers = {};
  if (admin) headers['X-Admin-Key'] = ADMIN_KEY;
  let fetchBody;
  if (body) { headers['Content-Type'] = 'application/json'; fetchBody = JSON.stringify(body); }
  const r = await fetch(`${BASE}${path}`, { method, headers, body: fetchBody });
  const contentType = r.headers.get('content-type') || '';
  const data = isText ? await r.text() : (contentType.includes('application/json') ? await r.json() : await r.text());
  return { status: r.status, data };
}

function textMessagePayload(from, text) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'ENTRY_ID',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: 'PNID' },
          contacts: [{ profile: { name: 'Testeur' }, wa_id: from }],
          messages: [{ from, id: `wamid.${Date.now()}`, timestamp: `${Math.floor(Date.now() / 1000)}`, type: 'text', text: { body: text } }],
        },
        field: 'messages',
      }],
    }],
  };
}

function imageMessagePayload(from) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'ENTRY_ID',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          messages: [{ from, id: `wamid.${Date.now()}`, timestamp: `${Math.floor(Date.now() / 1000)}`, type: 'image', image: { id: 'IMG123' } }],
        },
        field: 'messages',
      }],
    }],
  };
}

function statusOnlyPayload() {
  // Accusé de livraison/lecture — ne doit rien journaliser, ne doit surtout
  // pas faire planter le webhook (pas de req.messages du tout).
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'ENTRY_ID', changes: [{ value: { statuses: [{ id: 'wamid.x', status: 'delivered' }] }, field: 'messages' }] }],
  };
}

// Laisse le temps au traitement asynchrone du webhook (POST répond 200
// immédiatement, avant même d'avoir écrit en base — voir routes/whatsapp.js)
// de se terminer avant d'interroger la base.
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function main() {
  console.log(`\n=== Tests bot WhatsApp — cible : ${BASE} ===\n`);

  // --- Vérification du webhook (GET) ---
  let r = await req('GET', `/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=CHALLENGE123`, { isText: true });
  check('GET webhook, bon token -> 200 + challenge renvoyé tel quel', r.status === 200 && r.data === 'CHALLENGE123', r.data);

  r = await req('GET', `/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=mauvais&hub.challenge=CHALLENGE123`, { isText: true });
  check('GET webhook, mauvais token -> 403', r.status === 403, r.data);

  // --- Message texte simple (escaladé : pas de clé Anthropic en test) ---
  const from1 = `222${Date.now()}`.slice(0, 12);
  r = await req('POST', '/whatsapp/webhook', { body: textMessagePayload(from1, 'Bonjour, combien coûte un corrigé ?') });
  check('POST webhook, message texte -> 200 immédiat', r.status === 200);
  await wait(300);
  let rows = db.prepare('SELECT * FROM whatsapp_messages WHERE fromNumber = ? ORDER BY createdAt ASC').all(from1);
  check('message entrant journalisé en base', rows.length === 1 && rows[0].direction === 'in' && rows[0].body.includes('coûte'), rows);
  check('escaladé car ANTHROPIC_API_KEY non configurée en test', rows.length === 1 && rows[0].escalated === 1, rows);

  // --- Mot-clé sensible -> escalade même sans appel IA ---
  const from2 = `223${Date.now()}`.slice(0, 12);
  r = await req('POST', '/whatsapp/webhook', { body: textMessagePayload(from2, "Je n'ai pas reçu mon remboursement, c'est une arnaque !") });
  await wait(300);
  rows = db.prepare('SELECT * FROM whatsapp_messages WHERE fromNumber = ?').all(from2);
  check('mot-clé sensible -> message escaladé', rows.length === 1 && rows[0].escalated === 1, rows);

  // --- Message non-texte (image) -> journalisé et escaladé d'office ---
  const from3 = `224${Date.now()}`.slice(0, 12);
  r = await req('POST', '/whatsapp/webhook', { body: imageMessagePayload(from3) });
  await wait(300);
  rows = db.prepare('SELECT * FROM whatsapp_messages WHERE fromNumber = ?').all(from3);
  check('message image -> journalisé, escaladé, direction in', rows.length === 1 && rows[0].escalated === 1 && rows[0].direction === 'in', rows);

  // --- Payload de statut seul (accusé de livraison) -> aucune erreur, rien journalisé ---
  const beforeCount = db.prepare('SELECT COUNT(*) AS n FROM whatsapp_messages').get().n;
  r = await req('POST', '/whatsapp/webhook', { body: statusOnlyPayload() });
  check('POST webhook, accusé de statut seul -> 200 (pas d\'erreur)', r.status === 200);
  await wait(200);
  const afterCount = db.prepare('SELECT COUNT(*) AS n FROM whatsapp_messages').get().n;
  check('accusé de statut seul -> rien de nouveau journalisé', afterCount === beforeCount, { beforeCount, afterCount });

  // --- Routes admin : liste des conversations ---
  r = await req('GET', '/admin/whatsapp/conversations', { admin: true });
  check('GET /admin/whatsapp/conversations -> 200 + tableau', r.status === 200 && Array.isArray(r.data.conversations), r.data);
  const conv1 = r.data.conversations.find((c) => c.fromNumber === from1);
  check('conversation from1 présente avec escalatedCount = 1', !!conv1 && conv1.escalatedCount === 1, conv1);

  r = await req('GET', '/admin/whatsapp/conversations', {});
  check('GET /admin/whatsapp/conversations sans clé admin -> 401', r.status === 401, r.data);

  // --- Routes admin : fil de messages ---
  r = await req('GET', `/admin/whatsapp/conversations/${from1}/messages`, { admin: true });
  check('GET fil de conversation -> 1 message', r.status === 200 && r.data.messages.length === 1, r.data);

  // --- Compteur non lus avant résolution ---
  r = await req('GET', '/admin/whatsapp/unread-count', { admin: true });
  const countBefore = r.data.count;
  check('unread-count >= 3 numéros en attente (from1, from2, from3)', countBefore >= 3, r.data);

  // --- Résolution d'une conversation ---
  r = await req('POST', `/admin/whatsapp/conversations/${from1}/resolve`, { admin: true, body: {} });
  check('POST resolve -> 200', r.status === 200 && r.data.ok === true, r.data);
  rows = db.prepare('SELECT * FROM whatsapp_messages WHERE fromNumber = ?').all(from1);
  check('après résolution, escalated = 0 pour from1', rows.every((m) => m.escalated === 0), rows);

  r = await req('GET', '/admin/whatsapp/unread-count', { admin: true });
  check('unread-count a diminué d\'exactement 1 après résolution', r.data.count === countBefore - 1, { before: countBefore, after: r.data.count });

  console.log(`\n=== Résultat : ${failures === 0 ? 'TOUT PASSE ✅' : `${failures} échec(s) ❌`} ===\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('Erreur fatale des tests :', e); process.exit(1); });
