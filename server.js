const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const OpenAI = require('openai').default;
const { PdfReader } = require('pdfreader');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ========================
// PDF TEXT EXTRACTION
// ========================
async function extractTextFromPdf(buffer) {
  try {
    const rawText = await new Promise((resolve, reject) => {
      let pages = [];
      let currentPage = [];
      let lastY = null;

      new PdfReader().parseBuffer(buffer, (err, item) => {
        if (err) return reject(err);
        if (!item) {
          if (currentPage.length) pages.push(currentPage.join('\n'));
          resolve(pages.join('\n\n'));
          return;
        }

        if (item.page) {
          if (currentPage.length) pages.push(currentPage.join('\n'));
          currentPage = [];
          lastY = null;
          return;
        }

        if (item.text) {
          const y = Math.round(item.y * 10);
          if (lastY !== null && Math.abs(y - lastY) > 4) {
            currentPage.push('');
          }
          lastY = y;

          const lastLine = currentPage[currentPage.length - 1] || '';
          if (lastLine === '') {
            currentPage.push(item.text.trim());
          } else {
            currentPage[currentPage.length - 1] += ' ' + item.text.trim();
          }
        }
      });
    });

    const cleanedText = cleanLabText(rawText);

    return {
      text: cleanedText.trim(),
      pages: rawText.split('\n\n').filter(p => p.trim()).length || 1
    };
  } catch (error) {
    throw new Error(`PDF extraction failed: ${error.message}`);
  }
}

function cleanLabText(rawText) {
  let lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  const junkPatterns = [
    /^Laboratoire de Biologie Médicale/i,
    /^LBM /i,
    /^SELAS /i,
    /^Biologistes?/i,
    /^Page \d+/,
    /^Prélevé le /,
    /^Édité le /,
    /^www\./i,
    /^Tél\s*:/i,
    /^Fax\s*:/i,
    /^\d{5}\s+[A-Z]/,
    /^Les informations contenues dans ce document/,
    /^Document confidentiel/,
  ];

  lines = lines.filter(line => !junkPatterns.some(p => p.test(line)));

  return lines.join('\n');
}

