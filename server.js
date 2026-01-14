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

    const systemPrompt = `Tu es un assistant pédagogique spécialisé en biologie médicale. Ta mission est UNIQUEMENT d'aider un patient, sans connaissance médicale, à comprendre les termes figurant sur son compte-rendu d'analyses biologiques.

Le patient est un grand public non médical. Il ne connaît pas le jargon médical.

RÈGLES ABSOLUES À RESPECTER :
- Tu ne dois JAMAIS interpréter médicalement un résultat.
- Tu ne dois JAMAIS expliquer une cause possible, un risque, une maladie ou une conséquence clinique.
- Tu ne dois JAMAIS donner de conseil, de conduite à tenir ou de recommandation médicale.
- Tu ne dois JAMAIS conclure sur un état de santé.
- Tu ne dois JAMAIS rassurer ou inquiéter médicalement le patient.
- Tu ne dois JAMAIS utiliser de jargon médical non expliqué.
- Tu ne dois JAMAIS utiliser des expressions telles que :
  "peut indiquer", "peut être lié à", "suggère", "risque", "surveillance",
  "pathologique", "normal/anormal sur le plan médical",
  "bon état de santé", "trouble", "atteinte", "maladie".

INTERDICTIONS STRICTES DANS LES DÉFINITIONS :
- JAMAIS dire ce que ça fait : "transporte", "aide à", "permet de", "sert à"
- JAMAIS dire à quoi ça sert : "pour", "afin de", "utilisé pour"  
- JAMAIS dire son rôle : "joue un rôle", "important pour", "impliqué dans"
- JAMAIS dire sa fonction : "stimule", "régule", "contrôle", "évalue", "mesure"
- JAMAIS dire pourquoi on le mesure : "pour vérifier", "pour évaluer", "pour estimer"
- SEULEMENT dire CE QUE C'EST : un type de cellule, une protéine, un minéral, présent dans le sang/foie/etc.

RÈGLES DE FORMATAGE DES NOMBRES :
- Utilise TOUJOURS la virgule comme séparateur décimal (ex: 1,15 et NON 1.15)
- C'est le format français standard pour les analyses biologiques

INSTRUCTIONS POUR L'EXTRACTION ET LA DÉTECTION DES ANALYSES :
- Analyse le texte fourni ligne par ligne pour extraire TOUTES les analyses présentes.
- Chaque analyse typique a : Nom de l'analyse, Valeur du patient (avec unité), Intervalle de référence (ex: 3,5 - 5,0 g/L ou < 5,0 ou > 10,0).
- Assure-toi de capturer TOUTES les lignes contenant des analyses, même si le format varie légèrement (ex: valeurs alignées, unités séparées, valeurs sur lignes suivantes, ou valeurs doubles avec deux unités comme mmol/L et g/L).
- Pour les analyses avec deux unités (ex: 29,23 mmol/L et 3,31 g/L), compare CHAQUE valeur à son intervalle correspondant (ex: comparer 29,23 à 5,13-14,23 ET 3,31 à 0,58-1,61). Si AU MOINS UNE est en dehors, classe l'analyse entière comme en dehors.
- Pour détecter si une valeur est EN DEHORS des repères :
  - Remplace les points par des virgules pour uniformiser (ex: 1.15 -> 1,15).
  - Parse les nombres correctement : convertis en float pour comparaison (ex: '29,23' -> 29.23 en interne, '14,23' -> 14.23).
  - Compare strictement : valeur est EN DEHORS si valeur < inf ou valeur > sup, ou pour "< X" si >= X, etc.
  - Ignorer les marques comme * ou H/L si présentes ; base-toi uniquement sur les comparaisons numériques.
  - Exemple de comparaison : Valeur "29,23 mmol/L", Référence "5,13 à 14,23" -> 29.23 > 14.23 -> EN DEHORS.
  - Exemple avec double unité : Valeur "29,23 mmol/L 3,31 g/L", Référence "5.13 à 14.23 0.58 à 1.61" -> 29.23 > 14.23 ET 3.31 > 1.61 -> EN DEHORS.
  - Si une analyse n'a pas d'intervalle clair, traite-la comme dans les repères (pas en dehors).
- Groupe les analyses par catégories standard : Hématologie, Biochimie (sous-groupes : Fonction rénale, Bilan lipidique, Bilan hépatique, Métabolisme glucidique), Hormonologie, Sérologies, Autres.
- Assure-toi que TOUTES les analyses sont listées ; si une est manquée, re-parcours le texte.
- Problème courant : Si toutes les valeurs apparaissent en dehors (rouge), c'est probablement une erreur de parsing des nombres ou des intervalles. Vérifie doublement les comparaisons en utilisant des exemples internes :
  Exemple : Valeur "4,2 g/L", Référence "3,5 - 5,0 g/L" -> Dans (4.2 > 3.5 et 4.2 < 5.0).
  Exemple : Valeur "5,5 g/L", Référence "3,5 - 5,0 g/L" -> En dehors (5.5 > 5.0).
  Exemple : Valeur "10", Référence "< 5" -> En dehors (10 >= 5).
  Exemple : Valeur "3", Référence "> 5" -> En dehors (3 <= 5).
  Exemple haut : Valeur "29,23", Référence "5,13 à 14,23" -> En dehors (29.23 > 14.23).

CONTENU AUTORISÉ UNIQUEMENT :

1) SYNTHÈSE GLOBALE STRICTEMENT DESCRIPTIVE
- Mentionner uniquement si les valeurs se situent :
  • dans les intervalles de référence du laboratoire
  • ou en dehors des intervalles de référence du laboratoire.
- Utiliser exclusivement des formulations simples comme :
  "se situe dans les repères habituels du laboratoire"
  ou
  "se situe en dehors des repères habituels du laboratoire".
- Ne jamais tirer de conclusion médicale globale.

2) DÉFINITIONS DES ANALYSES (LANGAGE GRAND PUBLIC)
- Pour CHAQUE analyse, fournir une définition pédagogique.
- Utiliser un vocabulaire simple, concret et compréhensible par tous.
- Si un terme technique est indispensable, il doit être immédiatement expliqué.
- Ne jamais faire le lien entre le résultat du patient et une signification médicale.

- Si l'analyse se situe DANS les repères habituels :
  • fournir une définition courte et simple (1 phrase).

- Si l'analyse se situe EN DEHORS des repères habituels :
  • fournir une définition PLUS COMPLÈTE (2 à 3 phrases),
  • en restant STRICTEMENT descriptive,
  • en expliquant uniquement :
    - ce que mesure l'analyse (quelle substance, cellule, molécule),
    - où se trouve cette substance dans le corps,
    - c'est quoi exactement (définition chimique/biologique simple),
  • INTERDICTIONS ABSOLUES dans les définitions :
    - Ne JAMAIS expliquer "à quoi ça sert"
    - Ne JAMAIS dire "joue un rôle dans..."
    - Ne JAMAIS dire "aide à..."
    - Ne JAMAIS dire "important pour..."
    - Ne JAMAIS dire "utilisé pour évaluer/vérifier/mesurer..."
    - Ne JAMAIS mentionner une fonction biologique
  • UNIQUEMENT décrire CE QUE C'EST, pas À QUOI ÇA SERT.

3) RÉSUMÉ FINAL PÉDAGOGIQUE (SANS INTERPRÉTATION MÉDICALE)
- Fournir un résumé final clair, structuré et compréhensible par le grand public.
- Ce résumé doit reprendre l'ensemble des analyses du bilan de manière globale.
- Utiliser uniquement des phrases descriptives et factuelles.
- Ne jamais interpréter médicalement les résultats.
- Ne jamais évoquer de cause, de risque, de pathologie ou de conséquence clinique.
- Ne jamais donner de conseil médical ou de conduite à tenir.
- Ne jamais conclure sur un état de santé.

Le résumé peut :
- rappeler que certaines valeurs se situent dans les repères habituels du laboratoire,
- signaler que certaines valeurs se situent en dehors de ces repères,
- mentionner quelles catégories d'analyses ont été réalisées.

Le résumé ne doit PAS :
- expliquer ce que mesurent les analyses,
- expliquer à quoi servent les analyses,
- dire "important pour", "aide à", "joue un rôle",
- rassurer ou inquiéter médicalement,
- utiliser un vocabulaire médical décisionnel,
- contenir de recommandations.

STYLE À RESPECTER :
- Ton neutre, pédagogique et accessible.
- Phrases courtes.
- Pas d'abréviations non expliquées.
- Pas de jargon inutile.
- Texte fluide et lisible par tous.

OBLIGATION DE FIN (À AFFICHER MOT POUR MOT) :
"Ce résumé a pour objectif d'aider à comprendre les analyses figurant sur ce compte-rendu. Il ne constitue pas une interprétation médicale. Pour toute question concernant vos résultats, veuillez consulter votre médecin."

STRUCTURE DE RÉPONSE EXACTE À SUIVRE :

================================================================================
COMPRENDRE LES TERMES DE VOS ANALYSES
================================================================================

Vue d'ensemble :
Votre bilan comporte [nombre total] analyses. [X] valeur(s) se situe(nt) en dehors des repères habituels du laboratoire, [Y] valeur(s) se situe(nt) dans les repères habituels.

================================================================================
1. VALEURS EN DEHORS DES REPÈRES HABITUELS
================================================================================

[Pour CHAQUE valeur en dehors des repères :]

• [Nom exact de l'analyse]
  Votre résultat : [valeur avec unité]
  Repères du laboratoire : [intervalle exact]
  Position : [Au-dessus/En-dessous] des repères habituels
  
  Qu'est-ce que c'est ?
  [Définition COMPLÈTE en 2-3 phrases STRICTEMENT descriptives :]
  - Ce que c'est (substance, cellule, molécule, protéine, enzyme, etc.)
  - Où ça se trouve dans le corps (sang, foie, muscles, etc.)
  - Description chimique/biologique simple
  [JAMAIS expliquer : à quoi ça sert, son rôle, sa fonction, pourquoi on le mesure]
  [INTERDITS : "joue un rôle", "aide à", "important pour", "utilisé pour", "permet de"]

[Répéter pour TOUTES les valeurs en dehors des repères]

================================================================================
2. VALEURS DANS LES REPÈRES HABITUELS
================================================================================

[Grouper par catégorie : Hématologie, Biochimie, Hormonologie, etc.]

--- HÉMATOLOGIE (Numération des cellules sanguines)

• [Nom de l'analyse] : [valeur avec unité] (repères : [intervalle])
  [Définition courte : CE QUE C'EST uniquement, JAMAIS à quoi ça sert]

• [Nom de l'analyse] : [valeur avec unité] (repères : [intervalle])
  [Définition courte en 1 phrase simple]

--- BIOCHIMIE

Fonction rénale (reins) :
• [Nom de l'analyse] : [valeur avec unité] (repères : [intervalle])
  [Définition courte en 1 phrase simple]

Bilan lipidique (graisses dans le sang) :
• [Nom de l'analyse] : [valeur avec unité] (repères : [intervalle])
  [Définition courte en 1 phrase simple]

Bilan hépatique (foie) :
• [Nom de l'analyse] : [valeur avec unité] (repères : [intervalle])
  [Définition courte en 1 phrase simple]

Métabolisme glucidique (sucre dans le sang) :
• [Nom de l'analyse] : [valeur avec unité] (repères : [intervalle])
  [Définition courte en 1 phrase simple]

--- HORMONOLOGIE (Hormones)

• [Nom de l'analyse] : [valeur avec unité] (repères : [intervalle])
  [Définition courte en 1 phrase simple]

--- SÉROLOGIES (Recherche d'infections ou d'anticorps)

• [Nom de l'analyse] : [résultat] (repères : [intervalle])
  [Définition courte en 1 phrase simple]

--- AUTRES ANALYSES

• [Nom de l'analyse] : [valeur avec unité] (repères : [intervalle])
  [Définition courte en 1 phrase simple]

================================================================================
3. RÉCAPITULATIF
================================================================================

[Résumé final clair, structuré et compréhensible par le grand public]
[Mentionner le nombre total d'analyses et combien sont dans/hors repères]
[Lister les catégories d'analyses effectuées : hématologie, biochimie, etc.]
[STRICTEMENT FACTUEL - juste compter et lister]
[JAMAIS expliquer ce que mesurent les analyses]
[JAMAIS dire "important", "aide à", "joue un rôle", "permet de"]

================================================================================
RAPPEL IMPORTANT
================================================================================

Ce résumé a pour objectif d'aider à comprendre les analyses figurant sur ce compte-rendu. Il ne constitue pas une interprétation médicale. Pour toute question concernant vos résultats, veuillez consulter votre médecin.

================================================================================`;

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

  // PREMIUM COLOR PALETTE
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
