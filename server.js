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
  lines = lines.map(line =>
    line
      .replace(/O/g, '0')
      .replace(/l/g, '1')
      .replace(/\s+/g, ' ')
      .trim()
  );

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

    const systemPrompt = `You are a medical laboratory analysis expert. Your task is to provide a COMPLETE, COMPREHENSIVE educational summary of ALL lab results in French - both normal AND abnormal values.

EXTRACTION RULES (CRITICAL):
- Extract EVERY SINGLE test from the report - skip nothing
- Include test name, patient value, unit, and reference range for ALL tests
- Pay extreme attention to French number formatting: use commas as decimals (e.g., 1,15 not 1.15)
- A result is ABNORMAL if:
  - Value < lower limit
  - Value > upper limit  
  - Reference is "< X" and value ≥ X
  - Reference is "> X" and value ≤ X
  - Reference is "Inf à X" and value > X
- Include ALL calculated values (Cholestérol non-HDL, D.F.G., ratios, etc.)

RESPONSE STRUCTURE (FOLLOW EXACTLY):

================================================================================
COMPRENDRE VOS RÉSULTATS - ANALYSE COMPLÈTE
================================================================================

Vue d'ensemble :
Votre bilan comporte [total number] analyses. [X] valeur(s) se situe(nt) en dehors des repères du laboratoire, tandis que [Y] valeur(s) sont dans les normes habituelles.

================================================================================
1. RÉSULTATS EN DEHORS DES VALEURS HABITUELLES
================================================================================

[For EACH abnormal result:]

• [Exact test name] : [au-dessus/en-dessous] de la valeur habituelle
  Votre résultat : [value with unit]
  Référence : [exact range as in PDF]
  
  Explication détaillée :
  [3-5 sentences explaining:]
  - What this biomarker is (definition, chemical nature)
  - What it measures and its role in the body
  - What biological processes it reflects
  - Where it comes from or how it's produced
  - Its importance in health monitoring
  - How it's used clinically (without diagnosing)

[Repeat for ALL abnormal results]

================================================================================
2. RÉSULTATS DANS LES VALEURS HABITUELLES
================================================================================

[Group by category: Hématologie, Biochimie, Hormonologie, etc.]

--- HÉMATOLOGIE (Numération globulaire)

• [Test name] : [value with unit] (réf: [range])
  [1-2 sentences: What it is and what it measures]

• [Test name] : [value with unit] (réf: [range])
  [1-2 sentences: What it is and what it measures]

[Continue for all hematology tests]

--- BIOCHIMIE

Fonction rénale :
• [Test name] : [value with unit] (réf: [range])
  [1-2 sentences explaining the marker]

Bilan lipidique :
• [Test name] : [value with unit] (réf: [range])
  [1-2 sentences explaining the marker]

Bilan hépatique :
• [Test name] : [value with unit] (réf: [range])
  [1-2 sentences explaining the marker]

Métabolisme glucidique :
• [Test name] : [value with unit] (réf: [range])
  [1-2 sentences explaining the marker]

[Continue for all biochemistry subcategories]

--- HORMONOLOGIE

• [Test name] : [value with unit] (réf: [range])
  [1-2 sentences explaining the marker]

--- SÉROLOGIES

• [Test name] : [result] (réf: [range])
  [1-2 sentences explaining what this test detects]

--- AUTRES ANALYSES

• [Test name] : [value with unit] (réf: [range])
  [1-2 sentences explaining the marker]

================================================================================
3. SYNTHÈSE GLOBALE
================================================================================

État général du bilan :
[3-4 sentences providing a holistic view:]
- Overall picture of the lab results
- How the different categories look collectively
- Any patterns or relationships between normal results
- Educational context about what these results represent together

Résultats nécessitant une attention :
[If abnormal results exist, provide 2-3 sentences connecting them, explaining what categories they belong to, WITHOUT medical interpretation]

Résultats rassurants :
[2-3 sentences highlighting the normal categories, what they indicate about general health markers being monitored]

================================================================================
RAPPEL IMPORTANT
================================================================================

Un bilan biologique doit toujours être interprété dans son ensemble et dans le contexte de votre état de santé général. Seul votre médecin traitant peut poser un diagnostic et évaluer la signification clinique de ces résultats en fonction de votre historique médical, de vos symptômes et de votre situation personnelle.

Cette analyse est fournie à titre purement éducatif et informatif.

================================================================================`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Here are the extracted lab results:\n\n${textInput}` },
      ],
      temperature: 0.2,
      max_tokens: 3000,
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
// ULTIMATE PROFESSIONAL PDF DESIGN
// ========================
async function appendResultsToPdf(originalPdfBuffer, resultsText) {
  const pdfDoc = await PDFDocument.load(originalPdfBuffer);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italicFont = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  // PREMIUM COLOR PALETTE
  const C = {
    // Primary Brand Colors
    navy: rgb(0.05, 0.20, 0.35),           // Deep professional navy
    blue: rgb(0.15, 0.45, 0.75),           // Vibrant medical blue
    lightBlue: rgb(0.88, 0.94, 0.98),      // Soft blue background
    
    // Status Colors
    green: rgb(0.11, 0.56, 0.25),          // Success green
    greenBg: rgb(0.94, 0.98, 0.95),        // Light green tint
    greenLight: rgb(0.75, 0.90, 0.80),     // Medium green
    
    red: rgb(0.78, 0.10, 0.10),            // Alert red
    redBg: rgb(0.99, 0.95, 0.95),          // Light red tint
    redLight: rgb(0.95, 0.75, 0.75),       // Medium red
    
    orange: rgb(0.85, 0.50, 0.10),         // Warning orange
    orangeBg: rgb(0.99, 0.97, 0.93),       // Light orange tint
    
    // Neutral Palette
    charcoal: rgb(0.15, 0.15, 0.18),       // Dark text
    gray: rgb(0.35, 0.35, 0.40),           // Medium gray
    lightGray: rgb(0.55, 0.55, 0.58),      // Light gray text
    silver: rgb(0.88, 0.88, 0.90),         // Border gray
    offWhite: rgb(0.98, 0.98, 0.99),       // Background
    white: rgb(1, 1, 1),                   // Pure white
  };

  let page = pdfDoc.addPage();
  const { width, height } = page.getSize();
  const margin = 55;
  const maxWidth = width - margin * 2;

  // ========================
  // PREMIUM HEADER DESIGN
  // ========================
  
  // Main header background (gradient effect with two rectangles)
  page.drawRectangle({ 
    x: 0, y: height - 100, width, height: 100, 
    color: C.navy 
  });
  page.drawRectangle({ 
    x: 0, y: height - 105, width, height: 5, 
    color: C.blue 
  });
  
  // Brand identity
  page.drawText('AVENCIO', { 
    x: margin, y: height - 45, 
    size: 28, font: boldFont, color: C.white 
  });
  page.drawText('HEALTH', { 
    x: margin + 135, y: height - 45, 
    size: 28, font: font, color: C.lightBlue 
  });
  
  // Tagline
  page.drawText('Analyse Medicale Pedagogique', { 
    x: margin, y: height - 70, 
    size: 10, font: italicFont, color: C.lightBlue 
  });
  
  // Date badge (right side)
  const today = new Date().toLocaleDateString('fr-FR', { 
    day: '2-digit', month: 'long', year: 'numeric' 
  });
  const dateStr = today;
  const dateW = font.widthOfTextAtSize(dateStr, 9);
  
  page.drawRectangle({ 
    x: width - margin - dateW - 25, y: height - 72, 
    width: dateW + 25, height: 24, 
    color: C.blue 
  });
  page.drawText(dateStr, { 
    x: width - margin - dateW - 12, y: height - 65, 
    size: 9, font: font, color: C.white 
  });

  let y = height - 140;

  // ========================
  // DOCUMENT TITLE SECTION
  // ========================
  
  // Title box with side accent
  page.drawRectangle({ 
    x: margin - 10, y: y - 5, width: 6, height: 32, 
    color: C.blue 
  });
  
  page.drawText('Synthese de vos Resultats Biologiques', { 
    x: margin + 5, y: y, 
    size: 18, font: boldFont, color: C.navy 
  });
  
  // Decorative underline
  page.drawLine({ 
    start: { x: margin + 5, y: y - 8 }, 
    end: { x: margin + 320, y: y - 8 }, 
    thickness: 2, color: C.blue 
  });

  y -= 50;

  // ========================
  // CONFIDENTIALITY NOTICE
  // ========================
  
  const noticeH = 32;
  page.drawRectangle({ 
    x: margin, y: y - noticeH, 
    width: maxWidth, height: noticeH, 
    color: C.lightBlue, 
    borderColor: C.blue, borderWidth: 1 
  });
  
  // Lock symbol using ASCII
  page.drawRectangle({ 
    x: margin + 12, y: y - 20, width: 8, height: 8, 
    color: C.navy, borderColor: C.navy, borderWidth: 1 
  });
  page.drawRectangle({ 
    x: margin + 14, y: y - 16, width: 4, height: 4, 
    color: C.lightBlue 
  });
  
  page.drawText('DOCUMENT CONFIDENTIEL', { 
    x: margin + 30, y: y - 18, 
    size: 9, font: boldFont, color: C.navy 
  });
  page.drawText('- A usage strictement personnel et informatif', { 
    x: margin + 175, y: y - 18, 
    size: 8, font: font, color: C.gray 
  });

  y -= 60;

  // ========================
  // SMART CONTENT RENDERING
  // ========================
  
  const lines = resultsText.split('\n');
  let sectionNum = 0;
  let inAbnormal = false;
  let inNormal = false;
  let inSynthesis = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    
    if (!line) { 
      y -= 8; 
      continue; 
    }

    // Page break check
    if (y < margin + 100) {
      page = pdfDoc.addPage();
      y = height - margin - 20;
    }

    // Skip separator lines
    if (line.includes('====')) continue;

    let textFont = font;
    let textSize = 10;
    let textColor = C.charcoal;
    let leftPad = 0;
    let extraSpace = 0;
    let drawBox = false;
    let boxColor = C.white;
    let borderColor = null;
    let iconType = null;

    // ========================
    // SECTION HEADERS (1. 2. 3.)
    // ========================
    if (line.match(/^\d+\.\s+[A-ZÉÈÊ]/)) {
      sectionNum++;
      
      // Draw section badge
      const badgeSize = 32;
      const badgeX = margin - 5;
      
      // Badge background
      page.drawRectangle({ 
        x: badgeX, y: y - 8, 
        width: badgeSize, height: badgeSize, 
        color: C.blue 
      });
      
      // Badge number
      page.drawText(sectionNum.toString(), { 
        x: badgeX + (sectionNum > 9 ? 8 : 11), 
        y: y + 4, 
        size: 16, font: boldFont, color: C.white 
      });
      
      // Section title
      textFont = boldFont;
      textSize = 15;
      textColor = C.navy;
      leftPad = 40;
      extraSpace = 20;
      
      // Detect section type
      if (line.includes('DEHORS')) {
        inAbnormal = true;
        inNormal = false;
        inSynthesis = false;
        iconType = 'alert';
      } else if (line.includes('DANS')) {
        inAbnormal = false;
        inNormal = true;
        inSynthesis = false;
        iconType = 'check';
      } else if (line.includes('SYNTH')) {
        inAbnormal = false;
        inNormal = false;
        inSynthesis = true;
        iconType = 'info';
      }
    }
    
    // ========================
    // SUBSECTION HEADERS (---)
    // ========================
    else if (line.startsWith('---')) {
      line = line.replace(/^---\s*/, '');
      
      // Vertical accent bar
      page.drawRectangle({ 
        x: margin + 5, y: y - 6, 
        width: 4, height: 22, 
        color: C.blue 
      });
      
      textFont = boldFont;
      textSize = 12;
      textColor = C.navy;
      leftPad = 18;
      extraSpace = 15;
    }
    
    // ========================
    // TEST RESULTS (•)
    // ========================
    else if (line.startsWith('•') || line.startsWith('*')) {
      line = line.replace(/^[•*]\s*/, '');
      leftPad = 25;
      
      // Style based on section
      if (inAbnormal) {
        drawBox = true;
        boxColor = C.redBg;
        borderColor = C.redLight;
        textColor = C.red;
        textFont = boldFont;
        iconType = 'alert';
        
        // Check if this is a test name line (contains ":")
        if (line.includes(':') && !line.toLowerCase().includes('explication')) {
          textSize = 11;
        }
      } else if (inNormal) {
        textColor = C.green;
        iconType = 'check';
        
        if (line.includes(':') && !line.toLowerCase().includes('explication')) {
          textFont = boldFont;
          textSize = 10;
        }
      } else {
        iconType = 'bullet';
      }
    }
    
    // ========================
    // SUBSUB CATEGORIES (e.g., "Fonction renale :")
    // ========================
    else if (line.match(/^[A-ZÉÈÊ].*:$/) && !line.startsWith('Vue') && !line.startsWith('Etat')) {
      textFont = boldFont;
      textSize = 10;
      textColor = C.blue;
      leftPad = 15;
      extraSpace = 10;
    }
    
    // ========================
    // VALUE LABELS (Votre resultat:, Reference:)
    // ========================
    else if ((line.match(/^(Votre|Reference|Explication)/i)) && line.includes(':')) {
      textFont = font;
      textSize = 9;
      textColor = C.gray;
      leftPad = 30;
    }
    
    // ========================
    // EXPLANATION TEXT
    // ========================
    else if (leftPad === 0 && i > 0) {
      leftPad = 30;
      textColor = C.gray;
      textSize = 9;
    }

    // ========================
    // DRAW BACKGROUND BOX
    // ========================
    if (drawBox) {
      const boxH = 20;
      page.drawRectangle({ 
        x: margin, y: y - 6, 
        width: maxWidth, height: boxH, 
        color: boxColor,
        borderColor: borderColor || C.silver,
        borderWidth: 1
      });
    }

    // ========================
    // DRAW ICON
    // ========================
    if (iconType) {
      const iconX = margin + leftPad - 16;
      const iconY = y + 2;
      
      if (iconType === 'alert') {
        // Red circle with exclamation
        page.drawCircle({ 
          x: iconX, y: iconY, size: 7, 
          color: C.redLight, borderColor: C.red, borderWidth: 1.5 
        });
        page.drawText('!', { 
          x: iconX - 2.5, y: iconY - 3, 
          size: 10, font: boldFont, color: C.red 
        });
      } else if (iconType === 'check') {
        // Green checkmark
        page.drawCircle({ 
          x: iconX, y: iconY, size: 7, 
          color: C.greenBg, borderColor: C.green, borderWidth: 1.5 
        });
        page.drawText('+', { 
          x: iconX - 3, y: iconY - 3, 
          size: 11, font: boldFont, color: C.green 
        });
      } else if (iconType === 'bullet') {
        // Simple bullet
        page.drawCircle({ 
          x: iconX, y: iconY, size: 3, 
          color: C.blue 
        });
      } else if (iconType === 'info') {
        // Info circle
        page.drawCircle({ 
          x: iconX, y: iconY, size: 7, 
          color: C.lightBlue, borderColor: C.blue, borderWidth: 1.5 
        });
        page.drawText('i', { 
          x: iconX - 2, y: iconY - 3, 
          size: 9, font: italicFont, color: C.blue 
        });
      }
    }

    // ========================
    // WORD WRAP AND RENDER
    // ========================
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
        y -= 16;
        
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
      y -= 16 + extraSpace;
    }
  }

  // ========================
  // PREMIUM DISCLAIMER BOX
  // ========================
  
  y -= 50;
  if (y < margin + 140) {
    page = pdfDoc.addPage();
    y = height - margin - 20;
  }

  const disclaimerH = 110;
  
  // Shadow
  page.drawRectangle({ 
    x: margin + 4, y: y - disclaimerH + 4, 
    width: maxWidth, height: disclaimerH, 
    color: rgb(0.85, 0.85, 0.87) 
  });
  
  // Main box
  page.drawRectangle({ 
    x: margin, y: y - disclaimerH, 
    width: maxWidth, height: disclaimerH, 
    color: C.orangeBg,
    borderColor: C.orange, borderWidth: 2 
  });
  
  // Medical cross icon
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
  
  // Title
  page.drawText('IMPORTANT : AVERTISSEMENT MEDICAL', { 
    x: margin + 40, y: y - 18, 
    size: 10, font: boldFont, color: C.orange 
  });
  
  // Content
  const disclaimerText = [
    'Ce document est genere a titre educatif et informatif uniquement.',
    'Un bilan biologique doit toujours etre interprete par votre medecin traitant',
    'dans le contexte global de votre sante, vos symptomes et votre historique medical.',
    'Seul un professionnel de sante est habilite a poser un diagnostic medical.',
  ];
  
  disclaimerText.forEach((txt, idx) => {
    page.drawText(txt, { 
      x: margin + 25, y: y - 45 - idx * 14, 
      size: 9, font: font, color: C.gray 
    });
  });

  // ========================
  // PROFESSIONAL FOOTER
  // ========================
  
  const footerY = 35;
  
  // Separator line
  page.drawLine({ 
    start: { x: margin, y: footerY + 18 }, 
    end: { x: width - margin, y: footerY + 18 }, 
    thickness: 1.5, color: C.silver 
  });
  
  // Left: Brand
  page.drawText('Avencio Health', { 
    x: margin, y: footerY, 
    size: 8, font: boldFont, color: C.navy 
  });
  
  // Center: Date
  const centerText = `Document genere le ${today}`;
  const centerW = font.widthOfTextAtSize(centerText, 7);
  page.drawText(centerText, { 
    x: (width - centerW) / 2, y: footerY, 
    size: 7, font: font, color: C.lightGray 
  });
  
  // Right: Page number
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

// ========================
app.listen(PORT, () => {
  console.log(`🚀 Avencio API running on port ${PORT}`);
});
