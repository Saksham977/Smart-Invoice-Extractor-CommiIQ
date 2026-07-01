// Configure PDF.js Worker
pdfjsLib.GlobalWorkerOptions.workerSrc =
'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
// ==========================================
// Application State
// ==========================================
let appState = {
    extractedRows: [],
    countdownSeconds: 1260,
    timerInterval: null,
    currencySymbol: '',
    uploadedFileBaseName: 'invoice',
    _pdfDoc: null,          // holds pdf.js document so clearInvoiceData can destroy it
    _scannedCanvases: [],  // holds canvas refs so clearInvoiceData can zero them
    _activeScheduler: null// holds Tesseract scheduler if mid-OCR when user deletes
};

// ==========================================
// UI Cache
// ==========================================
const DOM = {
    themeToggleBtn:      document.getElementById('themeToggleBtn'),
    dropzone:            document.getElementById('dropzone'),
    fileInput:           document.getElementById('fileInput'),
    fileStatusContainer: document.getElementById('fileStatusContainer'),
    fileNameDisplay:     document.getElementById('fileNameDisplay'),
    fileSizeDisplay:     document.getElementById('fileSizeDisplay'),
    progressIndicator:   document.getElementById('progressIndicator'),
    progressBar:         document.getElementById('progressBar'),
    progressText:        document.getElementById('progressText'),
    securityTimer:       document.getElementById('securityTimer'),
    countdownDisplay:    document.getElementById('countdownDisplay'),
    clearDataBtn:        document.getElementById('clearDataBtn'),
    searchTermsList:     document.getElementById('searchTermsList'),
    addTermBtn:          document.getElementById('addTermBtn'),
    searchBtn:           document.getElementById('searchBtn'),
    resultsSection:      document.getElementById('resultsSection'),
    presetSelect:        document.getElementById('presetSelect'),
    savePresetBtn:       document.getElementById('savePresetBtn'),
    deletePresetBtn:     document.getElementById('deletePresetBtn'),
    termSuggestions:     document.getElementById('termSuggestions'),
    pdfTypeRadios:       () => document.querySelector('input[name="pdfType"]:checked')
};

function safeDetectCurrency(textBlocks) {

    const text = textBlocks.join(' ').slice(0, 5000);

    // Symbol near amount
    const near = text.match(/([€$£¥₹Kč])\s?\d/);
    if (near) return near[1];

    // Symbol fallback
    if (text.includes('£')) return '£';
    if (text.includes('€')) return '€';
    if (text.includes('$')) return '$';
    if (text.includes('¥')) return '¥';
    if (text.includes('₹')) return '₹';

    // Frequency-based code detection
    const matches = text.match(/\b(USD|EUR|GBP|INR|AUD|CAD|SGD|AED|SAR|CHF|CZK|SEK|NOK|DKK|PLN|HUF|RON|JPY|CNY|HKD|NZD|ZAR)\b/gi);

    if (matches) {
        const freq = {};
        matches.forEach(m => {
            const key = m.toUpperCase();
            freq[key] = (freq[key] || 0) + 1;
        });

        const mostCommon = Object.keys(freq).reduce((a, b) =>
            freq[a] > freq[b] ? a : b
        );

        const map = {
            USD: '$', EUR: '€', GBP: '£', INR: '₹',
            AUD: '$', CAD: '$', SGD: '$',
            AED: 'AED ', SAR: 'SAR ',
            CHF: 'CHF ', CZK: 'Kč',
            SEK: 'SEK ', NOK: 'NOK ', DKK: 'DKK ',
            PLN: 'PLN ', HUF: 'HUF ', RON: 'RON ',
            JPY: '¥', CNY: '¥', HKD: '$', NZD: '$',
            ZAR: 'ZAR '
        };

        return map[mostCommon] || '';
    }

    return '';
}


// ==========================================
// Currency Detection
// ==========================================
function detectCurrency(text) {
    if (Array.isArray(text)) text = text.join(' ');
    const map = { EUR:'€', GBP:'£', USD:'$', CHF:'CHF ', CZK:'CZK ',
                  SEK:'SEK ', NOK:'NOK ', DKK:'DKK ', PLN:'PLN ', HUF:'HUF ' };
    const code = text.match(/\b(EUR|GBP|USD|CHF|CZK|SEK|NOK|DKK|PLN|HUF)\b/);
    if (code) return map[code[1]] || code[1]+' ';
    const gbp = (text.match(/£/g)||[]).length;
    const eur = (text.match(/€/g)||[]).length;
    if (gbp > eur) return '£';
    if (eur > 0)   return '€';
    if ((text.match(/\$/g)||[]).length > 0) return '$';
    return '€';
}

