require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const authRoutes = require('./routes/auth');
const documentRoutes = require('./routes/documents');
const paymentRoutes = require('./routes/payments');
const accessRoutes = require('./routes/access'); // /documents/:id/view, /ad-unlock, /favorite
const professorRoutes = require('./routes/professors');
const walletRoutes = require('./routes/wallet');
const aiRoutes = require('./routes/ai');
const adminRoutes = require('./routes/admin');

const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'khatam-backend', time: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api', accessRoutes); // monte /api/documents/:id/view, /api/documents/:id/ad-unlock, /api/favorites...
app.use('/api', aiRoutes); // /api/documents/:id/ai-grade, /api/ai/history
app.use('/api/professors', professorRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/admin', adminRoutes);

// Gestion d'erreurs centralisée (ex: erreurs multer, exceptions non gérées dans les routes)
app.use((err, req, res, next) => {
  console.error(err);
  if (err.status) return res.status(err.status).json({ error: 'ERROR', message: err.message });
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Une erreur est survenue.' });
});

app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'Route inconnue.' }));

module.exports = app;
