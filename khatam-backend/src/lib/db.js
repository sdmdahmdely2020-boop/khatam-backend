// Couche base de données — SQLite via better-sqlite3.
//
// Pourquoi SQLite et pas PostgreSQL directement ? Pour que ce backend tourne
// immédiatement sans serveur de base de données externe à installer. Le
// schéma (voir docs/data-model.prisma pour la version documentée) est simple
// et portable : passer à PostgreSQL en production consiste à remplacer ce
// fichier par un client "pg" ou à réintroduire un ORM (Prisma, Drizzle...)
// pointant vers le même schéma. Voir README.md, section "Passer en production".

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Accepte DATABASE_URL="file:./dev.db" (format Prisma-like, utilisé dans .env)
// ou DATABASE_FILE=/chemin/absolu.db. Par défaut : khatam.db à la racine du projet.
function resolveDbFile() {
  if (process.env.DATABASE_FILE) return process.env.DATABASE_FILE;
  if (process.env.DATABASE_URL) {
    const raw = process.env.DATABASE_URL.replace(/^file:/, '');
    return path.isAbsolute(raw) ? raw : path.join(__dirname, '..', '..', raw);
  }
  return path.join(__dirname, '..', '..', 'khatam.db');
}

const DB_FILE = resolveDbFile();
const db = new Database(DB_FILE);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id               TEXT PRIMARY KEY,
  role             TEXT NOT NULL CHECK(role IN ('STUDENT','PROFESSOR','ADMIN')),
  fullName         TEXT NOT NULL,
  phone            TEXT NOT NULL UNIQUE,
  email            TEXT UNIQUE,
  passwordHash     TEXT NOT NULL,
  serie            TEXT,
  bio              TEXT,
  matieres         TEXT,
  deviceId         TEXT,
  deviceBoundAt    TEXT,
  deviceLabel      TEXT,
  walletBalance    INTEGER NOT NULL DEFAULT 0,
  walletWithdrawn  INTEGER NOT NULL DEFAULT 0,
  boostActiveUntil TEXT,
  createdAt        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  matiere      TEXT NOT NULL,
  serie        TEXT NOT NULL DEFAULT 'C',
  annee        INTEGER NOT NULL,
  type         TEXT NOT NULL CHECK(type IN ('sujet','corrige','cours','exercices','video','blanc')),
  prix         INTEGER NOT NULL DEFAULT 0,
  free         INTEGER NOT NULL DEFAULT 0,
  adUnlock     INTEGER NOT NULL DEFAULT 0,
  aiGrading    INTEGER NOT NULL DEFAULT 0,
  filePath     TEXT NOT NULL,
  previewPath  TEXT,
  views        INTEGER NOT NULL DEFAULT 0,
  statut       TEXT NOT NULL DEFAULT 'publie',
  professorId  TEXT NOT NULL REFERENCES users(id),
  createdAt    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchases (
  id          TEXT PRIMARY KEY,
  userId      TEXT NOT NULL REFERENCES users(id),
  documentId  TEXT NOT NULL REFERENCES documents(id),
  amount      INTEGER NOT NULL,
  method      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  providerRef TEXT,
  createdAt   TEXT NOT NULL DEFAULT (datetime('now')),
  confirmedAt TEXT
);

CREATE TABLE IF NOT EXISTS ad_unlocks (
  id         TEXT PRIMARY KEY,
  userId     TEXT NOT NULL REFERENCES users(id),
  documentId TEXT NOT NULL REFERENCES documents(id),
  createdAt  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(userId, documentId)
);

CREATE TABLE IF NOT EXISTS favorites (
  id         TEXT PRIMARY KEY,
  userId     TEXT NOT NULL REFERENCES users(id),
  documentId TEXT NOT NULL REFERENCES documents(id),
  createdAt  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(userId, documentId)
);

