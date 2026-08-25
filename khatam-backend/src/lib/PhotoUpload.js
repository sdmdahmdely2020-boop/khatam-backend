const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { newId } = require('./id');

// Photos de profil (élèves et professeurs). Même principe que upload.js /
// adUpload.js : PHOTO_UPLOAD_DIR permet de pointer vers le disque persistant
// en production (ex. /var/data/uploads/photos sur Render).
const PHOTO_DIR = process.env.PHOTO_UPLOAD_DIR
  ? process.env.PHOTO_UPLOAD_DIR
  : path.join(__dirname, '..', '..', 'uploads', 'photos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PHOTO_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${newId('photo')}${ext}`);
  },
});

const photoUpload = multer({
  storage,
  limits: { fileSize: 4 * 1024 * 1024 }, // 4 Mo
  fileFilter: (req, file, cb) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return cb(new Error('Seules les images (JPEG, PNG, WEBP) sont acceptées.'));
    }
    cb(null, true);
  },
});

module.exports = { photoUpload, PHOTO_DIR };