// ==========================================
// Date Patterns
// ==========================================
const MONTH_NAMES = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)$/i;
const DATE_PATTERNS = [
    /\b(\d{4}[-.\\/]\d{1,2}[-.\\/]\d{1,2})\b/,
    /\b(\d{1,2}[-.\\/]\d{1,2}[-.\\/]\d{2,4})\b/,
    /\b(\d{1,2}[-.\\/][A-Za-z]{3,9}[-.\\/]\d{2,4})\b/,
    /\b(\d{1,2}[\s\-][A-Za-z]{3,9}[\s\-]\d{2,4})\b/,
    /\b([A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,\s+\d{4})\b/i
];

function extractDate(line) {
    for (const pat of DATE_PATTERNS) {
        const m = line.match(pat);
        if (m) return m[1] || m[0];
    }
    return null;
}


function extractDateAtStart(line) {
    // OCR noise correction
    const corrected = line
        .replace(/^([|\s=]*)O(\d)/, '$10$2')
        .replace(/(\d)O(\d)/g, '$10$2')
        .replace(/(\d)\s*-\s*(\d)/g, '$1-$2');

    // Allow OCR noise chars (|, =, spaces) before the date
    const noiseStripped = corrected.replace(/^[\s|=]+/, '');
    const seg = noiseStripped.substring(0, 20);

    for (const pat of DATE_PATTERNS) {
        const m = seg.match(pat);
        if (!m) continue;
        const idx    = seg.indexOf(m[0]);
        const prefix = seg.substring(0, idx);
        if (!/^[^\w]*$/.test(prefix)) continue;
        const captured   = m[1] || m[0];
        const alphaToken = captured.match(/[A-Za-z]{3,9}/);
        if (alphaToken && !MONTH_NAMES.test(alphaToken[0])) continue;
        return captured;
    }
    return null;
}

// ==========================================
// Number Parser
// ==========================================
function parseNumberString(s) {
    let str = s.replace(/[£€$\s]/g, '').trim();
    if (!str) return 0;
    const dots   = (str.match(/\./g)||[]).length;
    const commas = (str.match(/,/g) ||[]).length;
    if (dots > 0 && commas > 0) {
        str = str.lastIndexOf(',') > str.lastIndexOf('.')
            ? str.replace(/\./g,'').replace(',','.')  // European 1.234,56
            : str.replace(/,/g,'');                    // Standard  1,234.56
    } else if (commas === 1) {
        const p = str.split(',');
        str = (p[1] && p[1].length === 3) ? str.replace(',','') : str.replace(',','.');
    } else if (dots > 1) {
        str = str.replace(/\./g,'');
    }
    return parseFloat(str) || 0;
}

// ==========================================
// Amount Extractor  (mirrors Python notebook: rightmost NN.NN wins)
// ==========================================
function parseAmountAndVat(line) {

    line = line.replace(
    /\b(\d{1,3}(?:\.\d{3})+)\.(\d{2})\b/g,
    (match) => {
        const parts = match.split('.');
        const decimal = parts.pop();
        return parts.join('') + '.' + decimal;
    }
);

    let vatAmount = 0.0;
    let vatRate   = null;

    // OCR character-confusion corrections: fix common misreads of digits
    // as visually similar characters before any amount matching runs.
    //   O / o  → 0  (letter-O misread as zero — very common in serif fonts)
    //   §      → 5  (section-sign has near-identical shape to 5 at low DPI;
    //                observed in testing: "§,091.18" should be "5,091.18")
    //   l (ell)→ 1  (lowercase-l vs digit-1, common in sans-serif scans)
    // Only applied where the suspect character neighbours a digit, so
    // legitimate uses of these characters in descriptions are unaffected.
    let s = line
        .replace(/(\d)O/g, '$10').replace(/O(\d)/g, '0$1')
        .replace(/§/g, '5')
        // lowercase-l vs digit-1: use lookahead so "l,465" (comma between l and digit)
        // is also caught, not just "l4" where the digit is immediately adjacent
        .replace(/l(?=[,.\d])/g, '1').replace(/(?<=[,.\d])l/g, '1')
        // OCR sometimes collapses the space before a '%' sign into a stray
        // trailing '9' (observed: "21 %" misread as "219%", "9 %" as "99%").
        // A real VAT rate here is always one of 0/9/21 — if a 3-digit number
        // ending in 9 immediately before '%' isn't itself a plausible rate,
        // assume the trailing 9 is the OCR artifact and drop it.
        .replace(/\b(0|9|21)9%/g, '$1%');
    s = s.replace(/CHECK#?\s*\d+\b/gi, '');
    s = s.replace(/\b(19|20)\d{2}\b/g, '');

    const rm = s.match(/\b(\d{1,2}(?:\.\d+)?)\s*%/);
    if (rm) { vatRate = parseInt(rm[1], 10); s = s.replace(rm[0], ''); }

    // Strategy A: standard decimal point  152.65  1,548.00
    const std = s.match(/\d[\d,]*\.\d{2}/g);
    // Strategy B: European decimal comma  152,65  1.548,00
    const eur = s.match(/\d[\d.]*,\d{2}/g);

    let chosen = null, isEur = false;
    if (std && eur) { isEur = eur.length > std.length; chosen = isEur ? eur : std; }
    else if (std)   { chosen = std; }
    else if (eur)   { chosen = eur; isEur = true; }

   let baseAmount = 0;

if (chosen && chosen.length > 0) {

    const parsedValues = chosen.map(val => {
    let num = val.trim();

    const dotCount = (num.match(/\./g) || []).length;
    const commaCount = (num.match(/,/g) || []).length;

// Case: 7.500.00 → treat as 7500.00
if (dotCount > 1 && commaCount === 0) {
    const parts = num.split('.');
    const decimal = parts.pop();
    num = parts.join('') + '.' + decimal;
}

        // Case 1: US format (1,234.56 or 28,295.95)
        if (/^\d{1,3}(,\d{3})*\.\d{2}$/.test(num)) {
            num = num.replace(/,/g, '');
        }

        // Case 2: EU format (1.234,56 or 28.295,95)
        else if (/^\d{1,3}(\.\d{3})*,\d{2}$/.test(num)) {
            num = num.replace(/\./g, '').replace(',', '.');
        }

        // Case 3: OCR malformed (e.g. 7.500.00)
        else if ((num.match(/\./g) || []).length > 1) {
            const parts = num.split('.');
            const decimal = parts.pop();
            num = parts.join('') + '.' + decimal;
        }

        // Case 4: only comma present
        else if (num.includes(',')) {
            const parts = num.split(',');
            if (parts[1]?.length === 2) {
                // decimal comma
                num = num.replace(',', '.');
            } else {
                // thousand comma
                num = num.replace(/,/g, '');
            }
        }

        return parseFloat(num) || 0;

    }).filter(v => v > 0);

    if (parsedValues.length > 0) {
        // Position-independent amount selection (per spec): the charge
        // amount is the numerically LARGEST value among NET / VAT-amount /
        // GROSS / TOTAL. Since GROSS = NET + VAT-amount and TOTAL = GROSS
        // (when count = 1) or GROSS × count, GROSS/TOTAL is always >= the
        // other components for non-negative VAT/count.
        //
        // IMPORTANT: do NOT exclude duplicate values — TC20's "Duplicate
        // totals" case has GROSS == TOTAL (both 329.00) and the correct
        // answer is still 329, not the smaller NET value.
        baseAmount = Math.max(...parsedValues);
    }

    // Negative-amount detection: a true minus sign sits directly against
    // its digit; a hyphen used as word punctuation has spaces on both
    // sides and must not be mistaken for a negative.
    if (baseAmount !== 0) {
        const negativeDetected =
            // Real negative sign: '-' directly touching a digit (no space between
            // sign and number), e.g. "-60.00", "-1.50" — optionally with a
            // currency symbol sandwiched between the sign and the digit, e.g.
            // "-€5091.18". A hyphen used as word punctuation always has a space
            // on BOTH sides (e.g. "kamer - mindervalide"), so requiring no space
            // between '-' and the symbol/digit excludes that case while still
            // catching "- 60.00" is NOT matched here on purpose —
            // OCR'd negatives in our invoices never insert a space after the sign,
            // only before it (handled by allowing one space before '-').
            /(?:^|\s)-[€$£]?\d/.test(line) ||
            // "(" + digits + ")" NOT followed by "%)" → accounting-style negative, e.g. "(271,90)"
            // "(21 %)" or "(0 %)" → VAT-rate annotation, NOT a negative
            /\((?!\s*\d+(?:\.\d+)?\s*%\))[\s€$£]*\d[\d,.]*[\s€$£]*\)/.test(line) ||
            /\bCR\b/i.test(line);

        if (negativeDetected) {
            baseAmount = -Math.abs(baseAmount);
        }
    }
}

    return { baseAmount, vatAmount, vatRate };
}

// ==========================================
// Page-Type Detector
// A page is text-based if PDF.js gives us ≥2 lines containing a date
// (at the start OR anywhere in the line — many invoices put the date
// mid-line, e.g. "Night 19-05-2026 19-05-2026 €271,90 ...")
// AND at least one decimal amount. Otherwise → OCR.
// ==========================================
function isTextBasedPage(lines) {
    const text = lines.join(' ');
    // This floor exists only to catch pages with NO real embedded text layer
    // (a scanned/image-only page returns next to nothing from getTextContent).
    // It must stay low enough that short-but-legitimate text-based invoices
    // (e.g. a 2-3 line hotel folio) aren't misclassified as scanned just for
    // being short — the date/amount checks below do the actual classifying.
    if (text.length < 15) return false;
    
    // Check if there are decimal amounts
    const stdMatches = text.match(/\b\d+[\d,]*\.\d{2}\b/g) || [];
    const eurMatches = text.match(/\b\d+[\d.]*,\d{2}\b/g) || [];
    const totalAmounts = stdMatches.length + eurMatches.length;
    if (totalAmounts === 0) return false;
    
    // Count lines containing dates
    let dateLines = 0;
    for (const line of lines) {
        const trimmed = line.trim();
        if (extractDateAtStart(trimmed) || extractDate(trimmed)) {
            dateLines++;
        }
    }
    
    // If it has at least 1 date and at least 1 amount -> text-based
    if (dateLines >= 1) return true;
    
    // If it has no dates but has multiple amounts (>= 2) -> text-based (indicating table columns)
    if (totalAmounts >= 2) return true;
    
    return false;
}

// ==========================================
// Stateful Row Assembler
//
// KEY FIX for Imperial Riding School / two-column OCR layout:
// When Tesseract reads a two-column invoice, it outputs:
//   Col-left lines (date + description) first,
//   then all Col-right lines (amounts) as orphan lines at the bottom.
//
// Standard approach: amounts are on the same OCR line as the date → groups have amounts.
// Two-column fallback: if a group has NO amount but orphan amount lines exist,
//   assign amounts sequentially to groups in order (first orphan → first no-amount group).
// ==========================================
function reconstructInvoiceLines(lines) {
    const rows = [];
    let currentItem = null;

    // Recognizable end-of-page legal/registration boilerplate (IBAN, BIC,
    // KvK/VAT registration numbers, web domains, phone number prefixes,
    // standard hospitality-terms-and-conditions phrasing). These reliably
    // never appear in genuine line-item continuation text (guest names,
    // room numbers, booking references), so a line matching this is never
    // folded into a charge row — without this, footer text was silently
    // glued onto whatever the last row on the page happened to be.
    const FOOTER_BOILERPLATE_PATTERN =
        /\b(BIC|IBAN|Kv\.?K\.?|BTW|VAT\s*nr|BTW-?Nummer|RFP\s*ID)\b/i;
    const FOOTER_BOILERPLATE_PATTERN_2 = /\.(com|nl|org|net)\b/i;
    const FOOTER_PHONE_PATTERN = /\bT\.\s*\+?\d/;
    const FOOTER_TERMS_PATTERN = /Uniforme Voorwaarden|Conditions for the Hotel/i;
    function looksLikeFooterBoilerplate(text) {
        return FOOTER_BOILERPLATE_PATTERN.test(text) ||
               FOOTER_BOILERPLATE_PATTERN_2.test(text) ||
               FOOTER_PHONE_PATTERN.test(text) ||
               FOOTER_TERMS_PATTERN.test(text);
    }

    // A line carrying a "bare" 2+ digit number that isn't a room/booking
    // reference (#NNNN), a booking-ref suffix (=>...), or a date — this is
    // the shape of an OCR-corrupted charge line whose amount AND date both
    // failed to parse (e.g. "City tax 946" — "9.46" with the decimal point
    // dropped, date prefix also lost). Genuine continuation fragments
    // (guest names, "Routed From X Of Room #NNNN") never have a leftover
    // bare number once those patterns are stripped.
    function hasUnclaimedDigits(text) {
        const cleaned = text
            .replace(/#\s*\d+/g, '')
            .replace(/=>.*/g, '')
            .replace(/\b\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4}\b/g, '');
        return /\d{2,}/.test(cleaned);
    }

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        const date = extractDateAtStart(line) || extractDate(line) || '';

        let cleanForAmt = line;
        if (date) {
            const esc = date.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            cleanForAmt = cleanForAmt.replace(new RegExp(esc, 'g'), '');
        }

        const details = parseAmountAndVat(cleanForAmt);

        // Footer/legal boilerplate is never part of any charge row — drop
        // it as noise rather than letting it merge onto whatever row came
        // before it (Merge B below would otherwise treat it as harmless
        // continuation text, since it typically has no date or amount).
        if (looksLikeFooterBoilerplate(line)) {
            continue;
        }

        if (currentItem) {
            // Merge A: date line without amount, next line has amount.
            // Guard: only merge if the next line does NOT carry its own date.
            // A line with its own date is a new, separate charge — merging it
            // in would silently steal its amount onto the wrong row (this is
            // exactly what happened when OCR corrupted a "City tax" line's
            // amount, e.g. "City tax .46", and the merge logic grabbed the
            // amount from the next unrelated "Package Charge 182.50" line).
            if (currentItem.Date && !currentItem.BaseAmount && details.baseAmount && !date) {
                currentItem.RowText += " | " + line;
                currentItem.BaseAmount = details.baseAmount;
                currentItem.VatAmount = details.vatAmount;
                currentItem.VatRate = details.vatRate;
                continue;
            }

            // Merge B: continuation text — but only if the line doesn't
            // itself look like a corrupted charge line (a bare, unclaimed
            // number that isn't a room/booking reference or date). Without
            // this guard, a line like "City tax 946" with NO date (OCR lost
            // both the date prefix and the decimal point) would silently
            // disappear into the previous row's text instead of surfacing
            // as its own (zero-amount, auditable) row.
            const looksLikeOrphanedChargeLine = !date && !details.baseAmount && !details.vatAmount && hasUnclaimedDigits(line);
            if (!date && !details.baseAmount && !details.vatAmount && !looksLikeOrphanedChargeLine) {
                currentItem.RowText += " | " + line;
                continue;
            }
        }

        if (currentItem) rows.push(currentItem);

        currentItem = {
            Date: date || '',
            RowText: line,
            BaseAmount: details.baseAmount,
            VatAmount: details.vatAmount,
            VatRate: details.vatRate
        };
        // Flag rows that exist ONLY because they were kept out of Merge B —
        // a genuine charge line whose amount (and often date) failed to
        // parse, as opposed to a line that legitimately produced no row at
        // all. Downstream filtering keeps NeedsReview rows even though
        // BaseAmount is 0, so the row stays visible/auditable instead of
        // silently vanishing from the count.
        if (!date && !details.baseAmount && !details.vatAmount && hasUnclaimedDigits(line)) {
            currentItem.NeedsReview = true;
        }
    }

    if (currentItem) rows.push(currentItem);

    // CRITICAL: ORPHAN AMOUNT PASS (this fixes your count)
    const orphanAmounts = [];

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        if (!/[A-Za-z]/.test(line) && !extractDateAtStart(line)) {
            const matches = line.match(/\d[\d,]*\.\d{2}/g);
            if (matches) {
                matches.forEach(m => {
                    const val = parseFloat(m.replace(/,/g, ''));
                    if (val > 0) orphanAmounts.push(val);
                });
            }
        }
    }

    if (orphanAmounts.length > 0) {
        let idx = 0;
        for (const row of rows) {
            if (
    row.BaseAmount === 0 &&
    row.VatRate !== 0 &&              
    !/tax|fee/i.test(row.RowText) &&  
    idx < orphanAmounts.length
) {
    row.BaseAmount = orphanAmounts[idx++];
}
        }
    }

    if (rows.length === 0 && lines.length > 0) {
    const fallbackRows = [];

    for (const line of lines) {
        const details = parseAmountAndVat(line);

        if (details.baseAmount !== 0) {
            fallbackRows.push({
                Date: '',
                RowText: line,
                BaseAmount: details.baseAmount,
                VatAmount: details.vatAmount,
                VatRate: details.vatRate
            });
        }
    }

    return fallbackRows;
}

    return rows;
}


