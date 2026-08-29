const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../lib/db');
const { newId } = require('../lib/id');
const { upload } = require('../lib/upload');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { hasAccess } = require('../lib/access');
const { deleteDocumentCascade } = require('../lib/cascade');
const { ensureDocumentPreview } = require('../lib/preview');
const { effectivePlan, getSubscriptionSettings } = require('../lib/subscriptions');

const router = express.Router();

function likesCount(professorId) {
  const row = db.prepare('SELECT COUNT(*) as n FROM likes WHERE professorId = ?').get(professorId);
  return row.n;
}

function isBoosted(professor) {
  return !!(professor.boostActiveUntil && new Date(professor.boostActiveUntil) > new Date());
}

// Modèle hybride (29/08, voir lib/subscriptions.js) : un abonné Basic garde
// le prix normal en base (colonne "prix", jamais modifiée — le site web, qui
// ne connaît pas encore les abonnements, doit continuer à voir le vrai prix)
// mais l'app affiche en plus "effectivePrix", réduit, calculé ici à la
// lecture. Le montant réellement facturé est recalculé indépendamment côté
// POST /api/payments/initiate (jamais fait confiance à une valeur envoyée
// par le client) — cette fonction ne sert qu'à l'AFFICHAGE.
function effectivePriceFor(doc, viewerId) {
  if (!viewerId || doc.free) return { effectivePrix: doc.prix, subscriptionDiscountApplied: false };
  const viewer = db.prepare('SELECT subscriptionPlan, subscriptionExpiresAt FROM users WHERE id = ?').get(viewerId);
  if (!viewer || effectivePlan(viewer).plan !== 'basic') {
    return { effectivePrix: doc.prix, subscriptionDiscountApplied: false };
  }
  const { basicDiscountPercent } = getSubscriptionSettings();
  return { effectivePrix: Math.round(doc.prix * (1 - basicDiscountPercent / 100)), subscriptionDiscountApplied: true };
}

