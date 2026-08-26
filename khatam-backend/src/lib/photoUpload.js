const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { newId } = require('./id');

// Photos de profil (élèves et professeurs). Même principe que upload.js /
// adUpload.js : PHOTO_UPLOAD_DIR permet de pointer vers le disque persistant
// en production (ex. /var/data/uploads/photos sur Render).
const PHOTO_DIR = process.env.PHOTO_UPLOAD_DIR
  ? process.env.PHOTO_UPLOAD_DIR
  : path.join(__dirname, '..', '..', 'uploads', 'photos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });

// Stockage en mémoire, PAS directement sur disque sous le nom/l'extension
// fournis par le client : `fileFilter` ci-dessous ne vérifie que le
// Content-Type déclaré par le client (facilement falsifiable avec n'importe
// quel outil HTTP), et rien ne garantit que le contenu réel du fichier
// corresponde à ce Content-Type. Un fichier malveillant (ex. un
// <script>...</script> stocké dans un fichier "photo.jpg" déclaré comme
// image/jpeg) écrit tel quel sur disque puis servi statiquement (voir
// app.js, /uploads/photos) constituerait une injection de script stockée
// (XSS) contre quiconque ouvre cette "photo" directement dans son navigateur.
// On force donc un ré-encodage serveur via sharp : seul le résultat, décodé
// puis ré-écrit comme une vraie image JPEG, est écrit sur disque, sous une
// extension fixe .jpg — les octets et le nom de fichier d'origine ne
// survivent jamais.
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 4 * 1024 * 1024 }, // 4 Mo
  fileFilter: (req, file, cb) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return cb(new Error('Seules les images (JPEG, PNG, WEBP) sont acceptées.'));
    }
    cb(null, true);
  },
});

// Middleware chaîné après upload.single('photo') : décode réellement le
// contenu reçu et le ré-encode en JPEG via sharp avant de l'écrire sur
// disque. Si le contenu n'est en réalité pas une image décodable (quel que
// soit le Content-Type déclaré), sharp échoue et on renvoie une erreur 400
// propre plutôt que d'écrire un fichier arbitraire.
async function reencodeToJpeg(req, res, next) {
  if (!req.file) return next();
  try {
    const filename = `${newId('photo')}.jpg`;
    const outPath = path.join(PHOTO_DIR, filename);
    await sharp(req.file.buffer)
      .rotate() // respecte l'orientation EXIF d'origine avant qu'elle ne soit perdue au ré-encodage
      .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toFile(outPath);
    req.file.filename = filename;
    req.file.path = outPath;
    next();
  } catch (e) {
    res.status(400).json({ error: 'INVALID_IMAGE', message: "Le fichier envoyé n'est pas une image valide." });
  }
}

const photoUpload = { single: (field) => [upload.single(field), reencodeToJpeg] };

module.exports = { photoUpload, PHOTO_DIR };