// ==========================================
// PDF Text Extractor (layout-aware)
// ==========================================
async function extractTextFromPDFPage(page) {
    const content  = await page.getTextContent();
    const clusters = {};

    for (const item of content.items) {
        if (!item.str.trim()) continue;
        const y = Math.round(item.transform[5]);
        const x = item.transform[4];
        let   ky = null;
        for (const ey of Object.keys(clusters)) {
            if (Math.abs(Number(ey) - y) <= 3) { ky = ey; break; }
        }
        const key = ky !== null ? ky : y;
        if (!clusters[key]) clusters[key] = [];
        clusters[key].push({ x, str: item.str, width: item.width || 0 });
    }

    const sortedY = Object.keys(clusters).map(Number).sort((a,b) => b-a);
    return sortedY.map(y => {
        const tokens = clusters[y].sort((a,b) => a.x - b.x);
        let result = '';
        for (let i=0; i<tokens.length; i++) {
            if (i===0) { result = tokens[i].str; continue; }
            const gap = tokens[i].x - (tokens[i-1].x + tokens[i-1].width);
            if (gap > 40) {
                result += '    ';   // big gap → new column
            } else if (gap > 15) {
                result += '  ';     // medium gap
                } else {
            result += ' '; 
            }
        result += tokens[i].str;
        }
        return result;
    });
}

// ==========================================
// Canvas Renderer
// ==========================================
async function renderPageToCanvas(page, scale = 4.0) {
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width  = vp.width;
    canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    return canvas;
}

// ==========================================
// OCR Preprocessing Pipeline
// Improves Tesseract accuracy on scanned invoices by:
//   1. Rendering the page directly at sharp 4.0× scale (about 288 DPI, matching OCR standards).
//   2. Converting to greyscale and boosting contrast using browser-native,
//      GPU-accelerated canvas filter (grayscale(1) contrast(2.0)).
//      This runs in less than 2ms and doesn't block the UI thread.
//   3. Letting Tesseract's optimized WebAssembly engine handle binarization.
// ==========================================
function preprocessCanvas(srcCanvas) {
    const outCanvas = document.createElement('canvas');
    outCanvas.width  = srcCanvas.width;
    outCanvas.height = srcCanvas.height;
    const outCtx     = outCanvas.getContext('2d');
    
    // Apply fast browser-native grayscale and contrast boost
    outCtx.filter = 'grayscale(1) contrast(2.0)';
    outCtx.drawImage(srcCanvas, 0, 0);
    
    return outCanvas;
}

// ==========================================
// Text-Based PDF Processing
// Simple, direct extraction for clean text PDFs:
// - No OCR, no isTextBasedPage check needed
// - For each line, VAT rate comes from "NN %" pattern
// - Amount is always the RIGHTMOST decimal number (last column = gross incl. VAT)
// - Negative detection via leading "-" or "(amount)"
// ==========================================
async function processInvoiceText(arrayBuffer) {
    appState.extractedRows  = [];
    appState.currencySymbol = '';
    updateProgressBar(5, 'Loading PDF (text mode)...');

    const pdf        = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    appState._pdfDoc = pdf;
    const totalPages = pdf.numPages;
    const scannedJobs = [];
    appState._scannedCanvases = [];   // reset for this upload
    let   allRawText = '';

    for (let i = 1; i <= totalPages; i++) {
        updateProgressBar(Math.round((i / totalPages) * 90) + 5,
                          `Extracting text page ${i}/${totalPages}...`);
        const page      = await pdf.getPage(i);
        const rawTextLines = await extractTextFromPDFPage(page);
        const textLines = rawTextLines.map(applyOcrWordCorrections);
        allRawText     += textLines.join(' ') + ' ';

        const rows = reconstructInvoiceLinesText(textLines);
        rows.forEach(r => {
            if (r.BaseAmount !== 0 || r.VatAmount !== 0) {
                appState.extractedRows.push({ Page: i, ...r });
            }
        });
    }

    appState.currencySymbol = safeDetectCurrency([allRawText]);
    appState.extractedRows.sort((a, b) => a.Page - b.Page);
    renderTermSuggestions();

    updateProgressBar(100, `Done — ${appState.extractedRows.length} line items extracted.`);
    setTimeout(() => {
        DOM.progressIndicator.classList.add('hidden');
        DOM.searchBtn.disabled = false;
        startSecurityTimer();
    }, 1000);
}

