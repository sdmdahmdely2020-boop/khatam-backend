// Correction IA réelle — appelle l'API Claude (Anthropic) en vision : elle
// "regarde" le corrigé officiel du professeur (rendu en images depuis le PDF)
// et la copie envoyée par l'élève (photo, PDF ou texte tapé), puis renvoie une
// note sur 20 et un retour détaillé en français.
//
// Nécessite la variable d'environnement ANTHROPIC_API_KEY (clé API Anthropic,
// distincte de l'abonnement Claude Pro — voir README). Si elle n'est pas
// configurée, gradeSubmission() lève une erreur AI_NOT_CONFIGURED que la
// route traduit en message clair pour l'utilisateur plutôt que de planter.

const fs = require('fs');
const sharp = require('sharp');
const { renderAllPagesJpeg } = require('./preview');

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.AI_GRADING_MODEL || 'claude-haiku-4-5';
const MAX_DIMENSION = 1568; // au-delà, Claude redimensionne de toute façon côté serveur — inutile d'envoyer plus grand

function apiKeyConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

// Convertit un buffer image quelconque (JPEG/PNG/WEBP) en JPEG raisonnablement
// dimensionné, pour limiter le coût (tokens vision) et le temps d'upload.
async function normalizeImage(buffer) {
  return sharp(buffer)
    .rotate() // respecte l'orientation EXIF (photo prise en portrait sur téléphone)
    .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 84 })
    .toBuffer();
}

// Retourne un tableau de buffers JPEG (une entrée par page) pour un fichier
// PDF ou image quelconque.
async function fileToImagePages(filePath, mimeType) {
  const bytes = fs.readFileSync(filePath);
  if (mimeType === 'application/pdf') {
    const pages = await renderAllPagesJpeg(bytes);
    return Promise.all(pages.map((p) => normalizeImage(p)));
  }
  return [await normalizeImage(bytes)];
}

function imageBlock(jpegBuffer) {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: jpegBuffer.toString('base64') },
  };
}

const SYSTEM_PROMPT = `Tu es un examinateur expérimenté du Baccalauréat mauritanien, Série C. Tu corriges la copie d'un élève en la comparant strictement au corrigé officiel fourni par son professeur.

Règles :
- Base-toi UNIQUEMENT sur le corrigé officiel fourni comme référence — pas sur tes propres connaissances du sujet, même si tu penses qu'une autre méthode est aussi valable, sauf si le résultat final et le raisonnement sont manifestement corrects.
- Sois juste mais rigoureux, comme un vrai correcteur du Bac : attribue les points par étape/partie quand c'est possible, pas seulement sur le résultat final.
- Si l'écriture est difficile à lire (photo), fais de ton mieux et signale les passages illisibles dans les faiblesses plutôt que de pénaliser injustement.
- Réponds UNIQUEMENT en français.
- Réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte avant ou après, exactement sous cette forme :
{"note": <nombre entre 0 et 20, un chiffre après la virgule autorisé>, "feedback": "<2 à 4 phrases de synthèse générale>", "strengths": ["<point fort 1>", "..."], "weaknesses": ["<point à corriger 1>", "..."]}
Les tableaux "strengths" et "weaknesses" doivent contenir entre 1 et 4 éléments courts et concrets chacun.`;

async function callClaude(content) {
  if (!apiKeyConfigured()) {
    const err = new Error("La correction IA n'est pas encore configurée sur ce serveur.");
    err.code = 'AI_NOT_CONFIGURED';
    throw err;
  }

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    const err = new Error(`Appel à l'API Claude échoué (${res.status}) : ${bodyText.slice(0, 300)}`);
    err.code = 'AI_CALL_FAILED';
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) {
    const err = new Error("Réponse inattendue de l'IA (aucun texte renvoyé).");
    err.code = 'AI_BAD_RESPONSE';
    throw err;
  }

  let parsed;
  try {
    // L'IA répond en principe avec du JSON pur, mais on tolère un éventuel
    // texte autour (ex: ```json ... ```) en extrayant le premier bloc { ... }.
    const match = textBlock.text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : textBlock.text);
  } catch (e) {
    const err = new Error("Impossible d'interpréter la réponse de l'IA.");
    err.code = 'AI_BAD_RESPONSE';
    throw err;
  }

  const note = Math.max(0, Math.min(20, Number(parsed.note)));
  if (Number.isNaN(note)) {
    const err = new Error("La note renvoyée par l'IA est invalide.");
    err.code = 'AI_BAD_RESPONSE';
    throw err;
  }

  return {
    note,
    feedback: String(parsed.feedback || '').slice(0, 2000),
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 6).map(String) : [],
    weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses.slice(0, 6).map(String) : [],
  };
}

// gradeSubmission({ correctionFilePath, submissionFilePath?, submissionMimeType?, submissionText? })
// Le corrigé du professeur (PDF) est toujours rendu en images. La copie de
// l'élève est soit un fichier (photo/PDF, rendu en image lui aussi), soit du
// texte tapé directement — les deux formes sont acceptées côté route.
async function gradeSubmission({ correctionFilePath, submissionFilePath, submissionMimeType, submissionText }) {
  const correctionPages = await fileToImagePages(correctionFilePath, 'application/pdf');

  const content = [
    { type: 'text', text: 'Voici le corrigé officiel du professeur, à utiliser comme référence pour la correction :' },
    ...correctionPages.map(imageBlock),
  ];

  if (submissionFilePath) {
    const submissionPages = await fileToImagePages(submissionFilePath, submissionMimeType);
    content.push({ type: 'text', text: "Voici la copie de l'élève à corriger :" });
    content.push(...submissionPages.map(imageBlock));
  } else {
    content.push({ type: 'text', text: `Voici la réponse tapée par l'élève à corriger :\n\n${submissionText}` });
  }

  content.push({ type: 'text', text: 'Corrige cette copie selon les règles données et réponds uniquement avec le JSON demandé.' });

  return callClaude(content);
}

module.exports = { gradeSubmission, apiKeyConfigured };
