const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { newId } = require('./id');

// Images des bannières publicitaires (annonceurs locaux). Séparé du dossier des
// documents PDF. AD_UPLOAD_DIR permet de pointer vers le disque persistant en
// production (ex. /var/data/uploads/ads sur Render) — voir upload.js pour le
// même principe appliqué aux documents.
const AD_IMAGES_DIR = process.env.AD_UPLOAD_DIR
  ? process.env.AD_UPLOAD_DIR
  : path.join(__dirname, '..', '..', 'uploads', 'ads');
fs.mkdirSync(AD_IMAGES_DIR, { recursive: true });

// Même raisonnement que photoUpload.js : le Content-Type déclaré par le
// client (vérifié par fileFilter ci-dessous) ne garantit rien sur le contenu
// réel du fichier. Ces bannières sont déposées par l'administrateur via le
// panneau d'admin (donc un risque moindre qu'un upload public), mais elles
// sont ensuite servies statiquement à TOUS les visiteurs du site (voir
// app.js, /uploads/ads) — un fichier mal formé écrit tel quel constituerait
// donc un risque XSS pour l'ensemble des élèves. On stocke en mémoire et on
// ré-encode via sharp avant d'écrire sur disque, sous une extension fixe
// .jpg (les GIF animés perdent leur animation au passage — acceptable pour
// une bannière statique).
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 Mo
  fileFilter: (req, file, cb) => {
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype)) {
      return cb(new Error('Seules les images (JPEG, PNG, WEBP, GIF) sont acceptées.'));
    }
    cb(null, true);
  },
});

async function reencodeToJpeg(req, res, next) {
  if (!req.file) return next();
  try {
    const filename = `${newId('ad')}.jpg`;
    const outPath = path.join(AD_IMAGES_DIR, filename);
    await sharp(req.file.buffer)
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toFile(outPath);
    req.file.filename = filename;
    req.file.path = outPath;
    next();
  } catch (e) {
    res.status(400).json({ error: 'INVALID_IMAGE', message: "Le fichier envoyé n'est pas une image valide." });
  }
}

const adUpload = { single: (field) => [upload.single(field), reencodeToJpeg] };

module.exports = { adUpload, AD_IMAGES_DIR };