function toPublicDoc(doc, viewerId) {
  const professor = db.prepare('SELECT id, fullName, matieres, photoPath FROM users WHERE id = ?').get(doc.professorId);
  const { effectivePrix, subscriptionDiscountApplied } = effectivePriceFor(doc, viewerId);
  return {
    id: doc.id,
    title: doc.title,
    matiere: doc.matiere,
    serie: doc.serie,
    annee: doc.annee,
    type: doc.type,
    prix: doc.prix,
    effectivePrix,
    subscriptionDiscountApplied,
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
// optionalAuth() : si l'appelant envoie un vrai jeton (élève/professeur connecté),
// req.user est rempli et sert à calculer "unlocked" correctement. Sinon
// req.user est null et tout apparaît verrouillé — jamais de confiance
// accordée à un identifiant fourni "en clair" par le client (voir l'historique
// de X-Viewer-Id, supprimé : n'importe qui pouvait sonder l'accès de
// n'importe quel compte deviné sans être authentifié).
router.get('/', optionalAuth(), (req, res) => {
  const { serie, matiere, annee, type, q } = req.query;
  const params = {};
  // Un professeur connecté doit aussi voir ses PROPRES documents non publiés
  // (brouillons) ici — c'est cette même route que le frontend interroge puis
  // filtre côté client (par professorId) pour construire "Mes documents" du
  // tableau de bord professeur (voir loadCatalog()/MY_DOCS dans index.html).
  // Sans cette clause, un professeur ne verrait plus jamais ses propres
  // brouillons dans son propre tableau de bord.
  let baseClause = `statut = 'publie'`;
  if (req.user && req.user.role === 'PROFESSOR') {
    baseClause = `(statut = 'publie' OR professorId = @viewerId)`;
    params.viewerId = req.user.id;
  }
  const clauses = [baseClause];

  if (serie) { clauses.push('serie = @serie'); params.serie = serie; }
  if (matiere) { clauses.push('matiere = @matiere'); params.matiere = matiere; }
  if (annee) { clauses.push('annee = @annee'); params.annee = Number(annee); }
  if (type) { clauses.push('type = @type'); params.type = type; }
  if (q) { clauses.push('title LIKE @q'); params.q = `%${q}%`; }

  const docs = db.prepare(`SELECT * FROM documents WHERE ${clauses.join(' AND ')} ORDER BY createdAt DESC`).all(params);

  const viewerId = req.user ? req.user.id : null;
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

// GET /api/documents/mine — profil élève (29/08) : documents que CET élève a
// réellement débloqués par une action concrète (achat confirmé ou publicité
// vue), plus un résumé "progression simple". Placée AVANT "GET /:id"
// ci-dessous, sinon Express prendrait "mine" pour un id de document.
//
// Volontairement DIFFÉRENT de la liste "tout ce qui est unlocked=true" pour un
// abonné Premium (qui couvre alors tout le catalogue publié, voir hasAccess())
// — un Premium n'a rien "acheté" individuellement, donc cette liste peut être
// courte/vide pour lui tout en étant Premium, ce qui est correct : "progress"
// ci-dessous indique isPremium séparément pour que l'app puisse expliquer
// pourquoi la liste ne reflète pas tout ce à quoi il/elle a accès.
router.get('/mine', requireAuth({ roles: ['STUDENT'] }), (req, res) => {
  const userId = req.user.id;

  const purchasedRows = db.prepare(`
    SELECT d.*, pu.amount as purchaseAmount, pu.method as purchaseMethod, pu.confirmedAt as purchasedAt
    FROM purchases pu JOIN documents d ON d.id = pu.documentId
    WHERE pu.userId = ? AND pu.status = 'confirmed'
    ORDER BY pu.confirmedAt DESC
  `).all(userId);

  const adUnlockedRows = db.prepare(`
    SELECT d.*, au.createdAt as unlockedAt
    FROM ad_unlocks au JOIN documents d ON d.id = au.documentId
    WHERE au.userId = ?
    ORDER BY au.createdAt DESC
  `).all(userId);

  // Dédoublonne par document (un même document ne doit apparaître qu'une
  // fois même s'il a été débloqué par pub PUIS acheté plus tard) — l'achat
  // gagne, car c'est l'action la plus significative.
  const seen = new Set();
  const documents = [];

  for (const row of purchasedRows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    documents.push({
      ...toPublicDoc(row, userId),
      acquiredVia: 'purchase',
      acquiredAt: row.purchasedAt,
      amountPaid: row.purchaseAmount,
      method: row.purchaseMethod,
    });
  }
  for (const row of adUnlockedRows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    documents.push({
      ...toPublicDoc(row, userId),
      acquiredVia: 'ad',
      acquiredAt: row.unlockedAt,
      amountPaid: 0,
      method: null,
    });
  }
  documents.sort((a, b) => (a.acquiredAt < b.acquiredAt ? 1 : -1));

  const totalSpentMru = purchasedRows.reduce((sum, r) => sum + (r.purchaseAmount || 0), 0);
  const byMatiere = {};
  for (const doc of documents) {
    byMatiere[doc.matiere] = (byMatiere[doc.matiere] || 0) + 1;
  }

  const subscriber = db.prepare('SELECT subscriptionPlan, subscriptionExpiresAt, createdAt FROM users WHERE id = ?').get(userId);
  const plan = effectivePlan(subscriber).plan;

  res.json({
    documents,
    progress: {
      totalUnlocked: documents.length,
      totalSpentMru,
      byMatiere,
      memberSince: subscriber.createdAt,
      isPremium: plan === 'premium',
      isBasic: plan === 'basic',
    },
  });
});

// GET /api/documents/:id
// Un document dépublié (statut !== 'publie') n'est visible qu'à son auteur —
// sinon son id suffirait à le consulter en entier malgré la dépublication
// (métadonnées, aperçu, et le PDF complet s'il est gratuit/déjà acheté).
router.get('/:id', optionalAuth(), (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND', message: 'Document introuvable.' });
  const viewerId = req.user ? req.user.id : null;
  if (doc.statut !== 'publie' && doc.professorId !== viewerId) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'Document introuvable.' });
  }
  const professor = db.prepare('SELECT * FROM users WHERE id = ?').get(doc.professorId);
  res.json({
    document: {
      ...toPublicDoc(doc, viewerId),
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
router.get('/:id/preview', optionalAuth(), async (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });
  const viewerId = req.user ? req.user.id : null;
  if (doc.statut !== 'publie' && doc.professorId !== viewerId) {
    return res.status(404).json({ error: 'NOT_FOUND' });
  }
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

const VALID_TYPES = ['sujet', 'corrige', 'cours', 'exercices', 'video', 'blanc'];
const VALID_SERIES = ['A', 'C', 'D'];
const VALID_STATUTS = ['publie', 'brouillon'];
const MAX_PRIX_MRU = 100000; // borne large mais raisonnable — évite une saisie erronée type "50000000"

// Convertit une valeur de formulaire (string 'true'/'false' en multipart, ou
// booléen natif en JSON) en 0/1 SQLite. `better-sqlite3` refuse de lier un
// booléen JS natif tel quel (TypeError), d'où cette coercition systématique.
function toBit(v) {
  return v === 'true' || v === true || v === 1 || v === '1' ? 1 : 0;
}

// POST /api/documents — professeur uniquement, multipart/form-data avec champ "file"
router.post('/', requireAuth({ roles: ['PROFESSOR'] }), upload.single('file'), (req, res) => {
  const { title, matiere, serie, annee, type, prix, free, adUnlock, aiGrading } = req.body || {};

  const fail = (status, error, message) => {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch (e) {} }
    return res.status(status).json({ error, message });
  };

  if (!req.file) return res.status(400).json({ error: 'MISSING_FILE', message: 'Fichier PDF requis (champ "file").' });
  // Défense en profondeur : fileFilter (lib/upload.js) ne vérifie que le
  // Content-Type déclaré par le client, facilement falsifiable. Un fichier
  // dont le contenu réel n'est pas un PDF ne peut pas être servi directement
  // (ce dossier n'est jamais exposé via express.static — voir watermark.js /
  // preview.js, qui lisent toujours le fichier eux-mêmes), mais ferait
  // échouer plus tard, de façon confuse, le filigrane ou l'aperçu. On rejette
  // donc ici, tout de suite, avec un message clair, en vérifiant les octets
  // magiques "%PDF-" en tête de fichier.
  try {
    const head = fs.readFileSync(req.file.path, { encoding: null, flag: 'r' }).subarray(0, 5).toString('latin1');
    if (head !== '%PDF-') {
      return fail(400, 'INVALID_PDF', "Le fichier envoyé n'est pas un PDF valide.");
    }
  } catch (e) {
    return fail(400, 'INVALID_PDF', "Le fichier envoyé n'a pas pu être lu.");
  }
  if (!title || !matiere || !annee || !type) {
    return fail(400, 'MISSING_FIELDS', 'title, matiere, annee et type sont requis.');
  }
  if (!VALID_TYPES.includes(type)) {
    return fail(400, 'INVALID_TYPE', `type doit être l'un de: ${VALID_TYPES.join(', ')}`);
  }
  const serieValue = serie || 'C';
  if (!VALID_SERIES.includes(serieValue)) {
    return fail(400, 'INVALID_SERIE', `serie doit être l'une de: ${VALID_SERIES.join(', ')}`);
  }
  const anneeNum = Number(annee);
  if (!Number.isInteger(anneeNum) || anneeNum < 2000 || anneeNum > 2100) {
    return fail(400, 'INVALID_ANNEE', 'annee doit être un nombre entier valide.');
  }
  const isFree = toBit(free) === 1;
  const prixNum = isFree ? 0 : Number(prix || 0);
  if (!isFree && (!Number.isFinite(prixNum) || prixNum < 0 || prixNum > MAX_PRIX_MRU)) {
    return fail(400, 'INVALID_PRIX', `prix doit être un nombre entre 0 et ${MAX_PRIX_MRU}.`);
  }

  const id = newId('doc');
  // Un professeur dont le compte n'est pas encore approuvé par un
  // administrateur (professorStatus !== 'approved') peut préparer ses
  // documents, mais rien de ce qu'il envoie n'est publié tant que
  // l'approbation n'a pas eu lieu — le document est créé en "brouillon"
  // quoi qu'il arrive, visible seulement par lui-même (voir GET / plus haut).
  const initialStatut = req.user.professorStatus === 'approved' ? 'publie' : 'brouillon';
  db.prepare(`
    INSERT INTO documents (id, title, matiere, serie, annee, type, prix, free, adUnlock, aiGrading, filePath, professorId, statut)
    VALUES (@id, @title, @matiere, @serie, @annee, @type, @prix, @free, @adUnlock, @aiGrading, @filePath, @professorId, @statut)
  `).run({
    id, title, matiere,
    serie: serieValue,
    annee: anneeNum,
    type,
    prix: prixNum,
    free: isFree ? 1 : 0,
    adUnlock: toBit(adUnlock),
    aiGrading: toBit(aiGrading),
    filePath: req.file.path,
    professorId: req.user.id,
    statut: initialStatut,
  });

  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  res.status(201).json({
    document: toPublicDoc(doc, req.user.id),
    // Indique au frontend qu'il doit afficher un message explicatif : le
    // document a bien été enregistré, mais reste invisible aux élèves tant
    // que le compte professeur n'est pas approuvé par un administrateur.
    professorPending: initialStatut === 'brouillon' && req.user.professorStatus !== 'approved',
  });
});

// PATCH /api/documents/:id — propriétaire uniquement (prix, statut, etc.)
router.patch('/:id', requireAuth({ roles: ['PROFESSOR'] }), (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });
  if (doc.professorId !== req.user.id) return res.status(403).json({ error: 'FORBIDDEN', message: "Vous n'êtes pas l'auteur de ce document." });

  const body = req.body || {};
  const updates = {};

  // Champs texte requis (NOT NULL en base) : refuser explicitement une valeur
  // vide/null plutôt que de laisser SQLite renvoyer une erreur de contrainte opaque.
  for (const f of ['title', 'matiere', 'type']) {
    if (body[f] === undefined) continue;
    if (body[f] === null || String(body[f]).trim() === '') {
      return res.status(400).json({ error: 'INVALID_FIELD', message: `${f} ne peut pas être vide.` });
    }
    if (f === 'type' && !VALID_TYPES.includes(body[f])) {
      return res.status(400).json({ error: 'INVALID_TYPE', message: `type doit être l'un de: ${VALID_TYPES.join(', ')}` });
    }
    updates[f] = String(body[f]);
  }

  if (body.serie !== undefined) {
    if (!VALID_SERIES.includes(body.serie)) return res.status(400).json({ error: 'INVALID_SERIE', message: `serie doit être l'une de: ${VALID_SERIES.join(', ')}` });
    updates.serie = body.serie;
  }

  if (body.statut !== undefined) {
    if (!VALID_STATUTS.includes(body.statut)) return res.status(400).json({ error: 'INVALID_STATUT', message: `statut doit être l'un de: ${VALID_STATUTS.join(', ')}` });
    // Republier (ou publier pour la première fois) est refusé tant que le
    // compte professeur n'est pas approuvé — sinon un professeur en attente
    // pourrait contourner le blocage de POST / en créant un brouillon puis en
    // le repassant lui-même en "publie" via ce PATCH.
    if (body.statut === 'publie' && req.user.professorStatus !== 'approved') {
      return res.status(403).json({
        error: 'PROFESSOR_NOT_APPROVED',
        message: "Votre compte professeur doit d'abord être approuvé par un administrateur avant de pouvoir publier des documents.",
      });
    }
    updates.statut = body.statut;
  }

  if (body.annee !== undefined) {
    const anneeNum = Number(body.annee);
    if (!Number.isInteger(anneeNum) || anneeNum < 2000 || anneeNum > 2100) {
      return res.status(400).json({ error: 'INVALID_ANNEE', message: 'annee doit être un nombre entier valide.' });
    }
    updates.annee = anneeNum;
  }

  // free/adUnlock/aiGrading : coercition systématique en 0/1 — accepte aussi
  // bien {"free": true} (JSON natif) que {"free": "true"} (multipart/legacy).
  for (const f of ['free', 'adUnlock', 'aiGrading']) {
    if (body[f] !== undefined) updates[f] = toBit(body[f]);
  }

  if (body.prix !== undefined) {
    const prixNum = Number(body.prix);
    const willBeFree = updates.free !== undefined ? updates.free === 1 : !!doc.free;
    if (!willBeFree && (!Number.isFinite(prixNum) || prixNum < 0 || prixNum > MAX_PRIX_MRU)) {
      return res.status(400).json({ error: 'INVALID_PRIX', message: `prix doit être un nombre entre 0 et ${MAX_PRIX_MRU}.` });
    }
    updates.prix = willBeFree ? 0 : prixNum;
  }

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
