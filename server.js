const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const OpenAI = require('openai').default;
const PDFExtract = require('pdf.js-extract').PDFExtract;
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const pdfExtract = new PDFExtract();

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Configure multer for file uploads (50MB limit)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
  },
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Extract text from PDF buffer with deduplication
async function extractTextFromPdf(buffer) {
  try {
    const data = await pdfExtract.extractBuffer(buffer);
    
    let allPagesText = [];
    
    // Extract text from each page separately
    for (const page of data.pages) {
      const pageText = page.content
        .map(item => item.str)
        .filter(text => text.trim().length > 0)
        .join(' ');
      allPagesText.push(pageText);
    }
    
    // Detect and remove repeating headers/footers
    const cleanedText = removeRepeatingHeaders(allPagesText);
    
    return {
      text: cleanedText.trim(),
      pages: data.pages.length
    };
  } catch (error) {
    throw new Error(`PDF extraction failed: ${error.message}`);
  }
}

// Remove repeating headers and footers from pages
function removeRepeatingHeaders(pagesText) {
  if (pagesText.length < 2) {
    return pagesText.join('\n\n');
  }

  // Find common text at the beginning (headers) and end (footers) of pages
  const firstPageLines = pagesText[0].split(/\s+/).slice(0, 100); // First 100 words
  const secondPageLines = pagesText[1].split(/\s+/).slice(0, 100);
  
  // Find longest common prefix (header)
  let headerLength = 0;
  for (let i = 0; i < Math.min(firstPageLines.length, secondPageLines.length); i++) {
    if (firstPageLines[i] === secondPageLines[i]) {
      headerLength = i + 1;
    } else {
      break;
    }
  }
  
  // Be conservative - only remove if we found at least 10 matching words
  const shouldRemoveHeader = headerLength >= 10;
  
  // Clean each page
  let cleanedPages = pagesText.map((pageText, index) => {
    let words = pageText.split(/\s+/);
    
    // Remove header from all pages except first (keep first page as reference)
    if (shouldRemoveHeader && index > 0) {
      words = words.slice(headerLength);
    }
    
    return words.join(' ');
  });
  
  // Additional: Remove lines that appear on every page (like lab name, address)
  const cleanedText = removeDuplicateLines(cleanedPages);
  
  return cleanedText;
}

// Remove lines that appear identically on multiple pages
function removeDuplicateLines(pagesText) {
  if (pagesText.length < 2) {
    return pagesText.join('\n\n');
  }
  
  const allPages = pagesText.join('\n\n===PAGE_BREAK===\n\n');
  
  // Common patterns in French medical lab headers
  const headerPatterns = [
    /Laboratoire de Biologie Médicale/gi,
    /LBM [A-Z\s]+/gi,
    /\d{5}\s+[A-Z\-]+/gi, // Postal codes and city names
    /Tél\s*:\s*[\d\.\s]+/gi,
    /Fax\s*:\s*[\d\.\s]+/gi,
    /www\.[a-z]+\.fr/gi,
    /SELAS [A-Z\s]+/gi,
    /Biologistes co-responsables/gi,
    /Page \d+ sur \d+/gi,
    /Page \d+ \/ \d+/gi,
    /Prélevé le \d{2}\/\d{2}\/\d{2}/gi,
    /Édité le .+ \d{4}/gi,
    /Les informations contenues dans ce document/gi,
  ];
  
  let cleaned = allPages;
  
  // Remove header patterns
  headerPatterns.forEach(pattern => {
    cleaned = cleaned.replace(pattern, '');
  });
  
  // Remove excessive whitespace
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  cleaned = cleaned.replace(/\s{3,}/g, ' ');
  
  // Remove page break markers
  cleaned = cleaned.replace(/===PAGE_BREAK===/g, '\n\n');
  
  return cleaned.trim();
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// PDF Text Extraction Endpoint
app.post('/api/extract-pdf-text', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        error: 'No PDF file provided' 
      });
    }

    console.log('📄 Extracting text from PDF:', {
      filename: req.file.originalname,
      size: `${(req.file.size / 1024 / 1024).toFixed(2)} MB`,
    });

    const result = await extractTextFromPdf(req.file.buffer);

    if (!result.text || result.text.length < 10) {
      return res.status(400).json({
        success: false,
        error: 'PDF appears to be empty or text could not be extracted',
      });
    }

    console.log('✅ Text extracted successfully:', {
      pages: result.pages,
      textLength: result.text.length,
    });

    res.json({
      success: true,
      text: result.text,
      metadata: {
        pages: result.pages,
        textLength: result.text.length,
      },
    });
  } catch (error) {
    console.error('❌ PDF extraction error:', error);
    res.status(500).json({
      success: false,
      error: `PDF extraction failed: ${error.message}`,
    });
  }
});

