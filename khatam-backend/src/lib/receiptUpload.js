const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { newId } = require('./id');

// Captures d'écran de reçu de paiement (Bankily/Masrivi/Sedad), envoyées en
// complément (facultatif) du numéro de reçu — voir routes/payments.js,
// POST /:id/receipt. Ce n'est PAS une vérification automatique du paiement
// (une image peut être modifiée ou réutilisée) : c'est un simple appui visuel
// pour l'administrateur au moment de vérifier manuellement la réception de
// l'argent (voir routes/admin.js, POST /purchases/:id/confirm). RECEIPT_UPLOAD_DIR
// suit le même principe que UPLOAD_DIR/AD_UPLOAD_DIR/PHOTO_UPLOAD_DIR (pointer
// vers le disque persistant en production).
const RECEIPT_DIR = process.env.RECEIPT_UPLOAD_DIR
  ? process.env.RECEIPT_UPLOAD_DIR
  : path.join(__dirname, '..', '..', 'uploads', 'receipts');
fs.mkdirSync(RECEIPT_DIR, { recursive: true });

// Même raisonnement que photoUpload.js/adUpload.js : stockage en mémoire puis
// ré-encodage forcé via sharp en JPEG avant écriture sur disque — le
// Content-Type déclaré par le client ne garantit rien sur le contenu réel, et
// un fichier malveillant écrit tel quel puis servi statiquement serait une
// injection de script stockée (XSS). Ici le fichier n'est de toute façon
// jamais servi publiquement (voir la route admin dédiée, protégée par
// X-Admin-Key), mais on garde la même discipline par cohérence et parce que
// l'admin l'ouvre directement dans son navigateur.
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 6 * 1024 * 1024 }, // 6 Mo — une capture d'écran de téléphone peut être lourde
  fileFilter: (req, file, cb) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return cb(new Error('Seules les images (JPEG, PNG, WEBP) sont acceptées.'));
    }
    cb(null, true);
  },
});

async function reencodeToJpeg(req, res, next) {
  if (!req.file) return next();
  try {
    const filename = `${newId('receipt')}.jpg`;
    const outPath = path.join(RECEIPT_DIR, filename);
    await sharp(req.file.buffer)
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toFile(outPath);
    req.file.filename = filename;
    req.file.path = outPath;
    next();
  } catch (e) {
    res.status(400).json({ error: 'INVALID_IMAGE', message: "Le fichier envoyé n'est pas une image valide." });
  }
}

// upload.single(field) seul ne suffit pas : quand fileFilter rejette un
// fichier via cb(new Error(...)), multer transmet cette erreur à next(err),
// qui — sans gestionnaire dédié ici — tombe jusqu'au gestionnaire d'erreurs
// global de app.js et ressort en 500 INTERNAL_ERROR au lieu d'un 400 clair.
// On intercepte donc nous-mêmes cette erreur (type de fichier refusé, ou
// fichier trop volumineux) pour renvoyer une réponse 400 explicite.
function singleWithErrorHandling(field) {
  const mw = upload.single(field);
  return function (req, res, next) {
    mw(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: 'INVALID_FILE', message: err.message || 'Fichier invalide.' });
      }
      next();
    });
  };
}

const receiptUpload = { single: (field) => [singleWithErrorHandling(field), reencodeToJpeg] };

module.exports = { receiptUpload, RECEIPT_DIR };
