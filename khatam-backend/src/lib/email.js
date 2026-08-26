// Vérification de l'adresse email — envoyée depuis un compte Gmail
// personnel, via SMTP (nodemailer), à la demande explicite de
// l'utilisateur (« prend mon mail pas brevo »).
//
// Choisie à l'origine à la place d'un SMS payant (Twilio) — vérifié en août
// 2026, un SMS de vérification coûte environ 0,40 USD par inscription
// (Twilio), inenvisageable au volume visé. Un premier essai est passé par
// Brevo (API HTTP dédiée), mais l'utilisateur a préféré utiliser directement
// son propre compte Gmail plutôt qu'un service tiers.
//
// Gmail n'expose pas d'API HTTP simple pour un compte personnel sans passer
// par OAuth (complexe à mettre en place manuellement) — la méthode standard
// et supportée est SMTP avec un « mot de passe d'application » (App
// Password), généré depuis le compte Google une fois la validation en 2
// étapes activée. C'est pourquoi ce module utilise `nodemailer` (SMTP)
// plutôt que du `fetch` brut comme les autres intégrations du projet
// (Brevo, Bankily/Masrivi/Sedad).
//
// Le code à 6 chiffres est TOUJOURS généré et vérifié localement (table
// email_codes, voir lib/db.js), que Gmail soit configuré ou non. Seul
// l'envoi réel de l'email dépend de la configuration.
//
// Tant que GMAIL_USER / GMAIL_APP_PASSWORD ne sont pas configurées, ce
// module utilise un mode de secours LOCAL (le code est généré et stocké
// comme d'habitude, mais seulement journalisé dans les logs serveur, jamais
// réellement envoyé) — pour que tout le flux (inscription -> vérification ->
// connexion) reste testable de bout en bout sans compte Gmail configuré. Ce
// mode n'est PAS utilisable pour de vrais utilisateurs : ils ne recevront
// jamais leur code.
//
// Pour activer les vrais envois :
//   1. Sur le compte Gmail à utiliser, activer la validation en 2 étapes
//      (myaccount.google.com/security).
//   2. Créer un « mot de passe d'application » : myaccount.google.com/apppasswords
//      (choisir « Autre », nommer par ex. « Khatam »), copier le mot de
//      passe à 16 caractères généré (sans espaces).
//   3. Sur Render, renseigner GMAIL_USER (l'adresse Gmail complète) et
//      GMAIL_APP_PASSWORD (le mot de passe d'application généré — PAS le
//      mot de passe habituel du compte Google, qui ne fonctionnera pas).
//      EMAIL_FROM_NAME (optionnel) contrôle le nom affiché comme expéditeur.
//
// Limite connue : un compte Gmail personnel est plafonné à environ 500
// emails envoyés par jour (2000 pour un compte Google Workspace payant) —
// largement suffisant pour démarrer, mais à surveiller si le volume
// d'inscriptions augmente fortement.

const nodemailer = require('nodemailer');
const db = require('./db');
const { newId } = require('./id');

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || 'Khatam';

function emailConfigured() {
  return !!(GMAIL_USER && GMAIL_APP_PASSWORD);
}

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
  }
  return transporter;
}

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;

/**
 * Génère un code, le stocke localement, et l'envoie réellement par email via
 * Gmail (SMTP) si configuré (sinon le journalise seulement — voir en-tête).
 */
async function sendVerificationEmail(email) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const id = newId('emc');
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
  db.prepare('DELETE FROM email_codes WHERE email = ?').run(email);
  db.prepare('INSERT INTO email_codes (id, email, code, expiresAt) VALUES (?, ?, ?, ?)').run(id, email, code, expiresAt);

  if (!emailConfigured()) {
    console.log(`[Email non configuré — mode de secours] Code de vérification pour ${email} : ${code} (valable 10 min)`);
    return { mode: 'fallback' };
  }

  try {
    await getTransporter().sendMail({
      from: `"${EMAIL_FROM_NAME}" <${GMAIL_USER}>`,
      to: email,
      subject: 'Votre code de vérification Khatam',
      html: `
        <div style="font-family:sans-serif;font-size:15px;color:#1E2A26;">
          <p>Voici votre code de vérification Khatam :</p>
          <p style="font-size:28px;font-weight:700;letter-spacing:4px;">${code}</p>
          <p style="color:#5B655B;font-size:13px;">Ce code est valable 10 minutes. Si vous n'avez pas demandé ce code, ignorez cet email.</p>
        </div>`,
    });
  } catch (e) {
    console.error('Gmail SMTP erreur:', e && e.message);
    const err = new Error("Impossible d'envoyer l'email de vérification pour le moment. Réessayez dans un instant.");
    err.code = 'EMAIL_SEND_FAILED';
    err.status = 502;
    throw err;
  }
  return { mode: 'email' };
}

/**
 * Vérifie un code saisi par l'utilisateur. Renvoie true/false. Toujours
 * local (voir en-tête) — indépendant de la configuration Gmail.
 */
function checkVerificationCode(email, code) {
  const row = db.prepare('SELECT * FROM email_codes WHERE email = ?').get(email);
  if (!row) return false;
  if (new Date(row.expiresAt) < new Date()) {
    db.prepare('DELETE FROM email_codes WHERE email = ?').run(email);
    return false;
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    db.prepare('DELETE FROM email_codes WHERE email = ?').run(email);
    return false;
  }
  db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
  if (String(code || '') !== row.code) return false;
  db.prepare('DELETE FROM email_codes WHERE email = ?').run(email);
  return true;
}

module.exports = { emailConfigured, sendVerificationEmail, checkVerificationCode };
