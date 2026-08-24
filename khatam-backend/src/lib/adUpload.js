const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { newId } = require('./id');

// Images des bannières publicitaires (annonceurs locaux). Séparé du dossier des
// documents PDF. AD_UPLOAD_DIR permet de pointer vers le disque persistant en
// production (ex. /var/data/uploads/ads sur Render) — voir upload.js pour le
// même principe appliqué aux documents.
const AD_IMAGES_DIR = process.env.AD_UPLOAD_DIR
  ? process.env.AD_UPLOAD_DIR
  : path.join(__dirname, '..', '..', 'uploads', 'ads');
fs.mkdirSync(AD_IMAGES_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, AD_IMAGES_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${newId('ad')}${ext}`);
  },
});

const adUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 Mo
  fileFilter: (req, file, cb) => {
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype)) {
      return cb(new Error('Seules les images (JPEG, PNG, WEBP, GIF) sont acceptées.'));
    }
    cb(null, true);
  },
});

module.exports = { adUpload, AD_IMAGES_DIR };
