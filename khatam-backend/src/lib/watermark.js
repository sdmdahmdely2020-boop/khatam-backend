// Filigrane serveur — appliqué à la volée à chaque ouverture d'un document,
// avec l'identité du lecteur et l'heure exacte. C'est la seule mesure
// anti-fuite réellement applicable depuis un serveur : elle ne bloque pas
// une capture d'écran (aucune plateforme web ne le peut), mais elle rend
// toute copie techniquement traçable jusqu'au compte qui l'a consultée,
// ce qui dissuade le partage — c'est l'approche utilisée par les vraies
// plateformes d'examens payants.

const { PDFDocument, rgb, degrees, StandardFonts } = require('pdf-lib');

// La police standard Helvetica utilise l'encodage WinAnsi (essentiellement
// Latin-1 + quelques symboles) : elle ne sait pas dessiner de caractères
// arabes. Beaucoup d'utilisateurs mauritaniens saisissent leur nom en
// écriture arabe (fullName vient directement du formulaire d'inscription) —
// sans ce filtre, drawText() lève une exception et /view / /view-pages
// renvoient une erreur 500 au lieu d'ouvrir le document. On remplace tout
// caractère non représentable par "?" plutôt que de faire échouer tout le
// filigrane : le numéro de téléphone (toujours composé de chiffres, donc
// toujours représentable) reste lisible et suffit à lui seul à identifier le
// compte de façon unique en cas de fuite.
function safeForWinAnsi(font, text) {
  try {
    font.widthOfTextAtSize(text, 10);
    return text;
  } catch (e) {
    return Array.from(text).map((ch) => (ch.codePointAt(0) <= 0x7e ? ch : '?')).join('');
  }
}

async function watermarkPdf(sourceBytes, { label, timestamp }) {
  const pdfDoc = await PDFDocument.load(sourceBytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const safeLabel = safeForWinAnsi(font, label);
  const tile = `${safeLabel} · ${timestamp}`;

  const pages = pdfDoc.getPages();
  for (const page of pages) {
    const { width, height } = page.getSize();
    // Filigrane rendu visible à l'œil nu (avant : taille 10, opacité 0.12 —
    // quasiment invisible une fois la page compressée en JPEG côté
    // visionneuse sécurisée). Le but d'un filigrane est de dissuader le
    // partage en le rendant visible, pas seulement techniquement présent.
    const fontSize = 13;
    const textWidth = font.widthOfTextAtSize(tile, fontSize);
    const stepX = textWidth + 60;
    const stepY = 85;

    for (let y = -height; y < height * 2; y += stepY) {
      for (let x = -width; x < width * 2; x += stepX) {
        page.drawText(tile, {
          x,
          y,
          size: fontSize,
          font,
          color: rgb(0.6, 0.1, 0.1),
          opacity: 0.28,
          rotate: degrees(-28),
        });
      }
    }
  }

  return pdfDoc.save();
}

module.exports = { watermarkPdf };
