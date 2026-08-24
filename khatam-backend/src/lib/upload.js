const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { newId } = require('./id');

// UPLOAD_DIR permet de pointer vers un disque persistant (ex. /var/data/uploads/documents
// sur Render) au lieu du dossier du projet, qui est effacé à chaque redéploiement/redémarrage
// sur les plans sans disque persistant. Voir README.md, section "Passer en production".
const DOCS_DIR = process.env.UPLOAD_DIR
  ? process.env.UPLOAD_DIR
  : path.join(__dirname, '..', '..', 'uploads', 'documents');
fs.mkdirSync(DOCS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DOCS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.pdf';
    cb(null, `${newId('doc')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 Mo
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Seuls les fichiers PDF sont acceptés.'));
    }
    cb(null, true);
  },
});

module.exports = { upload, DOCS_DIR };
