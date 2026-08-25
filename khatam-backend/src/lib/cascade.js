// Suppressions en cascade — nécessaires car SQLite (foreign_keys = ON, voir db.js)
// rejette la suppression d'une ligne encore référencée ailleurs (achat, favori,
// correction IA, etc.). Ces fonctions suppriment d'abord tout ce qui dépend de
// l'utilisateur/document, puis la ligne elle-même, dans une transaction.
//
// Utilisé par : routes/admin.js (panneau d'administration) et routes/documents.js
// (un professeur qui supprime son propre document déjà acheté/mis en favori).

const fs = require('fs');
const db = require('./db');

function deleteDocumentCascade(documentId) {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);
  if (!doc) return null;

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM purchases WHERE documentId = ?').run(documentId);
    db.prepare('DELETE FROM ad_unlocks WHERE documentId = ?').run(documentId);
    db.prepare('DELETE FROM favorites WHERE documentId = ?').run(documentId);
    db.prepare('DELETE FROM ai_submissions WHERE documentId = ?').run(documentId);
    db.prepare('DELETE FROM documents WHERE id = ?').run(documentId);
  });
  tx();

  if (doc.filePath) { try { fs.unlinkSync(doc.filePath); } catch (e) {} }
  if (doc.previewPath) { try { fs.unlinkSync(doc.previewPath); } catch (e) {} }
  return doc;
}

function deleteUserCascade(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return null;

  // Si c'est un professeur : supprime d'abord chacun de ses documents (et tout ce
  // qui en dépend — achats, favoris, etc.) avant de pouvoir supprimer son compte.
  const ownDocs = db.prepare('SELECT id FROM documents WHERE professorId = ?').all(userId);
  for (const d of ownDocs) deleteDocumentCascade(d.id);

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM purchases WHERE userId = ?').run(userId);
    db.prepare('DELETE FROM ad_unlocks WHERE userId = ?').run(userId);
    db.prepare('DELETE FROM favorites WHERE userId = ?').run(userId);
    db.prepare('DELETE FROM likes WHERE studentId = ? OR professorId = ?').run(userId, userId);
    db.prepare('DELETE FROM withdrawals WHERE professorId = ?').run(userId);
    db.prepare('DELETE FROM ai_submissions WHERE studentId = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  });
  tx();

  if (user.photoPath) {
    const { PHOTO_DIR } = require('./photoUpload');
    try { fs.unlinkSync(require('path').join(PHOTO_DIR, user.photoPath)); } catch (e) {}
  }
  return user;
}

module.exports = { deleteDocumentCascade, deleteUserCascade };
