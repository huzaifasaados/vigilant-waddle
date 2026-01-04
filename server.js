const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const OpenAI = require('openai').default;
const { PdfReader } = require('pdfreader'); // ← NEW: much better for lab reports
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Configure multer (50MB limit)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ========================
// IMPROVED PDF TEXT EXTRACTION
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
          // End of PDF
          if (currentPage.length) pages.push(currentPage.join('\n'));
          resolve(pages.join('\n\n'));
          return;
        }

        if (item.page) {
          // Save previous page
          if (currentPage.length) pages.push(currentPage.join('\n'));
          currentPage = [];
          lastY = null;
          return;
        }

        if (item.text) {
          const y = Math.round(item.y * 10); // Group by vertical position
          if (lastY !== null && Math.abs(y - lastY) > 4) {
            currentPage.push(''); // Significant Y change = new line
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

// Smart cleanup: remove headers, footers, junk
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
    /^\d{5}\s+[A-Z]/, // postal code + city
    /^Les informations contenues dans ce document/,
    /^Document confidentiel/,
  ];

  lines = lines.filter(line => !junkPatterns.some(p => p.test(line)));

  // Fix common font/OCR issues
  lines = lines.map(line =>
    line
      .replace(/O/g, '0') // O → 0
      .replace(/l/g, '1') // lowercase L → 1
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

    // ========================
    // NEW STRICT PROMPT (as you requested)
    // ========================
  const systemPrompt = `You are analyzing French medical lab results. Your task is to extract ALL test data precisely and generate a clear, patient-friendly summary in French.

EXTRACTION RULES (CRITICAL):
- Extract EVERY test name, patient value, unit, and reference range from the entire report.
- Pay extreme attention to French number formatting: use commas as decimals (e.g., 1,15 not 1.15).
- A result is ABNORMAL if:
  - Value < lower limit
  - Value > upper limit
  - Reference is "< X" and value ≥ X
  - Reference is "> X" and value ≤ X
  - Reference is "Inf à X" and value > X
- Include calculated values (e.g., Cholestérol non-HDL, D.F.G., Rapport albuminurie/créatininurie) if provided.

RESPONSE STRUCTURE (FOLLOW EXACTLY, NO DEVIATIONS):

Comprendre vos résultats

[If there are abnormal results:]
Votre bilan est globalement proche des valeurs habituelles, avec quelques résultats en dehors des repères du laboratoire.

[If ALL results are normal:]
L'ensemble de vos résultats sont dans les valeurs habituelles.

[ONLY if there are abnormal results:]

Résultats à noter :
• [Exact test name] : au-dessus de la valeur habituelle ([value with unit], référence : [exact range as in PDF])
• [Exact test name] : en-dessous de la valeur habituelle ([value with unit], référence : [exact range as in PDF])

À quoi correspondent ces analyses ?
• [Exact test name] : [ONE short, factual sentence describing what the marker measures in the body. No interpretation, no health impact, no causes.]

En résumé :
Votre bilan présente [exact number] valeur(s) en dehors des repères habituels du laboratoire concernant [list of abnormal markers separated by ", " and "et" before the last one].
L'ensemble des autres analyses se situe dans les valeurs de référence.
Un bilan biologique doit toujours être interprété dans son ensemble. Votre médecin est la personne compétente pour évaluer ces résultats dans le contexte global de votre santé.

Un bilan biologique doit toujours être interprété dans son ensemble. Votre médecin est la personne compétente pour interpréter ces résultats.

CRITICAL RULES (DO NOT VIOLATE):
- List ALL abnormal results — never omit any
- NEVER list or mention normal results
- NEVER add sections like "Autres analyses dans les normes"
- NEVER group by category (Hématologie, Biochimie, etc.)
- Use exact test names from the PDF (e.g., "Polynucléaires neutrophiles", "Cholestérol non-HDL", "Créatinine urinaire")
- Preserve units exactly (Giga/L, mmol/L, etc.)
- Use French comma decimals in values and ranges
- The "En résumé" section is REQUIRED and must follow the exact 3-sentence structure above
- NO medical interpretation, diagnosis, advice, or speculation
- NO words like "légèrement", "mineur", "important", "peut indiquer", "préoccupant"
- OUTPUT ONLY the formatted summary — no extra text, no explanations, no JSON`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Here are the extracted lab results:\n\n${textInput}` },
      ],
      temperature: 0.2, // Lowered for consistency
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
// PDF ANNOTATION (unchanged - your design)
// ========================
async function appendResultsToPdf(originalPdfBuffer, resultsText) {
  const pdfDoc = await PDFDocument.load(originalPdfBuffer);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const page = pdfDoc.addPage();
  const { width, height } = page.getSize();

  const margin = 50;
  const maxWidth = width - margin * 2;
  const lineHeight = 16;
  const fontSize = 10;
  const titleSize = 18;
  const sectionSize = 14;

  // Header bar
  page.drawRectangle({ x: 0, y: height - 100, width, height: 100, color: rgb(0.02, 0.08, 0.16) });
  page.drawText('AVENCIO HEALTH', { x: margin, y: height - 55, size: 22, font: boldFont, color: rgb(1, 1, 1) });
  page.drawText('Synthèse Pédagogique des Résultats Biologiques', { x: margin, y: height - 80, size: 11, font: font, color: rgb(0.6, 0.8, 1) });

  let currentY = height - 140;

  page.drawText('Note Explicative Personnalisée', { x: margin, y: currentY, size: titleSize, font: boldFont, color: rgb(0.02, 0.08, 0.16) });
  currentY -= 30;

  // Confidentiality banner
  page.drawRectangle({ x: margin, y: currentY - 5, width: maxWidth, height: 22, color: rgb(0.95, 0.97, 1), borderColor: rgb(0.8, 0.85, 1), borderWidth: 0.5 });
  page.drawText('Document confidentiel - Généré pour usage informatif uniquement', { x: margin + 10, y: currentY + 3, size: 8, font: font, color: rgb(0.3, 0.4, 0.6) });
  currentY -= 50;

  // Write results with word wrap
  const lines = resultsText.split('\n');
  for (let line of lines) {
    line = line.trim();
    if (!line) { currentY -= lineHeight * 0.5; continue; }

    if (currentY < margin + 100) {
      const newPage = pdfDoc.addPage();
      currentY = height - margin;
      page = newPage; // switch reference
    }

    let textFont = font;
    let textSize = fontSize;
    let textColor = rgb(0.1, 0.1, 0.15);
    let extraSpacing = 0;

    if (line.includes(':') && line.length < 80 && !line.startsWith('•')) {
      textFont = boldFont;
      textSize = sectionSize;
      textColor = rgb(0.02, 0.08, 0.16);
      extraSpacing = 5;
    }

    // Word wrap
    const words = line.split(' ');
    let currentLine = '';
    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const testWidth = textFont.widthOfTextAtSize(testLine, textSize);
      if (testWidth > maxWidth && currentLine) {
        page.drawText(currentLine, { x: margin, y: currentY, size: textSize, font: textFont, color: textColor });
        currentY -= lineHeight;
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) {
      page.drawText(currentLine, { x: margin, y: currentY, size: textSize, font: textFont, color: textColor });
      currentY -= lineHeight + extraSpacing;
    }
  }

  // Disclaimer
  currentY -= 30;
  page.drawRectangle({ x: margin, y: currentY - 60, width: maxWidth, height: 70, color: rgb(0.98, 0.98, 0.98), borderColor: rgb(0.9, 0.9, 0.9), borderWidth: 1 });
  const disclaimer = [
    'Important : Un bilan biologique doit toujours être interprété dans son ensemble.',
    'Votre médecin traitant est la seule personne habilitée à poser un diagnostic',
    'en fonction de votre historique clinique et de vos symptômes.',
  ];
  disclaimer.forEach((l, i) => {
    page.drawText(l, { x: margin + 15, y: currentY - 18 - i * 15, size: 8.5, font: font, color: rgb(0.4, 0.4, 0.4) });
  });

  // Footer
  const footerY = 30;
  page.drawLine({ start: { x: margin, y: footerY + 15 }, end: { x: width - margin, y: footerY + 15 }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
  const today = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  page.drawText(`Généré par Avencio Health le ${today}`, { x: margin, y: footerY, size: 7, font: font, color: rgb(0.6, 0.6, 0.6) });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

// ========================
app.listen(PORT, () => {
  console.log(`🚀 Avencio API running on port ${PORT}`);
});
