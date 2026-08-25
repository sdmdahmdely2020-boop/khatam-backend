const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { newId } = require('./id');

// Copies envoyées par les élèves pour la correction IA — photo (prise directement
// avec l'appareil photo du téléphone) ou PDF. SUBMISSION_UPLOAD_DIR suit le même
// principe que UPLOAD_DIR/AD_UPLOAD_DIR/PHOTO_UPLOAD_DIR (voir lib/upload.js) :
// pointer vers le disque persistant en production.
const SUBMISSION_DIR = process.env.SUBMISSION_UPLOAD_DIR
  ? process.env.SUBMISSION_UPLOAD_DIR
  : path.join(__dirname, '..', '..', 'uploads', 'submissions');
fs.mkdirSync(SUBMISSION_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, SUBMISSION_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || (file.mimetype === 'application/pdf' ? '.pdf' : '.jpg');
    cb(null, `${newId('sub')}${ext}`);
  },
});

// Remarque HEIC/HEIF (format par défaut des photos iPhone) : sharp/mupdf ne
// savent pas le décoder de façon fiable dans cet environnement. Le frontend
// convertit donc systématiquement toute photo en JPEG (via <canvas>) avant
// l'envoi — voir handleSubmissionFileChange() côté client — donc le serveur
// ne devrait normalement jamais recevoir de HEIC brut. On le refuse ici avec
// un message clair plutôt que de laisser un traitement échouer plus loin.
const submissionUpload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 Mo — une photo de téléphone peut être lourde
  fileFilter: (req, file, cb) => {
    if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.mimetype)) {
      return cb(new Error('Format non supporté. Utilisez une photo JPEG/PNG ou un PDF.'));
    }
    cb(null, true);
  },
});

module.exports = { submissionUpload, SUBMISSION_DIR };
