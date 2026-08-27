require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const multer = require('multer');

const authRoutes = require('./routes/auth');
const documentRoutes = require('./routes/documents');
const paymentRoutes = require('./routes/payments');
const accessRoutes = require('./routes/access'); // /documents/:id/view, /ad-unlock, /favorite
const professorRoutes = require('./routes/professors');
const walletRoutes = require('./routes/wallet');
const aiRoutes = require('./routes/ai');
const adminRoutes = require('./routes/admin');
const adsRoutes = require('./routes/ads');
const feedbackRoutes = require('./routes/feedback');
const contentRoutes = require('./routes/content');
const ratingsRoutes = require('./routes/ratings');
const { AD_IMAGES_DIR } = require('./lib/adUpload');
const { PHOTO_DIR } = require('./lib/photoUpload');

const app = express();

// Origines autorisées à appeler l'API depuis un navigateur. `cors()` sans
// options (comportement précédent) reflétait n'importe quelle origine — un
// site tiers pouvait donc faire porter des requêtes authentifiées par le
// navigateur d'un élève/professeur connecté. FRONTEND_ORIGIN permet
// d'ajouter/remplacer facilement l'origine de prod (ex. après un futur nom
// de domaine personnalisé) sans redéployer le code.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://khatam-site.onrender.com',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5500',
];
const ALLOWED_ORIGINS = process.env.FRONTEND_ORIGIN
  ? [...DEFAULT_ALLOWED_ORIGINS, ...process.env.FRONTEND_ORIGIN.split(',').map((o) => o.trim())]
  : DEFAULT_ALLOWED_ORIGINS;

app.use(cors({
  origin: (origin, cb) => {
    // Pas d'en-tête Origin (ex. curl, appel serveur-à-serveur, un futur webhook
    // opérateur) : on laisse passer, ce n'est pas un contexte navigateur/CORS.
    if (!origin) return cb(null, true);
    // cb(null, false) — pas cb(new Error(...)) — pour une origine refusée :
    // la requête continue sans en-tête Access-Control-Allow-Origin (donc
    // bloquée côté navigateur comme il se doit), sans déclencher le
    // gestionnaire d'erreurs central ni polluer les logs d'un "500 Internal
    // Error" à chaque scan/bot qui appelle l'API depuis une origine tierce.
    cb(null, ALLOWED_ORIGINS.includes(origin));
  },
}));
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'khatam-backend', time: new Date().toISOString() }));

// X-Content-Type-Options: nosniff sur tous les dossiers servis statiquement —
// empêche un navigateur de "deviner" (MIME-sniffing) qu'un fichier posté
// comme image est en fait du HTML/JS exécutable, en complément du
// ré-encodage forcé via sharp (voir photoUpload.js / adUpload.js) qui
// garantit déjà que le contenu écrit sur disque est un vrai JPEG.
function noSniff(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}

// Images des bannières publicitaires — publiques, servies directement (pas de
// filigrane : ce ne sont pas des documents à protéger, juste des visuels marketing).
app.use('/uploads/ads', noSniff, express.static(AD_IMAGES_DIR));

// Photos de profil (élèves et professeurs) — publiques, pas de filigrane.
app.use('/uploads/photos', noSniff, express.static(PHOTO_DIR));

app.use('/api/auth', authRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api', accessRoutes); // monte /api/documents/:id/view, /api/documents/:id/ad-unlock, /api/favorites...
app.use('/api', aiRoutes); // /api/documents/:id/ai-grade, /api/ai/history
app.use('/api/professors', professorRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/ads', adsRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/ratings', ratingsRoutes);

// Gestion d'erreurs centralisée (ex: erreurs multer, exceptions non gérées dans les routes)
app.use((err, req, res, next) => {
  console.error(err);

  // multer lève des MulterError (fichier trop volumineux, champ inattendu...)
  // sans `err.status` — sans ce cas dédié, elles tombaient dans la branche
  // générique 500 "Une erreur est survenue", masquant une erreur pourtant
  // due à l'utilisateur (ex. PDF de 40 Mo alors que la limite est 25 Mo) et
  // empêchant le frontend de l'expliquer clairement.
  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: 'Fichier trop volumineux.',
      LIMIT_UNEXPECTED_FILE: 'Champ de fichier inattendu.',
    };
    return res.status(400).json({ error: err.code, message: messages[err.code] || 'Fichier invalide.' });
  }

  if (err.status) return res.status(err.status).json({ error: 'ERROR', message: err.message });
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Une erreur est survenue.' });
});

app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'Route inconnue.' }));

module.exports = app;