CREATE TABLE IF NOT EXISTS likes (
  id          TEXT PRIMARY KEY,
  studentId   TEXT NOT NULL REFERENCES users(id),
  professorId TEXT NOT NULL REFERENCES users(id),
  createdAt   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(studentId, professorId)
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id          TEXT PRIMARY KEY,
  professorId TEXT NOT NULL REFERENCES users(id),
  amount      INTEGER NOT NULL,
  method      TEXT NOT NULL,
  accountRef  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  createdAt   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_submissions (
  id         TEXT PRIMARY KEY,
  studentId  TEXT NOT NULL REFERENCES users(id),
  documentId TEXT NOT NULL REFERENCES documents(id),
  answerText TEXT NOT NULL,
  note       REAL,
  feedback   TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',
  createdAt  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS platform_settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS ads (
  id             TEXT PRIMARY KEY,
  advertiserName TEXT NOT NULL,
  imagePath      TEXT,
  targetUrl      TEXT,
  placement      TEXT NOT NULL DEFAULT 'banner' CHECK(placement IN ('banner','ad-gate')),
  startDate      TEXT,
  endDate        TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  impressions    INTEGER NOT NULL DEFAULT 0,
  clicks         INTEGER NOT NULL DEFAULT 0,
  createdAt      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Codes de vérification par email (inscription). Toujours utilisée, que
-- l'envoi Gmail (voir lib/email.js) soit configuré ou non — contrairement à
-- Twilio Verify (SMS, abandonné : payant), l'envoi par email n'est qu'un
-- transport, il ne gère pas lui-même l'état des codes.
CREATE TABLE IF NOT EXISTS email_codes (
  id        TEXT PRIMARY KEY,
  email     TEXT NOT NULL,
  code      TEXT NOT NULL,
  attempts  INTEGER NOT NULL DEFAULT 0,
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_documents_filters ON documents(serie, matiere, annee, type);
CREATE INDEX IF NOT EXISTS idx_documents_prof ON documents(professorId);
CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(userId);
CREATE INDEX IF NOT EXISTS idx_likes_prof ON likes(professorId);
CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes(email);
`);

// Migration légère : ajoute les colonnes introduites après la création initiale
// du schéma. Nécessaire car la base réelle en production existe déjà (disque
// persistant Render) — "CREATE TABLE IF NOT EXISTS" ci-dessus ne touche pas
// une table existante. SQLite supporte ADD COLUMN directement.
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true; // colonne ajoutée à l'instant (première fois sur cette base)
  }
  return false;
}
ensureColumn('purchases', 'studentRef', 'TEXT');
ensureColumn('users', 'photoPath', 'TEXT');
ensureColumn('ai_submissions', 'answerFilePath', 'TEXT');
ensureColumn('ai_submissions', 'answerFileType', 'TEXT');
ensureColumn('ai_submissions', 'strengthsJson', 'TEXT');
ensureColumn('ai_submissions', 'weaknessesJson', 'TEXT');

// Vérification de l'email (gratuite, via un compte Gmail personnel — voir
// lib/email.js ; le SMS payant via Twilio a été abandonné à la demande de
// l'utilisateur) + dossier professeur (établissement, matière enseignée,
// années d'expérience) + statut d'approbation. Le téléphone reste un champ
// requis (contact, Bankily/Masrivi) mais n'est plus lui-même vérifié par code.
const emailVerifiedJustAdded = ensureColumn('users', 'emailVerified', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'etablissement', 'TEXT');
ensureColumn('users', 'experienceYears', 'INTEGER');
ensureColumn('users', 'professorStatus', 'TEXT');

if (emailVerifiedJustAdded) {
  // Migration unique, exécutée une seule fois (le jour où la colonne
  // "emailVerified" est ajoutée à une base existante) : tous les comptes
  // déjà créés avant l'introduction de cette vérification ont pu utiliser
  // l'application sans jamais avoir eu cette étape à faire — on les
  // considère de confiance plutôt que de les bloquer rétroactivement au
  // prochain login. Seuls les comptes créés APRÈS cette mise à jour devront
  // vérifier leur email et (pour les professeurs) être approuvés.
  db.exec(`UPDATE users SET emailVerified = 1`);
  db.exec(`UPDATE users SET professorStatus = 'approved' WHERE role = 'PROFESSOR'`);
}

module.exports = db;