// ========================
// ENDPOINTS
// ========================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/extract-pdf-text', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No PDF file provided' });
    const result = await extractTextFromPdf(req.file.buffer);
    res.json({
      success: true,
      text: result.text,
      metadata: { pages: result.pages, textLength: result.text.length },
    });
  } catch (error) {
    console.error('Extraction error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/analyze', upload.single('pdf'), async (req, res) => {
  try {
    let textInput = req.body.text;
    let pdfBuffer = null;
    let fileName = 'analyse_avencio.pdf';

    if (req.file) {
      console.log('Processing PDF:', req.file.originalname);
      const result = await extractTextFromPdf(req.file.buffer);
      textInput = result.text;
      pdfBuffer = req.file.buffer;
      fileName = `analyse_${req.file.originalname}`;

      if (!textInput || textInput.length < 50) {
        return res.status(400).json({ success: false, error: 'Extracted text too short or empty' });
      }
    }

    if (!textInput) {
      return res.status(400).json({ success: false, error: 'No text to analyze' });
    }

    const systemPrompt = `Tu es un assistant pédagogique spécialisé en biologie médicale. Ta mission est d'aider un patient à comprendre les termes figurant sur son compte-rendu d'analyses biologiques en langage simple.

RÈGLES ABSOLUES :
- Explique uniquement CE QUE SONT les analyses (définitions simples)
- NE DONNE JAMAIS d'interprétation médicale
- NE PARLE JAMAIS de diagnostic, maladie, risque ou conséquence
- NE DONNE JAMAIS de conseil médical
- Utilise un langage simple et accessible

DÉTECTION DES VALEURS HORS REPÈRES - SOIS TRÈS RIGOUREUX :
Une valeur est EN DEHORS des repères si et seulement si :
- La valeur numérique est STRICTEMENT INFÉRIEURE au minimum de la référence
- La valeur numérique est STRICTEMENT SUPÉRIEURE au maximum de la référence
- Pour les références avec "< X" : la valeur est >= X
- Pour les références avec "> X" : la valeur est <= X
- Pour les références avec "Inf à X" : la valeur est > X
- Pour les références avec "Sup à X" : la valeur est < X

EXEMPLES CONCRETS :
- Créatinine urinaire 29,23 mmol/L (repères : 5,13 à 14,23) → HORS REPÈRES (29,23 > 14,23)
- Chlore 108 mmol/L (repères : 98 à 107) → HORS REPÈRES (108 > 107)
- Polynucléaires neutrophiles 1,15 Giga/L (repères : 1,50 à 7,50) → HORS REPÈRES (1,15 < 1,50)
- Leucocytes 4,15 Giga/L (repères : 4,05 à 11,00) → DANS LES REPÈRES (4,05 ≤ 4,15 ≤ 11,00)

ATTENTION PARTICULIÈRE :
- Vérifie CHAQUE valeur numériquement
- Ne te fie pas à la position dans le document original
- Compare les nombres avec précision (utilise virgule comme séparateur décimal)

FORMATAGE DES NOMBRES :
- Utilise TOUJOURS la virgule comme séparateur décimal (1,5 et NON 1.5)

STRUCTURE DE RÉPONSE :

================================================================================
COMPRENDRE VOS ANALYSES BIOLOGIQUES
================================================================================

Vue d'ensemble :
Votre bilan comporte [X] analyses au total.
• [Y] valeur(s) dans les repères du laboratoire
• [Z] valeur(s) en dehors des repères du laboratoire

================================================================================
1. VALEURS EN DEHORS DES REPÈRES
================================================================================

[Si aucune valeur hors repères :]
Aucune valeur n'est en dehors des repères habituels du laboratoire.

[Sinon, pour CHAQUE valeur hors repères :]

• [Nom de l'analyse]
  Votre résultat : [valeur avec unité]
  Repères du laboratoire : [intervalle]
  Position : [Au-dessus/En-dessous] des repères
  
  Définition simple :
  [2-3 phrases expliquant CE QUE C'EST - substance, cellule, protéine, etc.
   Exemple : "Les globules rouges sont des cellules présentes dans le sang."]

================================================================================
2. VALEURS DANS LES REPÈRES
================================================================================

[Grouper par catégorie]

--- HÉMATOLOGIE (Cellules du sang)

• [Nom] : [valeur] (repères : [intervalle])
  [Définition courte en 1 phrase]

--- BIOCHIMIE

Fonction rénale :
• [Nom] : [valeur] (repères : [intervalle])
  [Définition courte]

Bilan lipidique :
• [Nom] : [valeur] (repères : [intervalle])
  [Définition courte]

Bilan hépatique :
• [Nom] : [valeur] (repères : [intervalle])
  [Définition courte]

Métabolisme glucidique :
• [Nom] : [valeur] (repères : [intervalle])
  [Définition courte]

--- HORMONOLOGIE (Hormones)

• [Nom] : [valeur] (repères : [intervalle])
  [Définition courte]

--- SÉROLOGIES (Recherche d'infections)

• [Nom] : [résultat] (repères : [intervalle])
  [Définition courte]

--- AUTRES ANALYSES

• [Nom] : [valeur] (repères : [intervalle])
  [Définition courte]

================================================================================
3. RÉSUMÉ
================================================================================

Votre bilan comprend [X] analyses réparties en [liste des catégories].
[Y] valeurs se situent dans les repères du laboratoire.
[Z] valeurs se situent en dehors des repères du laboratoire.

================================================================================
RAPPEL IMPORTANT
================================================================================

Ce document explique les termes de vos analyses de façon pédagogique.
Il ne constitue pas une interprétation médicale.
Pour toute question sur vos résultats, consultez votre médecin.

================================================================================`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { 
          role: 'user', 
          content: `Analyse ces résultats biologiques et explique-les de façon pédagogique.

IMPORTANT : 
- Compare RIGOUREUSEMENT chaque valeur numérique avec sa référence
- Une valeur est hors repères SEULEMENT si elle dépasse STRICTEMENT les limites
- Vérifie particulièrement : Créatinine urinaire, Chlore, Polynucléaires neutrophiles, Cholestérol non-HDL
- Utilise la virgule (,) comme séparateur décimal

Résultats :
${textInput}` 
        },
      ],
      temperature: 0.05,
      max_tokens: 4500,
    });

    const analysisResult = completion.choices[0].message.content.trim();

    let fileBase64 = null;
    if (pdfBuffer) {
      const updatedPdfBuffer = await appendResultsToPdf(pdfBuffer, analysisResult);
      fileBase64 = updatedPdfBuffer.toString('base64');
    }

    res.json({
      success: true,
      analysis: analysisResult,
      fileBase64,
      fileName,
    });
  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Analysis failed',
    });
  }
});

