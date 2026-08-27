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

  const submissions = db.prepare('SELECT answerFilePath FROM ai_submissions WHERE documentId = ? AND answerFilePath IS NOT NULL').all(documentId);
  const receipts = db.prepare('SELECT receiptImagePath FROM purchases WHERE documentId = ? AND receiptImagePath IS NOT NULL').all(documentId);

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
  for (const r of receipts) { try { fs.unlinkSync(r.receiptImagePath); } catch (e) {} }
  if (submissions.length) {
    const { SUBMISSION_DIR } = require('./submissionUpload');
    const path = require('path');
    for (const s of submissions) {
      try { fs.unlinkSync(path.join(SUBMISSION_DIR, s.answerFilePath)); } catch (e) {}
    }
  }
  return doc;
}

function deleteUserCascade(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return null;

  // Si c'est un professeur : supprime d'abord chacun de ses documents (et tout ce
  // qui en dépend — achats, favoris, etc.) avant de pouvoir supprimer son compte.
  const ownDocs = db.prepare('SELECT id FROM documents WHERE professorId = ?').all(userId);
  for (const d of ownDocs) deleteDocumentCascade(d.id);

  const ownSubmissions = db.prepare('SELECT answerFilePath FROM ai_submissions WHERE studentId = ? AND answerFilePath IS NOT NULL').all(userId);
  const ownReceipts = db.prepare('SELECT receiptImagePath FROM purchases WHERE userId = ? AND receiptImagePath IS NOT NULL').all(userId);

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM purchases WHERE userId = ?').run(userId);
    db.prepare('DELETE FROM ad_unlocks WHERE userId = ?').run(userId);
    db.prepare('DELETE FROM favorites WHERE userId = ?').run(userId);
    db.prepare('DELETE FROM likes WHERE studentId = ? OR professorId = ?').run(userId, userId);
    db.prepare('DELETE FROM withdrawals WHERE professorId = ?').run(userId);
    db.prepare('DELETE FROM ai_submissions WHERE studentId = ?').run(userId);
    // Trois tables ajoutées après la première version de cette fonction
    // (feedback, note de l'app, messagerie admin<->professeur — toutes
    // introduites le 27/08) référencent aussi users(id) mais n'étaient PAS
    // nettoyées ici. Bug découvert le 27/08 en production : dès qu'un compte
    // avait laissé un avis (app_ratings), un message de feedback, ou (pour
    // un professeur) échangé un message avec l'admin, la contrainte FOREIGN
    // KEY (foreign_keys = ON, voir db.js) faisait échouer tout le bloc
    // db.transaction() ci-dessus — better-sqlite3 annule alors TOUTE la
    // transaction (rollback complet, y compris les DELETE déjà exécutés
    // au-dessus) et relance l'erreur. Le compte n'était donc jamais
    // supprimé, ni ici ni via /admin/reset-all-users (qui appelle cette même
    // fonction en boucle, un utilisateur à la fois) — d'où le comportement
    // signalé par sidi : "parfois ça marche, parfois non" (ça marchait pour
    // les comptes n'ayant jamais laissé d'avis/feedback/message, et échouait
    // silencieusement pour les autres, avec une erreur 500 que l'admin ne
    // remarquait pas forcément).
    db.prepare('DELETE FROM feedback WHERE userId = ?').run(userId);
    db.prepare('DELETE FROM app_ratings WHERE userId = ?').run(userId);
    db.prepare('DELETE FROM admin_messages WHERE professorId = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  });
  tx();

  if (user.photoPath) {
    const { PHOTO_DIR } = require('./photoUpload');
    try { fs.unlinkSync(require('path').join(PHOTO_DIR, user.photoPath)); } catch (e) {}
  }
  for (const r of ownReceipts) { try { fs.unlinkSync(r.receiptImagePath); } catch (e) {} }
  if (ownSubmissions.length) {
    const { SUBMISSION_DIR } = require('./submissionUpload');
    const path = require('path');
    for (const s of ownSubmissions) {
      try { fs.unlinkSync(path.join(SUBMISSION_DIR, s.answerFilePath)); } catch (e) {}
    }
  }
  return user;
}

module.exports = { deleteDocumentCascade, deleteUserCascade };
