const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../lib/db');
const { newId } = require('../lib/id');
const { upload } = require('../lib/upload');
const { requireAuth } = require('../middleware/auth');
const { hasAccess } = require('../lib/access');
const { deleteDocumentCascade } = require('../lib/cascade');
const { ensureDocumentPreview } = require('../lib/preview');

const router = express.Router();

function likesCount(professorId) {
  const row = db.prepare('SELECT COUNT(*) as n FROM likes WHERE professorId = ?').get(professorId);
  return row.n;
}

function isBoosted(professor) {
  return !!(professor.boostActiveUntil && new Date(professor.boostActiveUntil) > new Date());
}

function toPublicDoc(doc, viewerId) {
  const professor = db.prepare('SELECT id, fullName, matieres, photoPath FROM users WHERE id = ?').get(doc.professorId);
  return {
    id: doc.id,
    title: doc.title,
    matiere: doc.matiere,
    serie: doc.serie,
    annee: doc.annee,
    type: doc.type,
    prix: doc.prix,
    free: !!doc.free,
    adUnlock: !!doc.adUnlock,
    aiGrading: !!doc.aiGrading,
    views: doc.views,
    statut: doc.statut,
    createdAt: doc.createdAt,
    previewUrl: `/api/documents/${doc.id}/preview`,
    professor: {
      id: professor.id,
      fullName: professor.fullName,
      matieres: professor.matieres,
      photoUrl: professor.photoPath ? `/uploads/photos/${professor.photoPath}` : null,
    },
    unlocked: hasAccess(viewerId, doc),
  };
}

// GET /api/documents?serie=C&matiere=&annee=&type=&q=
// Trie : documents des professeurs "boostés" d'abord, puis par nombre de likes du
// professeur décroissant, puis les plus récents.
router.get('/', (req, res) => {
  const { serie, matiere, annee, type, q } = req.query;
  const clauses = [`statut = 'publie'`];
  const params = {};

  if (serie) { clauses.push('serie = @serie'); params.serie = serie; }
  if (matiere) { clauses.push('matiere = @matiere'); params.matiere = matiere; }
  if (annee) { clauses.push('annee = @annee'); params.annee = Number(annee); }
  if (type) { clauses.push('type = @type'); params.type = type; }
  if (q) { clauses.push('title LIKE @q'); params.q = `%${q}%`; }

  const docs = db.prepare(`SELECT * FROM documents WHERE ${clauses.join(' AND ')} ORDER BY createdAt DESC`).all(params);

  const viewerId = req.headers['x-viewer-id'] || null; // optionnel, pour marquer "unlocked" sans forcer une auth stricte ici
  const enriched = docs.map((d) => {
    const professor = db.prepare('SELECT * FROM users WHERE id = ?').get(d.professorId);
    return {
      doc: toPublicDoc(d, viewerId),
      _boosted: isBoosted(professor),
      _likes: likesCount(professor.id),
    };
  });

  enriched.sort((a, b) => {
    if (a._boosted !== b._boosted) return a._boosted ? -1 : 1;
    if (b._likes !== a._likes) return b._likes - a._likes;
    return 0;
  });

  res.json({
    documents: enriched.map((e) => ({ ...e.doc, professorBoosted: e._boosted, professorLikes: e._likes })),
  });
});

// GET /api/documents/:id
router.get('/:id', (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND', message: 'Document introuvable.' });
  const professor = db.prepare('SELECT * FROM users WHERE id = ?').get(doc.professorId);
  res.json({
    document: {
      ...toPublicDoc(doc, req.headers['x-viewer-id'] || null),
      professorBoosted: isBoosted(professor),
      professorLikes: likesCount(professor.id),
    },
  });
});

// GET /api/documents/:id/preview — image d'aperçu (en-tête net, reste flouté
// dans les pixels), publique, pour la vignette du catalogue et la modale
// "Aperçu" avant paiement. Générée à la demande si elle n'existe pas encore
// (documents publiés avant cette fonctionnalité), puis mise en cache sur
// disque et référencée dans documents.previewPath.
router.get('/:id/preview', async (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });
  try {
    const previewPath = await ensureDocumentPreview(doc);
    if (previewPath !== doc.previewPath) {
      db.prepare('UPDATE documents SET previewPath = ? WHERE id = ?').run(previewPath, doc.id);
    }
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.resolve(previewPath));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'PREVIEW_FAILED', message: "Impossible de générer l'aperçu de ce document." });
  }
});

// POST /api/documents — professeur uniquement, multipart/form-data avec champ "file"
router.post('/', requireAuth({ roles: ['PROFESSOR'] }), upload.single('file'), (req, res) => {
  const { title, matiere, serie, annee, type, prix, free, adUnlock, aiGrading } = req.body || {};

  if (!req.file) return res.status(400).json({ error: 'MISSING_FILE', message: 'Fichier PDF requis (champ "file").' });
  if (!title || !matiere || !annee || !type) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'title, matiere, annee et type sont requis.' });
  }
  const validTypes = ['sujet', 'corrige', 'cours', 'exercices', 'video', 'blanc'];
  if (!validTypes.includes(type)) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'INVALID_TYPE', message: `type doit être l'un de: ${validTypes.join(', ')}` });
  }

  const id = newId('doc');
  db.prepare(`
    INSERT INTO documents (id, title, matiere, serie, annee, type, prix, free, adUnlock, aiGrading, filePath, professorId)
    VALUES (@id, @title, @matiere, @serie, @annee, @type, @prix, @free, @adUnlock, @aiGrading, @filePath, @professorId)
  `).run({
    id, title, matiere,
    serie: serie || 'C',
    annee: Number(annee),
    type,
    prix: free === 'true' || free === true ? 0 : Number(prix || 0),
    free: free === 'true' || free === true ? 1 : 0,
    adUnlock: adUnlock === 'true' || adUnlock === true ? 1 : 0,
    aiGrading: aiGrading === 'true' || aiGrading === true ? 1 : 0,
    filePath: req.file.path,
    professorId: req.user.id,
  });

  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  res.status(201).json({ document: toPublicDoc(doc, req.user.id) });
});

// PATCH /api/documents/:id — propriétaire uniquement (prix, statut, etc.)
router.patch('/:id', requireAuth({ roles: ['PROFESSOR'] }), (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });
  if (doc.professorId !== req.user.id) return res.status(403).json({ error: 'FORBIDDEN', message: "Vous n'êtes pas l'auteur de ce document." });

  const fields = ['title', 'matiere', 'annee', 'type', 'prix', 'free', 'adUnlock', 'aiGrading', 'statut'];
  const updates = {};
  for (const f of fields) if (req.body[f] !== undefined) updates[f] = req.body[f];

  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'NO_FIELDS' });

  const setClause = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE documents SET ${setClause} WHERE id = @id`).run({ ...updates, id: doc.id });

  const updated = db.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id);
  res.json({ document: toPublicDoc(updated, req.user.id) });
});

// DELETE /api/documents/:id — propriétaire uniquement.
// Utilise deleteDocumentCascade (lib/cascade.js) : un DELETE direct échouerait dès
// que le document a été acheté/mis en favori/etc. au moins une fois, car SQLite
// (foreign_keys = ON) refuse de supprimer une ligne encore référencée ailleurs.
router.delete('/:id', requireAuth({ roles: ['PROFESSOR'] }), (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });
  if (doc.professorId !== req.user.id) return res.status(403).json({ error: 'FORBIDDEN' });

  deleteDocumentCascade(doc.id);
  res.json({ message: 'Document supprimé.' });
});

module.exports = router;