// ========================
// PROFESSIONAL PDF DESIGN WITH GREEN/RED INDICATORS
// ========================
async function appendResultsToPdf(originalPdfBuffer, resultsText) {
  const pdfDoc = await PDFDocument.load(originalPdfBuffer);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italicFont = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  const C = {
    navy: rgb(0.05, 0.20, 0.35),
    blue: rgb(0.15, 0.45, 0.75),
    lightBlue: rgb(0.88, 0.94, 0.98),
    green: rgb(0.11, 0.56, 0.25),
    greenBg: rgb(0.94, 0.98, 0.95),
    greenLight: rgb(0.75, 0.90, 0.80),
    red: rgb(0.78, 0.10, 0.10),
    redBg: rgb(0.99, 0.95, 0.95),
    redLight: rgb(0.95, 0.75, 0.75),
    charcoal: rgb(0.15, 0.15, 0.18),
    gray: rgb(0.35, 0.35, 0.40),
    lightGray: rgb(0.55, 0.55, 0.58),
    silver: rgb(0.88, 0.88, 0.90),
    orange: rgb(0.85, 0.50, 0.10),
    orangeBg: rgb(0.99, 0.97, 0.93),
    white: rgb(1, 1, 1),
  };

  let page = pdfDoc.addPage();
  const { width, height } = page.getSize();
  const margin = 55;
  const maxWidth = width - margin * 2;

  // ========================
  // PREMIUM HEADER
  // ========================
  page.drawRectangle({ 
    x: 0, y: height - 100, width, height: 100, 
    color: C.navy 
  });
  page.drawRectangle({ 
    x: 0, y: height - 105, width, height: 5, 
    color: C.blue 
  });
  
  page.drawText('AVENCIO', { 
    x: margin, y: height - 45, 
    size: 28, font: boldFont, color: C.white 
  });
  page.drawText('HEALTH', { 
    x: margin + 135, y: height - 45, 
    size: 28, font: font, color: C.lightBlue 
  });
  
  page.drawText('Comprendre vos Analyses Biologiques', { 
    x: margin, y: height - 70, 
    size: 10, font: italicFont, color: C.lightBlue 
  });
  
  const today = new Date().toLocaleDateString('fr-FR', { 
    day: '2-digit', month: 'long', year: 'numeric' 
  });
  const dateW = font.widthOfTextAtSize(today, 9);
  
  page.drawRectangle({ 
    x: width - margin - dateW - 25, y: height - 72, 
    width: dateW + 25, height: 24, 
    color: C.blue 
  });
  page.drawText(today, { 
    x: width - margin - dateW - 12, y: height - 65, 
    size: 9, font: font, color: C.white 
  });

  let y = height - 140;

  // ========================
  // TITLE
  // ========================
  page.drawRectangle({ 
    x: margin - 10, y: y - 5, width: 6, height: 32, 
    color: C.blue 
  });
  
  page.drawText('Guide Pedagogique de vos Resultats', { 
    x: margin + 5, y: y, 
    size: 18, font: boldFont, color: C.navy 
  });
  
  page.drawLine({ 
    start: { x: margin + 5, y: y - 8 }, 
    end: { x: margin + 320, y: y - 8 }, 
    thickness: 2, color: C.blue 
  });

  y -= 50;

  // ========================
  // CONTENT RENDERING
  // ========================
  const lines = resultsText.split('\n');
  let inAbnormalSection = false;
  let inNormalSection = false;
  let sectionNum = 0;

  for (let line of lines) {
    line = line.trim();
    
    if (!line || line.includes('====')) continue;

    if (y < margin + 100) {
      page = pdfDoc.addPage();
      y = height - margin - 20;
    }

    let textFont = font;
    let textSize = 10;
    let textColor = C.charcoal;
    let leftPad = 0;
    let extraSpace = 0;
    let drawBox = false;
    let boxColor = C.white;
    let borderColor = null;
    let iconType = null;

    // Detect sections
    if (line.includes('VALEURS EN DEHORS')) {
      inAbnormalSection = true;
      inNormalSection = false;
    } else if (line.includes('VALEURS DANS LES REPÈRES')) {
      inAbnormalSection = false;
      inNormalSection = true;
    } else if (line.includes('RÉSUMÉ') || line.includes('RAPPEL')) {
      inAbnormalSection = false;
      inNormalSection = false;
    }

    // Section headers (1. 2. 3.)
    if (line.match(/^\d+\.\s+[A-ZÉÈÊ]/)) {
      sectionNum++;
      
      const badgeSize = 32;
      const badgeX = margin - 5;
      
      let badgeColor = C.blue;
      if (line.includes('DEHORS')) {
        badgeColor = C.red;
      } else if (line.includes('DANS')) {
        badgeColor = C.green;
      }
      
      page.drawRectangle({ 
        x: badgeX, y: y - 8, 
        width: badgeSize, height: badgeSize, 
        color: badgeColor 
      });
      
      page.drawText(sectionNum.toString(), { 
        x: badgeX + (sectionNum > 9 ? 8 : 11), 
        y: y + 4, 
        size: 16, font: boldFont, color: C.white 
      });
      
      textFont = boldFont;
      textSize = 15;
      textColor = C.navy;
      leftPad = 40;
      extraSpace = 20;
    }
    // Subsections (---)
    else if (line.startsWith('---')) {
      line = line.replace(/^---\s*/, '');
      
      page.drawRectangle({ 
        x: margin + 5, y: y - 6, 
        width: 4, height: 22, 
        color: inNormalSection ? C.green : C.blue 
      });
      
      textFont = boldFont;
      textSize = 12;
      textColor = inNormalSection ? C.green : C.navy;
      leftPad = 18;
      extraSpace = 15;
    }
    // Bullet points (• or test names)
    else if (line.startsWith('•')) {
      line = line.replace(/^•\s*/, '');
      leftPad = 25;
      
      if (inAbnormalSection && !line.toLowerCase().includes('aucune valeur')) {
        drawBox = true;
        boxColor = C.redBg;
        borderColor = C.redLight;
        textColor = C.red;
        textFont = boldFont;
        iconType = 'alert';
        
        if (line.includes(':') && !line.toLowerCase().includes('qu\'est')) {
          textSize = 11;
        }
      } else if (inNormalSection) {
        // Green styling for normal values
        textColor = C.green;
        textFont = boldFont;
        iconType = 'check';
        
        if (line.includes(':')) {
          textSize = 10;
        }
      }
    }
    // Field labels
    else if (line.match(/^(Votre|Repères|Position|Définition)/i)) {
      textFont = boldFont;
      textSize = 9;
      textColor = C.gray;
      leftPad = 30;
      extraSpace = 5;
    }
    // Category labels (ending with :)
    else if (line.match(/^[A-ZÀ-Ÿ].*:$/) && !line.includes('Vue') && leftPad === 0) {
      textFont = boldFont;
      textSize = 10;
      textColor = inNormalSection ? C.green : C.blue;
      leftPad = 15;
      extraSpace = 8;
    }
    // Regular description text
    else if (leftPad === 0) {
      leftPad = 30;
      textSize = 9;
      textColor = C.charcoal;
    }

    // Draw background box for abnormal values
    if (drawBox) {
      const boxH = 22;
      page.drawRectangle({ 
        x: margin, y: y - 6, 
        width: maxWidth, height: boxH, 
        color: boxColor,
        borderColor: borderColor,
        borderWidth: 1.5
      });
    }

    // Draw icon
    if (iconType) {
      const iconX = margin + leftPad - 16;
      const iconY = y + 2;
      
      if (iconType === 'alert') {
        page.drawCircle({ 
          x: iconX, y: iconY, size: 7, 
          color: C.redLight, borderColor: C.red, borderWidth: 1.5 
        });
        page.drawText('!', { 
          x: iconX - 2.5, y: iconY - 3, 
          size: 10, font: boldFont, color: C.red 
        });
      } else if (iconType === 'check') {
        page.drawCircle({ 
          x: iconX, y: iconY, size: 7, 
          color: C.greenLight, borderColor: C.green, borderWidth: 1.5 
        });
        page.drawText('✓', { 
          x: iconX - 3, y: iconY - 3.5, 
          size: 10, font: boldFont, color: C.green 
        });
      }
    }

    // Word wrap
    const words = line.split(' ');
    let currentLine = '';
    const effectiveWidth = maxWidth - leftPad;

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const testWidth = textFont.widthOfTextAtSize(testLine, textSize);
      
      if (testWidth > effectiveWidth && currentLine) {
        page.drawText(currentLine, { 
          x: margin + leftPad, y, 
          size: textSize, font: textFont, color: textColor 
        });
        y -= 15;
        
        if (y < margin + 100) {
          page = pdfDoc.addPage();
          y = height - margin - 20;
        }
        
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    
    if (currentLine) {
      page.drawText(currentLine, { 
        x: margin + leftPad, y, 
        size: textSize, font: textFont, color: textColor 
      });
      y -= 15 + extraSpace;
    }
  }

  // ========================
  // DISCLAIMER
  // ========================
  y -= 50;
  if (y < margin + 120) {
    page = pdfDoc.addPage();
    y = height - margin - 20;
  }

  const disclaimerH = 110;
  
  page.drawRectangle({ 
    x: margin + 4, y: y - disclaimerH + 4, 
    width: maxWidth, height: disclaimerH, 
    color: rgb(0.85, 0.85, 0.87) 
  });
  
  page.drawRectangle({ 
    x: margin, y: y - disclaimerH, 
    width: maxWidth, height: disclaimerH, 
    color: C.orangeBg,
    borderColor: C.orange, borderWidth: 2 
  });
  
  const crossX = margin + 18;
  const crossY = y - 20;
  page.drawRectangle({ 
    x: crossX, y: crossY - 6, width: 2, height: 14, 
    color: C.orange 
  });
  page.drawRectangle({ 
    x: crossX - 5, y: crossY - 1, width: 12, height: 4, 
    color: C.orange 
  });
  
  page.drawText('IMPORTANT : AVERTISSEMENT', { 
    x: margin + 40, y: y - 18, 
    size: 10, font: boldFont, color: C.orange 
  });
  
  const disclaimerLines = [
    'Ce resume a pour objectif d\'aider a comprendre les analyses',
    'figurant sur ce compte-rendu. Il ne constitue pas une interpretation',
    'medicale. Pour toute question concernant vos resultats,',
    'veuillez consulter votre medecin.',
  ];
  
  disclaimerLines.forEach((txt, idx) => {
    page.drawText(txt, { 
      x: margin + 25, y: y - 45 - idx * 14, 
      size: 9, font: font, color: C.gray 
    });
  });

  // ========================
  // FOOTER
  // ========================
  const footerY = 35;
  
  page.drawLine({ 
    start: { x: margin, y: footerY + 18 }, 
    end: { x: width - margin, y: footerY + 18 }, 
    thickness: 1.5, color: C.silver 
  });
  
  page.drawText('Avencio Health', { 
    x: margin, y: footerY, 
    size: 8, font: boldFont, color: C.navy 
  });
  
  const centerText = `Document genere le ${today}`;
  const centerW = font.widthOfTextAtSize(centerText, 7);
  page.drawText(centerText, { 
    x: (width - centerW) / 2, y: footerY, 
    size: 7, font: font, color: C.lightGray 
  });
  
  const pageNum = pdfDoc.getPageCount();
  const pageText = `Page ${pageNum}`;
  const pageW = font.widthOfTextAtSize(pageText, 8);
  page.drawText(pageText, { 
    x: width - margin - pageW, y: footerY, 
    size: 8, font: font, color: C.lightGray 
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

app.listen(PORT, () => {
  console.log(`🚀 Avencio API running on port ${PORT}`);
});