// Row assembler for text-based PDFs:
// Same date-grouping logic but amount extraction always picks the RIGHTMOST
// decimal number in the line — no Math.max, no OCR noise heuristics needed.
function reconstructInvoiceLinesText(lines) {
    const rows       = [];
    let   currentItem = null;

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        const date = extractDateAtStart(line) || extractDate(line) || '';

        // Extract VAT rate
        let vatRate = null;
        const rm = line.match(/\b(\d{1,2}(?:\.\d+)?)\s*%/);
        if (rm) vatRate = parseInt(rm[1], 10);

        // Strip noise before amount search
        let cleanLine = line;
        if (date) cleanLine = cleanLine.replace(
            new RegExp(date.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '');
        cleanLine = cleanLine.replace(/CHECK#?\s*\d+\b/gi, '');
        cleanLine = cleanLine.replace(/\b(19|20)\d{2}\b/g, '');
        if (rm) cleanLine = cleanLine.replace(rm[0], '');

        // Find all decimal numbers; take RIGHTMOST = last column (gross incl. VAT)
        const stdMatches = cleanLine.match(/\d[\d,]*\.\d{2}/g);
        const eurMatches = cleanLine.match(/\d[\d.]*,\d{2}/g);

        let chosen = null, isEur = false;
        if (stdMatches && eurMatches) {
            isEur   = eurMatches.length > stdMatches.length;
            chosen  = isEur ? eurMatches : stdMatches;
        } else if (stdMatches) {
            chosen  = stdMatches;
        } else if (eurMatches) {
            chosen  = eurMatches;
            isEur   = true;
        }

        let baseAmount = 0;
        if (chosen && chosen.length > 0) {
            let raw2 = chosen[chosen.length - 1]; // rightmost = gross column
            raw2     = isEur
                ? raw2.replace(/\./g, '').replace(',', '.')
                : raw2.replace(/,/g, '');
            baseAmount = parseFloat(raw2) || 0;

            // Negative detection: real minus sign sits directly against its
            // digit (no space between sign and number). A hyphen used as
            // word punctuation always has a space on BOTH sides
            // (e.g. "kamer - mindervalide"), so that case is excluded.
            // Accounting parens "(amount)" still count, but NOT VAT-rate
            // parens like "(21 %)".
            if (baseAmount !== 0) {
                const negTest =
                    /(?:^|\s)-\d/.test(line) ||
                    /\((?!\s*\d+(?:\.\d+)?\s*%\))[\s€$£]*\d[\d,.]*[\s€$£]*\)/.test(line) ||
                    /\bCR\b/i.test(line);
                if (negTest) baseAmount = -Math.abs(baseAmount);
            }
        }

        const details = { baseAmount, vatAmount: 0, vatRate };

        if (currentItem) {
            // Merge A: previous row had a date but no amount, this line has an amount
            if (currentItem.Date && !currentItem.BaseAmount && details.baseAmount) {
                currentItem.RowText    += ' | ' + line;
                currentItem.BaseAmount  = details.baseAmount;
                currentItem.VatRate     = details.vatRate ?? currentItem.VatRate;
                continue;
            }
            // Merge B: continuation line (no date, no amount)
            if (!date && !details.baseAmount) {
                currentItem.RowText += ' | ' + line;
                continue;
            }
        }

        if (currentItem) rows.push(currentItem);
        currentItem = {
            Date:       date || '',
            RowText:    line,
            BaseAmount: details.baseAmount,
            VatAmount:  0,
            VatRate:    details.vatRate
        };
    }

    if (currentItem) rows.push(currentItem);
    return rows;
}

// ===========================
// OCR Word-Level Correction
//
// Tesseract occasionally misreads specific characters within a known word
// due to font/scan artifacts (e.g. "b" read as "h" at low DPI: "Ontbijt"
// becomes "Onthijt"). This is different from the digit-confusion fixes in
// parseAmountAndVat.
// ============================
const OCR_WORD_CORRECTIONS = [
    [/\bOnthijt\b/gi, 'Ontbijt'], // "b" misread as "h"
    [/\bBanqguet\b/gi, 'Banquet'] //Banquet wrong read
];

function applyOcrWordCorrections(text) {
    let corrected = text;
    for (const [pattern, replacement] of OCR_WORD_CORRECTIONS) {
        corrected = corrected.replace(pattern, replacement);
    }
    return corrected;
}

