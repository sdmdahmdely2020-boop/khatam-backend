const crypto = require('crypto');

// Identifiants uniques courts, préfixés par type pour rester lisibles dans les logs.
function newId(prefix) {
  const raw = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  return prefix ? `${prefix}_${raw}` : raw;
}

module.exports = { newId };
