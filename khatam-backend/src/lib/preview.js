// Rendu d'aperçu et visionneuse "sans PDF brut" — deux usages du même moteur
// de rendu PDF→image :
//
// 1. generateBlurredPreview() : transforme la 1ère page d'un document en une
//    image "teaser" — l'en-tête (titre, série, session...) reste net, le
//    reste de la page est flouté DANS LES PIXELS (pas en CSS, donc impossible
//    à retirer depuis les outils de développement du navigateur). Utilisée
//    pour les vignettes du catalogue et la modale "Aperçu" avant paiement.
//
// 2. renderAllPagesJpeg() : rend chaque page d'un PDF déjà filigrané en image
//    JPEG. Utilisée par la visionneuse sécurisée (routes/access.js) à la
//    place de servir le PDF brut : le lecteur PDF natif du navigateur affiche
//    toujours ses propres boutons "télécharger / imprimer" sur un vrai PDF,
//    même filigrané — en affichant des images à la place, ce bouton disparaît
//    complètement. Ça ne bloque pas la capture d'écran (techniquement
//    impossible sur le web, voir la bannière dans la visionneuse), mais ça
//    retire le moyen le plus simple de récupérer une copie exacte du fichier.
//
// mupdf est un module ESM pur (top-level await) : require('mupdf') échoue
// avec ERR_REQUIRE_ASYNC_MODULE depuis ce code CommonJS. On charge donc le
// module avec import() dynamique, mis en cache après le premier appel.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

let mupdfPromise = null;
function loadMupdf() {
  if (!mupdfPromise) mupdfPromise = import('mupdf');
  return mupdfPromise;
}

const HEADER_RATIO = 0.24; // proportion de la hauteur de page laissée nette
const BLUR_SIGMA = 22;
const RENDER_SCALE = 1.6; // ~115 DPI, suffisant pour un aperçu/lecture écran

async function renderPagePng(doc, mupdf, pageIndex, scale) {
  const page = doc.loadPage(pageIndex);
  const matrix = mupdf.Matrix.scale(scale, scale);
  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
  return Buffer.from(pixmap.asPNG());
}

// Aperçu flouté de la 1ère page — retourne un buffer JPEG.
async function generateBlurredPreview(pdfBytes) {
  const mupdf = await loadMupdf();
  const doc = mupdf.Document.openDocument(pdfBytes, 'application/pdf');
  const png = await renderPagePng(doc, mupdf, 0, RENDER_SCALE);

  const meta = await sharp(png).metadata();
  const width = meta.width;
  const height = meta.height;
  const headerHeight = Math.max(1, Math.round(height * HEADER_RATIO));
  const bodyHeight = height - headerHeight;

  const headerBuf = await sharp(png).extract({ left: 0, top: 0, width, height: headerHeight }).toBuffer();
  const bodyBuf = bodyHeight > 0
    ? await sharp(png).extract({ left: 0, top: headerHeight, width, height: bodyHeight }).blur(BLUR_SIGMA).toBuffer()
    : null;

  const composite = [{ input: headerBuf, top: 0, left: 0 }];
  if (bodyBuf) composite.push({ input: bodyBuf, top: headerHeight, left: 0 });

  return sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite(composite)
    .jpeg({ quality: 78 })
    .toBuffer();
}

// Rend toutes les pages d'un PDF (déjà filigrané) en JPEG — utilisé "à la
// volée" par la visionneuse sécurisée, jamais mis en cache sur disque (le
// filigrane est propre à chaque lecteur).
async function renderAllPagesJpeg(pdfBytes) {
  const mupdf = await loadMupdf();
  const doc = mupdf.Document.openDocument(pdfBytes, 'application/pdf');
  const count = doc.countPages();
  const pages = [];
  for (let i = 0; i < count; i++) {
    const png = await renderPagePng(doc, mupdf, i, RENDER_SCALE);
    const jpeg = await sharp(png).jpeg({ quality: 82 }).toBuffer();
    pages.push(jpeg);
  }
  return pages;
}

// PREVIEW_DIR suit le même principe que UPLOAD_DIR/AD_UPLOAD_DIR (voir
// lib/upload.js) : pointer vers le disque persistant Render en production.
const PREVIEW_DIR = process.env.PREVIEW_DIR
  ? process.env.PREVIEW_DIR
  : path.join(__dirname, '..', '..', 'uploads', 'previews');
fs.mkdirSync(PREVIEW_DIR, { recursive: true });

// Génère (si nécessaire) l'aperçu flouté d'un document et retourne son
// chemin sur disque. Génération "à la demande" : couvre aussi bien les
// nouveaux documents que ceux mis en ligne avant cette fonctionnalité, sans
// script de migration séparé.
async function ensureDocumentPreview(doc) {
  const outPath = path.join(PREVIEW_DIR, `${doc.id}.jpg`);
  if (doc.previewPath && fs.existsSync(doc.previewPath)) return doc.previewPath;
  const pdfBytes = fs.readFileSync(doc.filePath);
  const jpeg = await generateBlurredPreview(pdfBytes);
  fs.writeFileSync(outPath, jpeg);
  return outPath;
}

module.exports = { generateBlurredPreview, renderAllPagesJpeg, ensureDocumentPreview, PREVIEW_DIR };
