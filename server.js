const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const OpenAI = require('openai').default;
const { PdfReader } = require('pdfreader');
require('dotenv').config();
const axios =require ('axios')
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
async function getSystemPrompt() {
  const res = await axios.get("https://labresultsanalysis.vercel.app/api/prompt");
  return res.data?.success ? res.data.prompt : "";
}
    // const systemPrompt = ``;//use there so 
    const systemPrompt = await getSystemPrompt(); // 🔥 THIS WAS MISSING
    console.log(systemPrompt)

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Voici les résultats d'analyses biologiques à expliquer de façon pédagogique (SANS interprétation médicale) :\n\n${textInput}` },
      ],
      temperature: 0.1,  // Reduced for more consistent parsing
      max_tokens: 3500,
    });

    const analysisResult = completion.choices[0].message.content.trim();

    let fileBase64 = null;
    if (pdfBuffer) {
      const updatedPdfBuffer = await appendResultsToPdf(pdfBuffer, analysisResult, textInput);
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
async function appendResultsToPdf(originalPdfBuffer, resultsText, textInput) {
  const pdfDoc = await PDFDocument.load(originalPdfBuffer);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italicFont = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  // PREMIUM COLOR PALETTE UPDATED TO MATCH CERBALLIANCE
  const C = {
    navy: rgb(0.05, 0.20, 0.35),
    blue: rgb(0, 209/255, 220/255), // #00D1DC Robin's Egg Blue from Cerballiance brand
    lightBlue: rgb(0.88, 0.94, 0.98),
    green: rgb(0.11, 0.56, 0.25),
    greenBg: rgb(0.94, 0.98, 0.95),
    greenLight: rgb(0.75, 0.90, 0.80),
    red: rgb(0.78, 0.10, 0.10),
    redBg: rgb(0.99, 0.95, 0.95),
    redLight: rgb(0.95, 0.75, 0.75),
    orange: rgb(0.85, 0.50, 0.10),
    orangeBg: rgb(0.99, 0.97, 0.93),
    charcoal: rgb(0.15, 0.15, 0.18),
    gray: rgb(0.35, 0.35, 0.40),
    lightGray: rgb(0.55, 0.55, 0.58),
    silver: rgb(0.88, 0.88, 0.90),
    offWhite: rgb(0.98, 0.98, 0.99),
    white: rgb(1, 1, 1),
  };

  let page = pdfDoc.addPage();
  const { width, height } = page.getSize();
  const margin = 55;
  const maxWidth = width - margin * 2;

  // Parse report date from textInput
  let dateStr = 'Date inconnue';
  const editDateMatch = textInput.match(/Édité le (\d+) (\w+) (\d{4})/);
  if (editDateMatch) {
    const day = parseInt(editDateMatch[1], 10);
    const monthStr = editDateMatch[2].toLowerCase();
    const year = parseInt(editDateMatch[3], 10);
    const months = {
      janvier: 0, février: 1, mars: 2, avril: 3, mai: 4, juin: 5,
      juillet: 6, août: 7, septembre: 8, octobre: 9, novembre: 10, décembre: 11
    };
    const month = months[monthStr];
    if (month !== undefined) {
      const editDate = new Date(year, month, day);
      dateStr = editDate.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    }
  }

  // ========================
  // PREMIUM HEADER DESIGN
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
  // CONFIDENTIALITY NOTICE
  // ========================
  
  const noticeH = 32;
  page.drawRectangle({ 
    x: margin, y: y - noticeH, 
    width: maxWidth, height: noticeH, 
    color: C.lightBlue, 
    borderColor: C.blue, borderWidth: 1 
  });
  
  page.drawRectangle({ 
    x: margin + 12, y: y - 20, width: 8, height: 8, 
    color: C.navy, borderColor: C.navy, borderWidth: 1 
  });
  page.drawRectangle({ 
    x: margin + 14, y: y - 16, width: 4, height: 4, 
    color: C.lightBlue 
  });
  
  page.drawText('DOCUMENT PEDAGOGIQUE', { 
    x: margin + 30, y: y - 18, 
    size: 9, font: boldFont, color: C.navy 
  });
  page.drawText('- Aide a la comprehension des termes medicaux', { 
    x: margin + 165, y: y - 18, 
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
  let inRecap = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    
    if (!line) { 
      y -= 8; 
      continue; 
    }

    if (y < margin + 100) {
      page = pdfDoc.addPage();
      y = height - margin - 20;
    }

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
    // SECTION HEADERS
    // ========================
    if (line.match(/^\d+\.\s+[A-ZÉÈÊ]/)) {
      sectionNum++;
      
      const badgeSize = 32;
      const badgeX = margin - 5;
      
      page.drawRectangle({ 
        x: badgeX, y: y - 8, 
        width: badgeSize, height: badgeSize, 
        color: C.blue 
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
      
      if (line.includes('DEHORS')) {  // Fixed: removed || 'REPÈRES' to avoid matching normal section
        inAbnormal = true;
        inNormal = false;
        inRecap = false;
        iconType = 'alert';
      } else if (line.includes('DANS')) {
        inAbnormal = false;
        inNormal = true;
        inRecap = false;
        iconType = 'check';
      } else if (line.includes('RÉCAPITULATIF') || line.includes('RECAPITULATIF')) {
        inAbnormal = false;
        inNormal = false;
        inRecap = true;
        iconType = 'info';
      }
    }
    
    // ========================
    // SUBSECTION HEADERS
    // ========================
    else if (line.startsWith('---')) {
      line = line.replace(/^---\s*/, '');
      
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
    // TEST RESULTS
    // ========================
    else if (line.startsWith('•') || line.startsWith('*') || line.startsWith('-')) {
      line = line.replace(/^[•*-]\s*/, '');
      leftPad = 25;
      
      if (inAbnormal) {
        drawBox = true;
        boxColor = C.redBg;
        borderColor = C.redLight;
        textColor = C.red;
        textFont = boldFont;
        iconType = 'alert';
        
        if (line.includes(':') && !line.toLowerCase().includes('qu\'est')) {
          textSize = 11;
        }
      } else if (inNormal) {
        textColor = C.green;
        iconType = 'check';
        
        if (line.includes(':')) {
          textFont = boldFont;
          textSize = 10;
        }
      } else if (inRecap) {
        textColor = C.charcoal;
        iconType = 'bullet';
      } else {
        iconType = 'bullet';
      }
    }
    
    // ========================
    // CATEGORY LABELS
    // ========================
    else if (line.match(/^[A-ZÉÈÊ].*:$/) && !line.startsWith('Vue') && !line.startsWith('Nombre') && !line.startsWith('Catégories')) {
      textFont = boldFont;
      textSize = 10;
      textColor = C.blue;
      leftPad = 15;
      extraSpace = 10;
    }
    
    // ========================
    // VALUE LABELS AND SUBSECTIONS
    // ========================
    else if (line.match(/^(Votre|Repères|Position|Qu'est-ce|Nombre|Valeurs|Catégories)/i) && line.includes(':')) {
      if (line.match(/^Qu'est-ce/i)) {
        textFont = boldFont;
        textSize = 9;
        textColor = C.navy;
        leftPad = 30;
        extraSpace = 5;
      } else {
        textFont = font;
        textSize = 9;
        textColor = C.gray;
        leftPad = 30;
      }
    }
    
    // ========================
    // DEFINITION TEXT
    // ========================
    else if (leftPad === 0 && i > 0 && !line.match(/^[A-ZÉÈÊ][A-ZÉÈÊ]/)) {
      leftPad = 30;
      textColor = C.charcoal;
      textSize = 9;
    }
    
    // ========================
    // OVERRIDE: Fix color for normal section content
    // ========================
    if (inNormal && !line.startsWith('•') && !line.startsWith('*') && !line.startsWith('-') && !line.includes('---') && leftPad > 0) {
      textColor = C.charcoal;  // Reset to normal text color for definitions
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
          color: C.greenBg, borderColor: C.green, borderWidth: 1.5 
        });
        page.drawText('+', { 
          x: iconX - 3, y: iconY - 3, 
          size: 11, font: boldFont, color: C.green 
        });
      } else if (iconType === 'bullet') {
        page.drawCircle({ 
          x: iconX, y: iconY, size: 3, 
          color: C.blue 
        });
      } else if (iconType === 'info') {
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
  // DISCLAIMER BOX
  // ========================
  
  y -= 50;
  if (y < margin + 140) {
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
  
  const disclaimerText = [
    'Ce resume a pour objectif d\'aider a comprendre les analyses',
    'figurant sur ce compte-rendu. Il ne constitue pas une interpretation',
    'medicale. Pour toute question concernant vos resultats,',
    'veuillez consulter votre medecin.',
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
  
  page.drawLine({ 
    start: { x: margin, y: footerY + 18 }, 
    end: { x: width - margin, y: footerY + 18 }, 
    thickness: 1.5, color: C.silver 
  });
  
  page.drawText('Avencio Health', { 
    x: margin, y: footerY, 
    size: 8, font: boldFont, color: C.navy 
  });
  
  const centerText = `Document genere le ${dateStr}`;
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

// ========================
app.listen(PORT, () => {
  console.log(`🚀 Avencio API running on port ${PORT}`);
});