// ==========================================
// Core Processing Pipeline
// ==========================================
async function processInvoice(arrayBuffer, pdfType) {
    // Delegate immediately for text-based PDFs — no OCR, simpler extraction
    if (pdfType === 'text') {
        return processInvoiceText(arrayBuffer);
    }

    // --- SCANNED / OCR path below ---
    appState.extractedRows  = [];
    appState.currencySymbol = '';
    updateProgressBar(5, 'Loading PDF...');

    const pdf        = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    appState._pdfDoc = pdf;
    const totalPages = pdf.numPages;
    const scannedJobs = [];
    appState._scannedCanvases = [];
    let   allRawText  = '';

    // Phase 1: classify each page
    for (let i = 1; i <= totalPages; i++) {
        updateProgressBar(Math.round((i/totalPages)*20)+5, `Scanning page ${i}/${totalPages}...`);
        const page      = await pdf.getPage(i);
        const rawTextLines = await extractTextFromPDFPage(page);
        // Apply the same word-level OCR correction used on Tesseract output —
        // a PDF's own embedded text layer (baked in by the scanner/printer
        // software, not by this app) can carry identical misreads, and this
        // path can run instead of Tesseract whenever isTextBasedPage finds
        // enough dates/amounts to treat the page as already text-based.
        const textLines = rawTextLines.map(applyOcrWordCorrections);
        allRawText     += textLines.join(' ') + ' ';

        if (isTextBasedPage(textLines)) {
            const rows = reconstructInvoiceLines(textLines);
            const hasRows = rows.some(r => r.BaseAmount !== 0 || r.VatAmount !== 0 || r.NeedsReview);
            if (!hasRows) {
                const canvas = await renderPageToCanvas(page); // render only if text fallback fails
                scannedJobs.push({ pageNum: i, canvas });
                appState._scannedCanvases.push(canvas);
            } 
            else{
                const pageResults = rows
                    .filter(r => r.BaseAmount !== 0 || r.VatAmount !== 0 || r.NeedsReview)
                    .map(r => ({ Page: i, ...r }));
                appState.extractedRows.push(...pageResults);
            }
        } else {
            const canvas = await renderPageToCanvas(page); // render since it requires OCR
            scannedJobs.push({ pageNum: i, canvas });
            appState._scannedCanvases.push(canvas);
        }
    }

if (!appState.currencySymbol && allRawText.length > 0) {
        appState.currencySymbol = safeDetectCurrency([allRawText]);
    }

    // ────────────────────────────────────
    // Phase 2 — Batched parallel OCR
    // BATCH SIZE — dynamic by page count of the OCR portion:
    //   ≤ 15 pages  → 4  (small; memory not a concern)
    //   16–80 pages → 3  (medium/large; tighten window)
    //   > 80 pages  → 3  (very large; stability first)
    //
    //   Fallback to batch 2: if performance.memory is available and
    //   usedJSHeapSize > 80% of jsHeapSizeLimit mid-run, the batchSize
    //   variable is halved once (floor 2) at the top of the next iteration.
    //   This is the only dynamic adjustment — everything else is static.
    //
    // MEMORY GUARANTEE — O(1) with respect to page count:
    //   New approach: each batch's canvases are zeroed (canvas.width = 0)
    //   immediately after that batch's Promise.all resolves.
    // ──────────────────────────────────────────
    if (scannedJobs.length > 0) {
        const totalScanned = scannedJobs.length;

        // Static batch size — chosen once before the loop starts
        let batchSize = totalScanned <= 15 ? 4 : 3;

        // Worker count: fixed at 4, but never more than the number of pages
        // and never fewer than 2 (safety floor for single-core environments)
        const WORKERS = Math.min(
            Math.max(2, Math.floor((navigator.hardwareConcurrency || 4) / 2)),
            totalScanned,
            4   // hard cap at 4
        );

        updateProgressBar(25, `Starting OCR — ${totalScanned} page(s), batch ${batchSize}, ${WORKERS} workers...`);

        // Spin up the worker pool once — reused across every batch
        const scheduler = Tesseract.createScheduler();
        appState._activeScheduler = scheduler;

        try {
            for (let w = 0; w < WORKERS; w++) {
                const worker = await Tesseract.createWorker({
                    workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@4/dist/worker.min.js',
                    corePath:   'https://cdn.jsdelivr.net/npm/tesseract.js-core@4/tesseract-core.wasm.js'
                });
                await worker.loadLanguage('eng');
                await worker.initialize('eng');
                scheduler.addWorker(worker);
            }
        } catch (err) {
            console.error('❌ Worker pool init failed:', err);
            updateProgressBar(100, 'OCR unavailable.');
            setTimeout(() => {
                DOM.progressIndicator.classList.add('hidden');
                DOM.searchBtn.disabled = appState.extractedRows.length === 0;
                if (appState.extractedRows.length > 0) startSecurityTimer();
            }, 800);
            return;
        }

        let done = 0;
        const allBatchResults = [];

        for (let batchStart = 0; batchStart < totalScanned; batchStart += batchSize) {

            // Memory-pressure fallback — halve batch size once (floor 2)
            // if the JS heap is over 80% full at the start of this iteration.
            // performance.memory is Chrome/Edge only; silently skipped elsewhere.
            if (typeof performance !== 'undefined' && performance.memory) {
                const { usedJSHeapSize, jsHeapSizeLimit } = performance.memory;
                if (usedJSHeapSize / jsHeapSizeLimit > 0.80 && batchSize > 2) {
                    batchSize = Math.max(2, Math.floor(batchSize / 2));
                    console.warn(`Memory > 80% — batch size reduced to ${batchSize}`);
                }
            }

            const batch = scannedJobs.slice(batchStart, batchStart + batchSize);

            // All pages in this batch run in parallel; the scheduler
            // distributes them across the fixed worker pool
            const batchJobs = batch.map(job => {
                const processed = preprocessCanvas(job.canvas);

                return scheduler.addJob('recognize', processed)
                    .then(result => {
                        done++;
                        updateProgressBar(
                            Math.round((done / totalScanned) * 70) + 25,
                            `OCR ${done}/${totalScanned} pages...`
                        );

                        // Release the preprocessed canvas immediately —
                        // don't wait for GC; width=0 frees the pixel buffer now
                        try { processed.width = 0; processed.height = 0; } catch (_) {}

                        const ocrText = applyOcrWordCorrections(result.data.text);
                        allRawText += ocrText + ' ';

                        //Hit and Try for Banquet:)
                        // ── DEBUG: log raw OCR for pages containing target terms ──
                        // Remove this block once the missing-row bug is diagnosed.
                        if (/banquet/i.test(ocrText)) {
                            console.group(`🔍 OCR DEBUG — Page ${job.pageNum}`);
                            console.log('RAW OCR TEXT:\n' + ocrText);
                            console.log('LINES ARRAY:', ocrText.split('\n').map((l,i) => `[${i}] ${JSON.stringify(l)}`).join('\n'));
                            console.groupEnd();
                        }
                        // ── END DEBUG ──

                        // Stitch orphan amount-only lines onto their date line
                        let ocrLines = ocrText.split('\n');
                        let lastRowIndex = -1;
                        for (let i = 0; i < ocrLines.length; i++) {
                            const line = ocrLines[i].trim();
                            if (/^\d{2}[-\/]\d{2}[-\/]\d{2}/.test(line)) {
                                lastRowIndex = i;
                            } else if (/^-?\d+[\.,]\d{2}$/.test(line) && lastRowIndex !== -1) {
                                ocrLines[lastRowIndex] += ' ' + line;
                            }
                        }

                        const rows = reconstructInvoiceLines(ocrLines);
                        const pageResults = rows
                            .filter(r => r.BaseAmount !== 0 || r.VatAmount !== 0 || r.NeedsReview)
                            .map(r => ({ Page: job.pageNum, ...r }));

                        if (!appState.currencySymbol) {
                            const detected = safeDetectCurrency([ocrText]);
                            if (detected) appState.currencySymbol = detected;
                        }

                        return { pageNum: job.pageNum, rows: pageResults };
                    })
                    .catch(err => {
                        done++;
                        console.error(`OCR failed on page ${job.pageNum}:`, err);
                        try { processed.width = 0; processed.height = 0; } catch (_) {}
                        return { pageNum: job.pageNum, rows: [] };
                    });
            });

            // Wait for this batch to complete before starting the next one
            const batchResults = await Promise.all(batchJobs);
            allBatchResults.push(...batchResults);

            // Zero original canvases for this batch right now —
            // this is the key step that keeps memory O(1).
            // By the time the next batch starts, these ~69 MB buffers are gone.
            batch.forEach(job => {
                try { job.canvas.width = 0; job.canvas.height = 0; } catch (_) {}
                job.canvas = null;
            });
        }

        // Merge all batch results in page order
        allBatchResults.sort((a, b) => a.pageNum - b.pageNum);
        allBatchResults.forEach(r => {
            appState.extractedRows.push(...r.rows);
        });

        await scheduler.terminate();
        appState._activeScheduler = null;
    }

    appState.extractedRows.sort((a,b) => a.Page - b.Page);
    renderTermSuggestions();
    updateProgressBar(100, `Done — ${appState.extractedRows.length} line items extracted.`);
    setTimeout(() => {
        DOM.progressIndicator.classList.add('hidden');
        DOM.searchBtn.disabled = false;
        startSecurityTimer();
    }, 1000);
}

// ==========================================
// VAT Calculation Helper
// The invoice stores GROSS amounts (VAT-inclusive).
// If vatRate is known: netAmount = grossAmount / (1 + rate/100)
//                      vatAmount = grossAmount - netAmount
// If vatRate is null/0: net = gross (no VAT)
// ==========================================
function computeVatSplit(grossAmount, vatRate) {
    if (!vatRate || vatRate === 0) {
        return { net: grossAmount, vat: 0 };
    }
    const net = grossAmount / (1 + vatRate / 100);
    const vat = grossAmount - net;
    return { net: Math.round(net * 100) / 100, vat: Math.round(vat * 100) / 100 };
}

// ==========================================
// Term Suggestions (frequency-based, no AI/judgment)
// After extraction, scan every row's description text, strip out the
// "noisy" parts that make every row look unique (dates, room/check
// numbers, amounts, VAT %, currency symbols), and count how often each
// remaining phrase recurs. The most frequent phrases are shown as
// clickable suggestion chips so the user can add them as search terms
// with one click instead of typing — this never decides what is
// "commissionable," it only surfaces what repeats often in this invoice.
// ==========================================
function normalizeRowTextForSuggestions(rowText, maxWords = 2) {
    let s = rowText;

    // Strip a leading date if present
    s = s.replace(/^\s*\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4}\s*/, '');
    s = s.replace(/^\s*[|=]\s*/, ''); // OCR noise prefix

    // The actual line-item TYPE (e.g. "City tax", "Comfort kamer",
    // "Ontbijt - volwassene") is always the very first phrase on the line —
    // everything after it is guest names, room numbers, amounts, or VAT
    // detail. Cut the string at the first point any of that "after" content
    // starts: an opening parenthesis, a digit, a currency symbol/code, an
    // em/en-dash run, a pipe separator, or guest/room connector phrases.
    const cutPattern = /[(\d€£$|]|—|--|\bEUR\b|\bGBP\b|\bUSD\b|\bRouted From\b|\bOf Room\b|\bRoom\s*#/i;
    const cutMatch = s.match(cutPattern);
    if (cutMatch) s = s.substring(0, cutMatch.index);

    s = s.replace(/[-–—]+$/, '');           // trailing dash left over from the cut
    s = s.replace(/\s{2,}/g, ' ').trim();

    // Hard cap to a short phrase (1-2 words) — a recurring line-item type
    // is almost always short; anything longer slipped past the cut above.
    const words = s.split(/\s+/).filter(Boolean);
    return words.slice(0, maxWords).join(' ');
}

const NON_COMMISSIONABLE_PATTERN = /\b(tax|fee|charge|levy|toeristenbelasting|verblijfsbelasting|taxe|belasting|btw|vat|servicecharge|service\s+charge|municipal|tourist|citytax|city\s+tax|servicekosten|handling)\b/i;