// Main Analysis Endpoint
app.post('/api/analyze', upload.single('pdf'), async (req, res) => {
  try {
    let textInput = req.body.text;
    let pdfBuffer = null;
    let fileName = 'analyse_avencio.pdf';

    // If PDF file is provided, extract text from it
    if (req.file) {
      console.log('📄 Processing PDF file:', req.file.originalname);
      
      const result = await extractTextFromPdf(req.file.buffer);
      textInput = result.text;
      pdfBuffer = req.file.buffer;
      fileName = `analyse_${req.file.originalname}`;

      console.log('✅ Extracted text from', result.pages, 'pages');

      if (!textInput || textInput.length < 10) {
        return res.status(400).json({
          success: false,
          error: 'PDF appears to be empty or text could not be extracted',
        });
      }
    }

    if (!textInput || textInput.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No text to analyze',
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        success: false,
        error: 'OPENAI_API_KEY not configured',
      });
    }

    console.log('🤖 Sending to OpenAI for analysis...');
    console.log('📊 Text length:', textInput.length, 'characters');

    const systemPrompt = `You are analyzing French medical lab results. Extract ALL test data from the input and generate a comprehensive, patient-friendly summary.

IMPORTANT: The PDF may contain MULTIPLE categories of tests (hématologie, biochimie, hormonologie, sérologies, etc.). You MUST analyze ALL of them.

Follow this EXACT structure:

Comprendre vos résultats

[Count all abnormal results first, then write:]
[If there are abnormal results:]
Votre bilan comporte [X] résultat(s) en dehors des valeurs habituelles sur l'ensemble des analyses réalisées.

[If all results are normal:]
L'ensemble de vos résultats sont dans les valeurs habituelles. Votre bilan est globalement satisfaisant.

[Only include this section if there are abnormal results:]

Résultats en dehors des valeurs de référence :

[Group by category if multiple categories exist:]

Hématologie (Numération sanguine) :
• [Test name] : [au-dessus/en-dessous] de la valeur habituelle ([actual value] [unit], référence : [min]-[max] [unit])

Biochimie :
• [Test name] : [au-dessus/en-dessous] de la valeur habituelle ([actual value] [unit], référence : [min]-[max] [unit])

[Continue for all categories with abnormal results...]

À quoi correspondent ces analyses ?

[For EACH abnormal result, provide explanation:]
• [Test name] : [2-3 sentence detailed explanation in simple French about what this test measures, what it does in the body, and what the result indicates. Be educational but not alarming.]

[If there are many normal results in important categories, mention them briefly:]

Autres analyses dans les normes :
Vos analyses concernant [list important normal categories: fonction rénale, fonction hépatique, glycémie, etc.] sont toutes dans les valeurs habituelles.

En résumé :
[Write 3-4 sentences that:]
1. Give an overall assessment of the health picture
2. Mention if abnormalities are minor or significant
3. Connect related abnormal results together if applicable
4. End with reassurance about discussing with doctor

Un bilan biologique doit toujours être interprété dans son ensemble. Votre médecin est la personne compétente pour interpréter ces résultats en tenant compte de votre état de santé général.

CRITICAL RULES:
- ANALYZE EVERY SECTION of the lab report (don't skip categories)
- Use bullet points (•) for all lists
- ALWAYS include actual values AND reference ranges with units
- Group results by medical category (Hématologie, Biochimie, etc.)
- Provide detailed 2-3 sentence explanations for EACH abnormal result
- Mention important normal results briefly
- Count total abnormal results accurately
- Use simple, clear French medical terminology
- Be thorough but not overwhelming
- Do NOT diagnose or give medical advice
- Do NOT mention potential causes or treatments
- Do NOT add extra headers or branding
- Focus on education and clarity

OUTPUT ONLY THE FORMATTED SUMMARY - NO EXTRA TEXT BEFORE OR AFTER.`;

    // Call OpenAI API using official SDK
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Here are the extracted lab results:\n\n${textInput}` },
      ],
      temperature: 0.7,
      max_tokens: 3000, // Increased for complex reports with multiple test categories
    });

    const analysisResult = completion.choices[0].message.content;

    console.log('✅ Analysis complete');

    // If PDF was provided, append results to it
    let fileBase64 = null;
    if (pdfBuffer) {
      console.log('📝 Appending results to PDF...');
      const updatedPdfBuffer = await appendResultsToPdf(pdfBuffer, analysisResult);
      fileBase64 = updatedPdfBuffer.toString('base64');
      console.log('✅ PDF annotated successfully');
    }

    res.json({
      success: true,
      analysis: analysisResult,
      fileBase64: fileBase64 || undefined,
      fileName: fileName,
    });
  } catch (error) {
    console.error('❌ Analysis error:', error);
    console.error('❌ Stack:', error.stack);
    
    const errorMessage = error.message?.includes('API key') || error.message?.includes('Incorrect API key')
      ? 'Invalid or missing OpenAI API key'
      : error.message?.includes('network') || error.message?.includes('Failed to fetch')
      ? 'Network error connecting to OpenAI'
      : `Analysis failed: ${error.message}`;

    res.status(500).json({
      success: false,
      error: errorMessage,
    });
  }
});

// PDF Annotation Function
async function appendResultsToPdf(originalPdfBuffer, resultsText) {
  console.log('📝 appendResultsToPdf called, resultsText length:', resultsText.length);

  const pdfDoc = await PDFDocument.load(originalPdfBuffer);
  console.log('📄 PDF loaded, pages:', pdfDoc.getPageCount());

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

  // Medical Header Bar
  page.drawRectangle({
    x: 0,
    y: height - 100,
    width: width,
    height: 100,
    color: rgb(0.02, 0.08, 0.16),
  });

  page.drawText('AVENCIO HEALTH', {
    x: margin,
    y: height - 55,
    size: 22,
    font: boldFont,
    color: rgb(1, 1, 1),
  });

  page.drawText('Synthèse Pédagogique des Résultats Biologiques', {
    x: margin,
    y: height - 80,
    size: 11,
    font: font,
    color: rgb(0.6, 0.8, 1),
  });

  let currentY = height - 140;

  // Title
  page.drawText('Note Explicative Personnalisée', {
    x: margin,
    y: currentY,
    size: titleSize,
    font: boldFont,
    color: rgb(0.02, 0.08, 0.16),
  });
  currentY -= 30;

  // Confidentiality banner
  page.drawRectangle({
    x: margin,
    y: currentY - 5,
    width: maxWidth,
    height: 22,
    color: rgb(0.95, 0.97, 1),
    borderColor: rgb(0.8, 0.85, 1),
    borderWidth: 0.5,
  });
  page.drawText('Document confidentiel - Généré pour usage informatif uniquement', {
    x: margin + 10,
    y: currentY + 3,
    size: 8,
    font: font,
    color: rgb(0.3, 0.4, 0.6),
  });
  currentY -= 40;

  // Process the analysis text
  const lines = resultsText.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    if (!line) {
      currentY -= lineHeight * 0.5;
      continue;
    }

    // Check if we need a new page
    if (currentY < margin + 80) {
      const newPage = pdfDoc.addPage();
      currentY = height - margin;
    }

    // Determine text style based on content
    let textFont = font;
    let textSize = fontSize;
    let textColor = rgb(0.1, 0.1, 0.15);
    let extraSpacing = 0;

    // Section headers (e.g., "Comprendre vos résultats", "Résultats en dehors...", "À quoi correspondent...")
    if (line.includes(':') && line.length < 80 && !line.startsWith('•')) {
      textFont = boldFont;
      textSize = sectionSize;
      textColor = rgb(0.02, 0.08, 0.16);
      extraSpacing = 5;
    }
    // Bullet points
    else if (line.startsWith('•')) {
      textFont = font;
      textSize = fontSize;
    }
    // Regular text
    else {
      textFont = font;
      textSize = fontSize;
    }

    // Word wrap for long lines
    const words = line.split(' ');
    let currentLine = '';
    
    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const testWidth = textFont.widthOfTextAtSize(testLine, textSize);
      
      if (testWidth > maxWidth && currentLine) {
        // Draw current line
        page.drawText(currentLine, {
          x: margin,
          y: currentY,
          size: textSize,
          font: textFont,
          color: textColor,
        });
        currentY -= lineHeight;
        currentLine = word;
        
        // Check for new page
        if (currentY < margin + 80) {
          const newPage = pdfDoc.addPage();
          currentY = height - margin;
        }
      } else {
        currentLine = testLine;
      }
    }
    
    // Draw remaining text
    if (currentLine) {
      page.drawText(currentLine, {
        x: margin,
        y: currentY,
        size: textSize,
        font: textFont,
        color: textColor,
      });
      currentY -= lineHeight + extraSpacing;
    }
  }

  // Disclaimer section
  currentY -= 30;
  if (currentY < 150) {
    const newPage = pdfDoc.addPage();
    currentY = height - margin;
  }

  page.drawRectangle({
    x: margin,
    y: currentY - 60,
    width: maxWidth,
    height: 70,
    color: rgb(0.98, 0.98, 0.98),
    borderColor: rgb(0.9, 0.9, 0.9),
    borderWidth: 1,
  });

  const disclaimer = [
    'Important : Un bilan biologique doit toujours être interprété dans son ensemble.',
    'Votre médecin traitant est la seule personne habilitée à poser un diagnostic',
    'en fonction de votre historique clinique et de vos symptômes.',
  ];

  disclaimer.forEach((line, idx) => {
    page.drawText(line, {
      x: margin + 15,
      y: currentY - 18 - idx * 15,
      size: 8.5,
      font: font,
      color: rgb(0.4, 0.4, 0.4),
    });
  });

  // Footer
  const footerY = 30;
  page.drawLine({
    start: { x: margin, y: footerY + 15 },
    end: { x: width - margin, y: footerY + 15 },
    thickness: 0.5,
    color: rgb(0.8, 0.8, 0.8),
  });

  const today = new Date().toLocaleDateString('fr-FR', { 
    day: '2-digit', 
    month: 'long', 
    year: 'numeric' 
  });

  page.drawText(`Généré par Avencio Health le ${today}`, {
    x: margin,
    y: footerY,
    size: 7,
    font: font,
    color: rgb(0.6, 0.6, 0.6),
  });

  page.drawText(`Page ${pdfDoc.getPageCount()}`, {
    x: width - margin - 40,
    y: footerY,
    size: 7,
    font: font,
    color: rgb(0.6, 0.6, 0.6),
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    error: err.message || 'Internal server error',
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Express API server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`📍 Analyze endpoint: http://localhost:${PORT}/api/analyze`);
});