// Filigrane serveur — appliqué à la volée à chaque ouverture d'un document,
// avec l'identité du lecteur et l'heure exacte. C'est la seule mesure
// anti-fuite réellement applicable depuis un serveur : elle ne bloque pas
// une capture d'écran (aucune plateforme web ne le peut), mais elle rend
// toute copie techniquement traçable jusqu'au compte qui l'a consultée,
// ce qui dissuade le partage — c'est l'approche utilisée par les vraies
// plateformes d'examens payants.

const { PDFDocument, rgb, degrees, StandardFonts } = require('pdf-lib');

async function watermarkPdf(sourceBytes, { label, timestamp }) {
  const pdfDoc = await PDFDocument.load(sourceBytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const tile = `${label} · ${timestamp}`;

  const pages = pdfDoc.getPages();
  for (const page of pages) {
    const { width, height } = page.getSize();
    const fontSize = 10;
    const textWidth = font.widthOfTextAtSize(tile, fontSize);
    const stepX = textWidth + 60;
    const stepY = 70;

    for (let y = -height; y < height * 2; y += stepY) {
      for (let x = -width; x < width * 2; x += stepX) {
        page.drawText(tile, {
          x,
          y,
          size: fontSize,
          font,
          color: rgb(0.6, 0.1, 0.1),
          opacity: 0.12,
          rotate: degrees(-28),
        });
      }
    }
  }

  return pdfDoc.save();
}

module.exports = { watermarkPdf };