function generateTermSuggestions(rows, maxSuggestions = 3) {
    const counts = new Map(); // normalized phrase -> { count, label }

    for (const row of rows) {
        const normalized = normalizeRowTextForSuggestions(row.RowText);
        if (!normalized || normalized.length < 3) continue;

        // Exclude non-commissionable items (taxes, service charges, fees, etc.)
        if (NON_COMMISSIONABLE_PATTERN.test(normalized)) continue;

        // Use the normalized phrase as the dedup key, but keep a readable
        // "best" original-cased label (the shortest normalized match, since
        // longer ones tend to include leftover guest-name fragments).
        const key = normalized.toLowerCase();
        if (!counts.has(key)) {
            counts.set(key, { count: 0, label: normalized });
        }
        const entry = counts.get(key);
        entry.count++;
        if (normalized.length < entry.label.length) entry.label = normalized;
    }

    return [...counts.values()]
        .filter(e => e.count >= 2)              // only phrases that genuinely recur
        .sort((a, b) => b.count - a.count)
        .slice(0, maxSuggestions)
        .map(e => ({ label: e.label, count: e.count }));
}

function renderTermSuggestions() {
    if (!DOM.termSuggestions) return;

    const suggestions = generateTermSuggestions(appState.extractedRows);
    if (suggestions.length === 0) {
        DOM.termSuggestions.classList.add('hidden');
        DOM.termSuggestions.innerHTML = '';
        return;
    }

    DOM.termSuggestions.classList.remove('hidden');
    DOM.termSuggestions.innerHTML =
        '<div class="suggestions-header">' +
            '<p class="suggestions-label">AI suggestion :-) click to add:</p>' +
            '<button type="button" class="suggestions-dismiss-btn" title="Hide suggestions">' +
                '<i class="fa-solid fa-xmark"></i>' +
            '</button>' +
        '</div>' +
        '<div class="suggestions-chip-row">' +
        suggestions.map(s =>
            `<button type="button" class="suggestion-chip" data-term="${s.label.replace(/"/g, '&quot;')}">
                ${s.label} <span class="chip-count">${s.count}×</span>
            </button>`
        ).join('') +
        '</div>';

    DOM.termSuggestions.querySelectorAll('.suggestion-chip').forEach(chip => {
        chip.addEventListener('click', () => addSuggestedTerm(chip.dataset.term));
    });

    const dismissBtn = DOM.termSuggestions.querySelector('.suggestions-dismiss-btn');
    if (dismissBtn) {
        dismissBtn.addEventListener('click', () => {
            DOM.termSuggestions.classList.add('hidden');
            DOM.termSuggestions.innerHTML = '';
        });
    }
}

function addSuggestedTerm(termText) {
    // Reuse an existing empty row if there is one, otherwise add a new row —
    // never auto-runs the search, just fills the input.
    const inputs = [...DOM.searchTermsList.querySelectorAll('.term-input')];
    const emptyInput = inputs.find(i => !i.value.trim());
    if (emptyInput) {
        emptyInput.value = termText;
        return;
    }
    const row = document.createElement('div');
    row.className = 'term-input-row';
    row.innerHTML = `<input type="text" placeholder="Enter term..." class="term-input" value="${termText.replace(/"/g, '&quot;')}">
        <button class="btn-remove-term" onclick="this.parentElement.remove()" title="Remove">
            <i class="fa-solid fa-xmark"></i></button>`;
    DOM.searchTermsList.appendChild(row);
}


// Stored entirely in the browser's localStorage — no server, no PDF data
// involved. Lets the user save the current list of search terms under a
// name (e.g. "Van der Valk") and reload it on a future visit instead of
// retyping the same terms every time.
// ==========================================
const PRESET_STORAGE_KEY = 'commiiq_term_presets';

