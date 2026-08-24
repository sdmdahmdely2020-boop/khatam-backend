// Remplit la base avec des comptes et documents de démonstration.
// Usage : npm run seed   (à lancer une seule fois, avant npm start)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const db = require('../src/lib/db');
const { newId } = require('../src/lib/id');

async function makeSamplePdf(title, lines) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([595, 842]);
  page.drawText(title, { x: 50, y: 780, size: 20, font: bold, color: rgb(0.1, 0.1, 0.1) });
  let y = 730;
  for (const line of lines) {
    page.drawText(line, { x: 50, y, size: 12, font, color: rgb(0.2, 0.2, 0.2) });
    y -= 22;
  }
  page.drawText('Document de démonstration — Khatam', { x: 50, y: 40, size: 9, font, color: rgb(0.5, 0.5, 0.5) });
  return pdf.save();
}

async function main() {
  console.log('Seed en cours...');

  const docsDir = path.join(__dirname, '..', 'uploads', 'documents');
  fs.mkdirSync(docsDir, { recursive: true });

  const passwordHash = await bcrypt.hash('demo1234', 10);

  const profs = [
    { fullName: 'Pr. Sidi Mohamed L.', phone: '22200000001', matieres: 'Mathématiques', bio: 'Professeur de mathématiques, 12 ans d’expérience, spécialiste Bac Série C.' },
    { fullName: 'Pr. Aichetou B.', phone: '22200000002', matieres: 'Physique', bio: 'Professeure de physique-chimie, corrections détaillées.' },
  ];

  const profIds = [];
  for (const p of profs) {
    const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(p.phone);
    if (existing) { profIds.push(existing.id); continue; }
    const id = newId('user');
    db.prepare(`
      INSERT INTO users (id, role, fullName, phone, passwordHash, bio, matieres)
      VALUES (?, 'PROFESSOR', ?, ?, ?, ?, ?)
    `).run(id, p.fullName, p.phone, passwordHash, p.bio, p.matieres);
    profIds.push(id);
  }

  const students = [
    { fullName: 'Mariem El Houssein', phone: '22211111111' },
    { fullName: 'Mohamed Vall K.', phone: '22211111112' },
  ];
  const studentIds = [];
  for (const s of students) {
    const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(s.phone);
    if (existing) { studentIds.push(existing.id); continue; }
    const id = newId('user');
    db.prepare(`INSERT INTO users (id, role, fullName, phone, passwordHash, serie) VALUES (?, 'STUDENT', ?, ?, ?, 'C')`)
      .run(id, s.fullName, s.phone, passwordHash);
    studentIds.push(id);
  }

  const existingDocs = db.prepare('SELECT COUNT(*) as n FROM documents').get().n;
  if (existingDocs === 0) {
    const catalog = [
      { title: 'Examen Bac blanc n°1 — Mathématiques', matiere: 'Mathématiques', annee: 2025, type: 'blanc', prix: 200, prof: profIds[0], adUnlock: true },
      { title: 'Corrigé — Bac Mathématiques 2024', matiere: 'Mathématiques', annee: 2024, type: 'corrige', prix: 150, prof: profIds[0], aiGrading: true },
      { title: 'Sujet officiel — Bac Mathématiques 2024', matiere: 'Mathématiques', annee: 2024, type: 'sujet', prix: 0, free: true, prof: profIds[0] },
      { title: 'Cours complet — Probabilités', matiere: 'Mathématiques', annee: 2026, type: 'cours', prix: 250, prof: profIds[0] },
      { title: 'Exercices corrigés — Électricité', matiere: 'Physique', annee: 2026, type: 'exercices', prix: 150, prof: profIds[1], adUnlock: true },
      { title: 'Cours complet — Mécanique', matiere: 'Physique', annee: 2026, type: 'cours', prix: 250, prof: profIds[1] },
      { title: 'Corrigé — Bac Physique 2024', matiere: 'Physique', annee: 2024, type: 'corrige', prix: 150, prof: profIds[1], aiGrading: true },
    ];

    for (const c of catalog) {
      const bytes = await makeSamplePdf(c.title, [
        `Matière : ${c.matiere}`, `Année : ${c.annee}`, `Type : ${c.type}`,
        '', 'Ceci est un contenu de démonstration généré automatiquement.',
      ]);
      const id = newId('doc');
      const filePath = path.join(docsDir, `${id}.pdf`);
      fs.writeFileSync(filePath, bytes);

      db.prepare(`
        INSERT INTO documents (id, title, matiere, serie, annee, type, prix, free, adUnlock, aiGrading, filePath, professorId)
        VALUES (@id, @title, @matiere, 'C', @annee, @type, @prix, @free, @adUnlock, @aiGrading, @filePath, @professorId)
      `).run({
        id, title: c.title, matiere: c.matiere, annee: c.annee, type: c.type,
        prix: c.free ? 0 : c.prix, free: c.free ? 1 : 0,
        adUnlock: c.adUnlock ? 1 : 0, aiGrading: c.aiGrading ? 1 : 0,
        filePath, professorId: c.prof,
      });
    }
  }

  // Quelques likes de démo pour le classement
  const allProfs = db.prepare(`SELECT id FROM users WHERE role = 'PROFESSOR'`).all();
  const allStudents = db.prepare(`SELECT id FROM users WHERE role = 'STUDENT'`).all();
  for (const s of allStudents) {
    for (const p of allProfs) {
      const exists = db.prepare('SELECT id FROM likes WHERE studentId = ? AND professorId = ?').get(s.id, p.id);
      if (!exists && Math.random() > 0.4) {
        db.prepare('INSERT INTO likes (id, studentId, professorId) VALUES (?, ?, ?)').run(newId('like'), s.id, p.id);
      }
    }
  }

  console.log('Seed terminé.');
  console.log('Comptes de démonstration (mot de passe: demo1234) :');
  profs.forEach((p) => console.log(`  Professeur — ${p.phone} — ${p.fullName}`));
  students.forEach((s) => console.log(`  Élève      — ${s.phone} — ${s.fullName}`));
}

main().catch((e) => { console.error(e); process.exit(1); });
