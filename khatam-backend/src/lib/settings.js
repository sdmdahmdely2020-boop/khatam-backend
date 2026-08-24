// Réglages globaux de la plateforme — pour l'instant uniquement les numéros
// Bankily / Masrivi / Sedad sur lesquels les élèves doivent envoyer l'argent.
// Stockés en base (table platform_settings, clé/valeur) pour rester modifiables
// sans redéploiement, via le panneau d'administration (voir routes/admin.js).

const db = require('./db');

const PAYMENT_KEYS = {
  bankily: 'payTo_bankily',
  masrivi: 'payTo_masrivi',
  sedad: 'payTo_sedad',
};

function getSetting(key) {
  const row = db.prepare('SELECT value FROM platform_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO platform_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function getPaymentNumbers() {
  return {
    bankily: getSetting(PAYMENT_KEYS.bankily),
    masrivi: getSetting(PAYMENT_KEYS.masrivi),
    sedad: getSetting(PAYMENT_KEYS.sedad),
  };
}

function setPaymentNumber(method, value) {
  const key = PAYMENT_KEYS[method];
  if (!key) throw Object.assign(new Error('Méthode inconnue'), { status: 400 });
  setSetting(key, value || null);
}

module.exports = { getSetting, setSetting, getPaymentNumbers, setPaymentNumber, PAYMENT_KEYS };