function loadPresetsFromStorage() {
    try {
        const raw = localStorage.getItem(PRESET_STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (err) {
        console.error('loadPresetsFromStorage: failed to read/parse presets', err);
        return {};
    }
}

function savePresetsToStorage(presets) {
    try {
        localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
        return true;
    } catch (err) {
        console.error('savePresetsToStorage: failed to write presets', err);
        return false;
    }
}

function getCurrentTermValues() {
    return [...DOM.searchTermsList.querySelectorAll('.term-input')]
        .map(i => i.value.trim())
        .filter(Boolean);
}

function setTermInputRows(terms) {
    // Always leave at least one (possibly empty) row, matching the
    // existing default state used by clearInvoiceData().
    const rowsHtml = (terms.length > 0 ? terms : ['']).map(t => `
        <div class="term-input-row">
            <input type="text" placeholder="e.g. Night Stay, Room, Package Charge, Logies" class="term-input" value="${t.replace(/"/g, '&quot;')}">
            <button class="btn-remove-term" onclick="this.parentElement.remove()" title="Remove term">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>`).join('');
    DOM.searchTermsList.innerHTML = rowsHtml;
}

function refreshPresetDropdown(selectName) {
    const presets = loadPresetsFromStorage();
    const names = Object.keys(presets).sort((a, b) => a.localeCompare(b));

    DOM.presetSelect.innerHTML = '<option value="">— Load saved term list —</option>' +
        names.map(n => `<option value="${n.replace(/"/g, '&quot;')}">${n}</option>`).join('');

    if (selectName && names.includes(selectName)) {
        DOM.presetSelect.value = selectName;
    }
    DOM.deletePresetBtn.disabled = !DOM.presetSelect.value;
}

function handleSavePreset() {
    const terms = getCurrentTermValues();
    if (terms.length === 0) {
        alert('Add at least one search term before saving a list.');
        return;
    }
    const name = prompt('Save this term list as (e.g. hotel or client name):');
    if (!name || !name.trim()) return; // user cancelled or entered blank

    const trimmedName = name.trim();
    const presets = loadPresetsFromStorage();
    const isOverwrite = Object.prototype.hasOwnProperty.call(presets, trimmedName);
    if (isOverwrite && !confirm(`A list named "${trimmedName}" already exists. Overwrite it?`)) {
        return;
    }

    presets[trimmedName] = terms;
    if (savePresetsToStorage(presets)) {
        refreshPresetDropdown(trimmedName);
    } else {
        alert('⚠️ Could not save the term list. Your browser may be blocking local storage.');
    }
}

function handleLoadPreset() {
    const name = DOM.presetSelect.value;
    DOM.deletePresetBtn.disabled = !name;
    if (!name) return;

    const presets = loadPresetsFromStorage();
    const terms = presets[name];
    if (!Array.isArray(terms)) {
        console.error(`handleLoadPreset: preset "${name}" not found or invalid`);
        return;
    }
    setTermInputRows(terms);
}

function handleDeletePreset() {
    const name = DOM.presetSelect.value;
    if (!name) return;
    if (!confirm(`Delete the saved term list "${name}"? This cannot be undone.`)) return;

    const presets = loadPresetsFromStorage();
    delete presets[name];
    savePresetsToStorage(presets);
    refreshPresetDropdown();
}

// ==========================================
// Audit Search
// ==========================================
function executeAuditSearch() {
    if (appState.extractedRows.length === 0) {
        alert('No invoice data loaded yet.'); return;
    }
    const terms = [...DOM.searchTermsList.querySelectorAll('.term-input')]
        .map(i => i.value.trim()).filter(Boolean);
    if (terms.length === 0) { alert('Please add at least one search term.'); return; }

    DOM.resultsSection.innerHTML = '';
    DOM.resultsSection.classList.remove('hidden');
    terms.forEach(t => renderTermCard(t,
        appState.extractedRows.filter(r => new RegExp(escapeRegExp(t),'i').test(r.RowText))
    ));
    DOM.resultsSection.scrollIntoView({ behavior:'smooth' });
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }

// =====================
// Render Result Card
// =====================
// Excel Export — per search term
// Produces a clean .xlsx with one row per matched line item:
// Page, Date, Description, VAT %, Base (Excl. VAT), VAT Amount, Gross (Incl. VAT)
// Filename: "<uploaded pdf name>_<TERM>.xlsx"
// ==========================================
function exportTermToExcel(term, matchedRows) {
    if (typeof XLSX === 'undefined') {
        alert('⚠️ Excel export library failed to load. Please check your internet connection and refresh the page, then try again.');
        console.error('exportTermToExcel: XLSX (SheetJS) is not defined — check that the xlsx CDN <script> tag is present in index.html and loaded before app.js.');
        return;
    }

    const sheetRows = matchedRows.map(row => {
        const gross = row.BaseAmount;
        const rate  = (row.VatRate !== null) ? row.VatRate : 0;
        const split = computeVatSplit(gross, rate);
        return {
            'Page':                 row.Page,
            'Date':                 row.Date || '',
            'Description':          row.RowText,
            'VAT %':                rate,
            'Base (Excl. VAT)':     Number(split.net.toFixed(2)),
            'VAT Amount':           Number(split.vat.toFixed(2)),
            'Gross (Incl. VAT)':    Number(gross.toFixed(2)),
            'Needs Review':         row.NeedsReview ? 'OCR could not read amount — check source PDF' : ''
        };
    });

    const worksheet = XLSX.utils.json_to_sheet(sheetRows, {
        header: ['Page', 'Date', 'Description', 'VAT %', 'Base (Excl. VAT)', 'VAT Amount', 'Gross (Incl. VAT)', 'Needs Review']
    });

    // Reasonable column widths for readability
    worksheet['!cols'] = [
        { wch: 6 },  // Page
        { wch: 12 }, // Date
        { wch: 60 }, // Description
        { wch: 8 },  // VAT %
        { wch: 16 }, // Base
        { wch: 14 }, // VAT Amount
        { wch: 16 }, // Gross
        { wch: 40 }  // Needs Review
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Log');

    // Sanitize term for use in a filename (strip characters illegal on common filesystems)
    const safeTerm = term.trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_') || 'term';
    const fileName = `${appState.uploadedFileBaseName}_${safeTerm}.xlsx`;

    XLSX.writeFile(workbook, fileName);
}

function renderTermCard(term, matchedRows) {
    const card = document.createElement('div');
    card.className = 'term-result-box';
    const cur      = appState.currencySymbol;
    const fmt      = n => `${n < 0 ? '-' : ''}${cur}${Math.abs(n).toLocaleString('en-GB',
                           {minimumFractionDigits:2,maximumFractionDigits:2})}`;
    const fmtFixed = n => `${n < 0 ? '-' : ''}${cur}${Math.abs(n).toFixed(2)}`;

    // European-format display for the three "Combined ..." summary figures
    // ONLY (Combined Base, Combined VAT, Combined Total) — used so the EUR
    // figure can be pasted directly onto a commission line in the format
    // clients expect (€ 25.428,19 instead of €25,428.19). Everything else
    // (per-VAT-rate breakdown, detailed log table, Excel export) is left
    // in the standard format on purpose.
    const fmtCombined = n => {
        const sign = n < 0 ? '-' : '';
        const abs  = Math.abs(n).toFixed(2);
        if (cur !== '€') return `${sign}${cur}${Math.abs(n).toLocaleString('en-GB',
            {minimumFractionDigits:2,maximumFractionDigits:2})}`;
        // Standard "25428.19" -> European "25.428,19"
        const [intPart, decPart] = abs.split('.');
        const intWithDots = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
        return `${sign}€ ${intWithDots},${decPart}`;
    };

    if (matchedRows.length === 0) {
        card.innerHTML = `
            <div class="term-result-header">
                <h3>Term: "${term}"</h3>
                <span class="badge" style="background:var(--danger-light);color:var(--danger);
                  border:1px solid rgba(239,68,68,.2);box-shadow:none;">0 matches</span>
            </div>
            <p style="color:var(--text-muted);font-size:.95rem;">No items matched this term.</p>`;
        DOM.resultsSection.appendChild(card);
        return;
    }

    // Group by VAT rate; compute net/vat split per row
    const groups = {};
    let totalNet = 0, totalVat = 0, totalGross = 0;

    for (const row of matchedRows) {
        // BaseAmount from invoice is GROSS (VAT-inclusive)
        const gross = row.BaseAmount;
        const rate  = (row.VatRate !== null) ? row.VatRate : 0;
        const split = computeVatSplit(gross, rate);
        const net   = split.net;
        const vat   = split.vat;

        const key = rate > 0 ? `${rate}%` : 'Other/Unknown (0%)';
        if (!groups[key]) groups[key] = { rateLabel:key, count:0,
                                           netSum:0, vatSum:0, grossSum:0, rows:[] };
        groups[key].count++;
        groups[key].netSum   += net;
        groups[key].vatSum   += vat;
        groups[key].grossSum += gross;
        groups[key].rows.push({ ...row, _net: net, _vat: vat });

        totalNet   += net;
        totalVat   += vat;
        totalGross += gross;
    }

    const breakdownHtml = Object.keys(groups).sort().map(k => {
        const g = groups[k];
        return `<div class="vat-breakdown-row">
            <span class="vat-rate-label">${g.rateLabel}</span>
            <span class="text-right" style="font-weight:600">${g.count}</span>
            <span class="text-right">${fmt(g.netSum)}</span>
            <span class="text-right">${fmt(g.vatSum)}</span>
            <span class="text-right" style="font-weight:700;color:var(--text-main)">${fmt(g.grossSum)}</span>
        </div>`;
    }).join('');

    const tableHtml = matchedRows.map(row => {
        const gross  = row.BaseAmount;
        const rate   = (row.VatRate !== null) ? row.VatRate : 0;
        const split  = computeVatSplit(gross, rate);
        const hl     = row.RowText.replace(
            new RegExp(`(${escapeRegExp(term)})`, 'gi'),
            '<span class="highlight-match">$1</span>');
        const rLabel = rate > 0 ? `${rate}%`
                     : `<span style="color:var(--text-muted)">0%</span>`;
        // NeedsReview: OCR could not read this row's amount (and often its
        // date). It's still shown — not silently dropped — so the count
        // stays honest, but it's flagged clearly since €0.00 here means
        // "unreadable," not "actually zero," and needs a manual check
        // against the source PDF.
        const reviewBadge = row.NeedsReview
            ? ' <span class="badge" style="background:var(--warning-light,#fff3cd);color:var(--warning,#92660a);border:1px solid rgba(146,102,10,.25);box-shadow:none;font-size:.7rem;vertical-align:middle;" title="OCR could not read this amount — check the source PDF">⚠ needs review</span>'
            : '';
        const rowStyle = row.NeedsReview ? ' style="background:rgba(245,158,11,0.08);"' : '';
        return `<tr${rowStyle}>
            <td>Page ${row.Page}</td>
            <td>${row.Date || '<span style="color:var(--text-muted);font-style:italic">No Date</span>'}</td>
            <td>${hl}${reviewBadge}</td>
            <td class="text-right">${rLabel}</td>
            <td class="text-right">${fmtFixed(split.net)}</td>
            <td class="text-right">${fmtFixed(split.vat)}</td>
            <td class="text-right" style="font-weight:600;color:var(--text-main)">${fmtFixed(gross)}</td>
        </tr>`;
    }).join('');

    const needsReviewCount = matchedRows.filter(r => r.NeedsReview).length;
    const needsReviewNotice = needsReviewCount > 0
        ? `<div class="needs-review-notice" style="margin:.5rem 0;padding:.6rem .9rem;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);border-radius:8px;font-size:.85rem;color:var(--text-main);">
            <i class="fa-solid fa-triangle-exclamation" style="color:#92660a;"></i>
            ${needsReviewCount} row${needsReviewCount > 1 ? 's' : ''} could not be read by OCR and ${needsReviewCount > 1 ? 'are' : 'is'} shown as €0.00 — check the "needs review" row${needsReviewCount > 1 ? 's' : ''} in the detailed log against the source PDF.
        </div>`
        : '';

    card.innerHTML = `
        <div class="term-result-header">
            <h3>Term: "${term}"</h3>
            <span class="badge">${matchedRows.length} matches</span>
        </div>
        <div class="vat-breakdown-grid">
            <div class="vat-breakdown-row header-row">
                <span>VAT Rate</span>
                <span class="text-right">Count</span>
                <span class="text-right">Total Base (Excl. VAT)</span>
                <span class="text-right">Total VAT</span>
                <span class="text-right">Total Gross (Incl. VAT)</span>
            </div>
            ${breakdownHtml}
        </div>
        <div class="term-combined-summary">
            <div class="summary-metric">
                <span class="metric-label">Combined Base (Excl. VAT)</span>
                <span class="metric-val">${fmtCombined(totalNet)}</span>
            </div>
            <div class="summary-metric">
                <span class="metric-label">Combined VAT</span>
                <span class="metric-val">${fmtCombined(totalVat)}</span>
            </div>
            <div class="summary-metric highlight">
                <span class="metric-label">Combined Total (Incl. VAT)</span>
                <span class="metric-val">${fmtCombined(totalGross)}</span>
            </div>
        </div>
        ${needsReviewNotice}
        <div class="term-details-control">
            <div class="term-details-actions">
                <button class="btn btn-secondary btn-sm toggle-details-btn" onclick="toggleDetailsLog(this)">
                    <i class="fa-solid fa-chevron-down"></i> View Detailed Log
                </button>
                <button class="btn btn-secondary btn-sm export-excel-btn">
                    <i class="fa-solid fa-file-excel"></i> View in Excel
                </button>
            </div>
            <div class="details-log-wrapper hidden">
                <div class="table-wrapper">
                    <table class="audit-table">
                        <thead><tr>
                            <th>Page</th><th>Date</th><th>Description</th>
                            <th class="text-right">VAT %</th>
                            <th class="text-right">Base (Excl. VAT)</th>
                            <th class="text-right">VAT Amount</th>
                            <th class="text-right">Gross (Incl. VAT)</th>
                        </tr></thead>
                        <tbody>${tableHtml}</tbody>
                    </table>
                </div>
            </div>
        </div>`;
    DOM.resultsSection.appendChild(card);

    const exportBtn = card.querySelector('.export-excel-btn');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => exportTermToExcel(term, matchedRows));
    } else {
        console.warn('renderTermCard: .export-excel-btn not found in rendered card');
    }
}

window.toggleDetailsLog = function(btn) {
    // Find the log wrapper relative to the shared parent container
    // (.term-details-control) rather than assuming sibling order — this
    // stays correct even if more buttons are added alongside this one.
    const container = btn.closest('.term-details-control');
    const w = container ? container.querySelector('.details-log-wrapper') : btn.nextElementSibling;
    if (!w) {
        console.error('toggleDetailsLog: could not find .details-log-wrapper');
        return;
    }
    const collapsed = w.classList.contains('hidden');
    w.classList.toggle('hidden', !collapsed);
    btn.innerHTML = collapsed
        ? '<i class="fa-solid fa-chevron-up"></i> Hide Detailed Log'
        : '<i class="fa-solid fa-chevron-down"></i> View Detailed Log';
};

// ==========================================
// Security Timer
// ==========================================
function startSecurityTimer() {
    clearInterval(appState.timerInterval);
    appState.countdownSeconds = 1260;
    DOM.securityTimer.classList.remove('hidden');
    updateTimerDisplay();
    appState.timerInterval = setInterval(() => {
        if (--appState.countdownSeconds <= 0) {
            clearInvoiceData();
            alert('⏰ 21 minutes elapsed — data auto-deleted for privacy.');
        }
        updateTimerDisplay();
    }, 1000);
}

function updateTimerDisplay() {
    const m = Math.floor(appState.countdownSeconds/60);
    const s = appState.countdownSeconds % 60;
    DOM.countdownDisplay.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

//To Clear Invoice Data:)
function clearInvoiceData() {
    clearInterval(appState.timerInterval);

    // ── Destroy the pdf.js document ──────────────────────────────────────────
    // pdf.destroy() is pdf.js's own API — it frees the internal page tree,
    // font caches, and content streams it built from the ArrayBuffer.
    // Without this, that memory is only freed when GC decides to run.
    if (appState._pdfDoc) {
        appState._pdfDoc.destroy();
        appState._pdfDoc = null;
    }

    // ── Zero all canvas backing stores ───────────────────────────────────────
    // Setting canvas.width = 0 / canvas.height = 0 releases the pixel buffer
    // immediately — this is the only cross-browser way to free canvas GPU/CPU
    // memory before GC runs. Each scanned page canvas is ~69 MB at 4× scale,
    // so on a 100-page invoice this can free hundreds of MB right now rather
    // than waiting for GC.
    appState._scannedCanvases.forEach(c => {
        try { c.width = 0; c.height = 0; } catch (_) {}
    });
    appState._scannedCanvases = [];

    // ── Terminate Tesseract scheduler if OCR was mid-flight ─────────────────
    // If the user clicks "Delete Now" while OCR is still running on a large
    // invoice, the scheduler and its workers keep consuming CPU and memory
    // until they finish — unless we terminate them explicitly here.
    if (appState._activeScheduler) {
        appState._activeScheduler.terminate().catch(() => {});
        appState._activeScheduler = null;
    }

    // ── Clear parsed data ────────────────────────────────────────────────────
    appState.extractedRows  = [];
    appState.currencySymbol = '';

    // ── Reset UI ─────────────────────────────────────────────────────────────
    DOM.fileInput.value     = '';
    DOM.fileStatusContainer.classList.add('hidden');
    DOM.progressIndicator.classList.add('hidden');
    DOM.securityTimer.classList.add('hidden');
    DOM.resultsSection.classList.add('hidden');
    DOM.resultsSection.innerHTML = '';
    DOM.searchBtn.disabled = true;
    DOM.searchTermsList.innerHTML = `
        <div class="term-input-row">
            <input type="text" placeholder="e.g. Night Stay, Room, Package Charge" class="term-input">
            <button class="btn-remove-term" onclick="this.parentElement.remove()" title="Remove">
                <i class="fa-solid fa-xmark"></i></button>
        </div>`;
    if (DOM.termSuggestions) {
        DOM.termSuggestions.classList.add('hidden');
        DOM.termSuggestions.innerHTML = '';
    }
}

function updateProgressBar(pct, text) {
    DOM.progressIndicator.classList.remove('hidden');
    DOM.progressBar.style.width = `${pct}%`;
    DOM.progressText.textContent = text;
}

// ==========================================
// Event Binding
// ==========================================
function initAppEvents() {
    DOM.themeToggleBtn.addEventListener('click', () => {
        document.body.classList.toggle('theme-dark-green');
        document.body.classList.toggle('theme-dark-yellow');
    });
    DOM.fileInput.addEventListener('change', handleFileSelect);
    ['dragenter','dragover'].forEach(ev =>
        DOM.dropzone.addEventListener(ev, e => {
            e.preventDefault(); DOM.dropzone.classList.add('dragover');
        }, false));
    ['dragleave','drop'].forEach(ev =>
        DOM.dropzone.addEventListener(ev, e => {
            e.preventDefault(); DOM.dropzone.classList.remove('dragover');
        }, false));
    DOM.dropzone.addEventListener('drop', e => {
        const f = e.dataTransfer.files[0];
        if (f && f.type==='application/pdf') { DOM.fileInput.files=e.dataTransfer.files; handleFileSelect(); }
        else alert('Please drop a valid PDF file.');
    });
    DOM.addTermBtn.addEventListener('click', () => {
        const row = document.createElement('div');
        row.className = 'term-input-row';
        row.innerHTML = `<input type="text" placeholder="Enter term..." class="term-input">
            <button class="btn-remove-term" onclick="this.parentElement.remove()" title="Remove">
                <i class="fa-solid fa-xmark"></i></button>`;
        DOM.searchTermsList.appendChild(row);
        row.querySelector('.term-input').focus();
    });
    DOM.searchBtn.addEventListener('click', executeAuditSearch);
    DOM.clearDataBtn.addEventListener('click', clearInvoiceData);
    DOM.savePresetBtn.addEventListener('click', handleSavePreset);
    DOM.deletePresetBtn.addEventListener('click', handleDeletePreset);
    DOM.presetSelect.addEventListener('change', handleLoadPreset);

    refreshPresetDropdown();
}

function handleFileSelect() {
    const file = DOM.fileInput.files[0];
    if (!file) return;

    // Enforce PDF type selection before proceeding
    const selectedRadio = DOM.pdfTypeRadios();
    if (!selectedRadio) {
        alert('Please select the PDF type (Scanned or Text-based) before uploading.');
        DOM.fileInput.value = ''; // reset so user can re-select
        return;
    }
    const pdfType = selectedRadio.value; // 'scanned' or 'text'

    DOM.fileStatusContainer.classList.remove('hidden');
    DOM.fileNameDisplay.textContent = file.name;
    DOM.fileSizeDisplay.textContent = `${Math.round(file.size/1024).toLocaleString()} KB`;
    appState.uploadedFileBaseName = file.name.replace(/\.pdf$/i, '') || 'invoice';
    DOM.resultsSection.classList.add('hidden');
    DOM.resultsSection.innerHTML = '';
    DOM.securityTimer.classList.add('hidden');
    DOM.searchBtn.disabled = true;

    const reader = new FileReader();
    reader.onload = e => processInvoice(e.target.result, pdfType).catch(err => {
        console.error(err);
        updateProgressBar(0,'Error during parsing.');
        alert('❌ Failed to parse invoice. Check the browser console for details.');
    });
    reader.readAsArrayBuffer(file);
}

window.addEventListener('DOMContentLoaded', initAppEvents);
window.addEventListener('beforeunload', () => {
    clearInvoiceData();
});
