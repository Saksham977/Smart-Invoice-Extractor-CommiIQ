// Configure PDF.js Worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';

// ==========================================
// Application State Management
// ==========================================
let appState = {
    extractedRows: [], // Array of { Page, Date, RowText, BaseAmount, VatAmount, VatRate }
    countdownSeconds: 1200, // 20 minutes
    timerInterval: null
};

// ==========================================
// UI Elements Cache
// ==========================================
const DOM = {
    themeToggleBtn: document.getElementById('themeToggleBtn'),
    dropzone: document.getElementById('dropzone'),
    fileInput: document.getElementById('fileInput'),
    fileStatusContainer: document.getElementById('fileStatusContainer'),
    fileNameDisplay: document.getElementById('fileNameDisplay'),
    fileSizeDisplay: document.getElementById('fileSizeDisplay'),
    progressIndicator: document.getElementById('progressIndicator'),
    progressBar: document.getElementById('progressBar'),
    progressText: document.getElementById('progressText'),
    securityTimer: document.getElementById('securityTimer'),
    countdownDisplay: document.getElementById('countdownDisplay'),
    clearDataBtn: document.getElementById('clearDataBtn'),
    searchTermsList: document.getElementById('searchTermsList'),
    addTermBtn: document.getElementById('addTermBtn'),
    searchBtn: document.getElementById('searchBtn'),
    resultsSection: document.getElementById('resultsSection')
};

// ==========================================
// Regex Search & Formatting Systems
// ==========================================
const DATE_PATTERNS = [
    // YYYY.MM.DD, YYYY-MM-DD or YYYY/MM/DD
    /\b(\d{4}[-.\/]\d{1,2}[-.\/]\d{1,2})\b/,
    // DD.MM.YYYY, DD-MM-YYYY, DD/MM/YYYY, MM.DD.YYYY, etc.
    /\b(\d{1,2}[-.\/]\d{1,2}[-.\/]\d{2,4})\b/,
    // DD-MMM-YYYY or DD.MMM.YYYY
    /\b(\d{1,2}[-.\/][A-Za-z]{3,9}[-.\/]\d{2,4})\b/,
    // Month DD, YYYY
    /\b([A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,\s+\d{4})\b/i
];

function extractDate(line) {
    for (const pattern of DATE_PATTERNS) {
        const match = line.match(pattern);
        if (match) return match[1];
    }
    return '';
}

function parseNumberString(str) {
    let digitsOnly = str.replace(/[^\d.,-]/g, ''); // Keep numbers, decimals, commas, minus
    if (!digitsOnly) return 0.0;
    
    // Handle European commas vs standard decimals
    if (digitsOnly.includes('.') && digitsOnly.includes(',')) {
        if (digitsOnly.lastIndexOf(',') > digitsOnly.lastIndexOf('.')) {
            digitsOnly = digitsOnly.replace(/\./g, '').replace(',', '.'); // European
        } else {
            digitsOnly = digitsOnly.replace(/,/g, ''); // Standard
        }
    } else if (digitsOnly.includes(',')) {
        const parts = digitsOnly.split(',');
        if (parts[parts.length - 1].length === 3) {
            digitsOnly = digitsOnly.replace(/,/g, ''); // Thousands separator
        } else {
            digitsOnly = digitsOnly.replace(',', '.'); // Decimal comma
        }
    }
    return parseFloat(digitsOnly) || 0.0;
}

function parseAmountAndVat(line) {
    let baseAmount = 0.0;
    let vatAmount = 0.0;
    let vatRate = null; // null represents N/A (no rate listed)
    
    // Localized OCR correction
    let cleanLine = line.replace(/(?<=\d)O|O(?=\d)/g, '0');
    
    // 1. Extract VAT rate percentage (e.g. 21%, 10%, 22%) first to prevent splitting digits
    const rateRegex = /\b(\d{1,2})\s*%/;
    const rateMatch = cleanLine.match(rateRegex);
    if (rateMatch) {
        vatRate = parseInt(rateMatch[1], 10);
    }
    
    // 2. Extract VAT amount if it is explicitly written next to a percentage inside parentheses, e.g. €57,10 (21 %)
    const vatAmountPattern = /(?:[\$\u20AC\u00A3\u00A5\u20AC€]\s*)?(-?[0-9]{1,3}(?:[.,\s][0-9]{3})*(?:[.,][0-9]{1,2})?|[0-9]+(?:[.,][0-9]{1,2})?)\s*\(\s*\d+\s*%\s*\)/;
    const vatAmountMatch = cleanLine.match(vatAmountPattern);
    if (vatAmountMatch) {
        vatAmount = parseNumberString(vatAmountMatch[1]);
        // Remove the matched block (e.g. €57,10 (21 %)) so it is not double-parsed
        cleanLine = cleanLine.replace(vatAmountMatch[0], '');
    } else if (rateMatch) {
        // If there was a rate percentage like 10% or 22% but no VAT amount inside parentheses,
        // clean just the percentage token (e.g. "10%") from the line.
        cleanLine = cleanLine.replace(rateMatch[0], '');
    }
    
    // Clean any residual percent structures
    cleanLine = cleanLine.replace(/\b\d+(?:\.\d+)?\s*%/g, '');
    cleanLine = cleanLine.replace(/\(\s*\)/g, '');
    
    // Capture remaining base amounts (negatives, standard formats)
    const amountPattern = /(?:^|\s|\b)(?:-|negative)?\s*[\$\u20AC\u00A3\u00A5\u20AC€]?\s*\(?\s*([0-9]{1,3}(?:[.,\s][0-9]{3})*(?:[.,][0-9]{1,2})?|[0-9]+(?:[.,][0-9]{1,2})?)\s*\)?/g;
    
    const validAmounts = [];
    let match;
    while ((match = amountPattern.exec(cleanLine)) !== null) {
        const valStr = match[0].trim();
        const isNegative = valStr.startsWith('-') || (valStr.startsWith('(') && valStr.endsWith(')'));
        
        let digitsOnly = valStr.replace(/[^\d.,]/g, '');
        if (!digitsOnly) continue;
        
        // Check if this number string has a decimal component (.00, ,90, .9, etc.)
        const hasDecimal = /[.,]\d{1,2}\b/.test(valStr);
        
        const val = parseNumberString(digitsOnly);
        if (!isNaN(val)) {
            validAmounts.push({
                value: isNegative ? -val : val,
                hasDecimal: hasDecimal
            });
        }
    }
    
    if (validAmounts.length > 0) {
        const finalCandidate = validAmounts[validAmounts.length - 1];
        
        // HEURISTIC FIX: Only fallback to an earlier number if the rightmost number
        // lacks a decimal (e.g. a quantity like "2") and an earlier number has a decimal.
        // If the rightmost number has a decimal (like "7.00" or "418.00"), it is the price!
        // This prevents Guest Folio IDs (like "9081") from being matched as prices.
        if (validAmounts.length > 1 && !finalCandidate.hasDecimal) {
            for (let i = validAmounts.length - 2; i >= 0; i--) {
                if (validAmounts[i].hasDecimal) {
                    return {
                        baseAmount: validAmounts[i].value,
                        vatAmount,
                        vatRate
                    };
                }
            }
        }
        baseAmount = finalCandidate.value;
    }
    
    return {
        baseAmount,
        vatAmount,
        vatRate
    };
}

// ==========================================
// Stateful Row Combiner (Reconstructs Wrapped Text)
// ==========================================
function reconstructInvoiceLines(lines) {
    const assembled = [];
    let currentItem = null;
    
    for (const line of lines) {
        const lineClean = line.trim();
        if (!lineClean) continue;
        
        const date = extractDate(lineClean);
        
        // Remove date from amount validation target to avoid number confusion
        let cleanForVat = lineClean;
        if (date) {
            // Replaces all occurrences of the extracted date string with space
            const escapedDate = date.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            cleanForVat = cleanForVat.replace(new RegExp(escapedDate, 'g'), '');
        }
        
        const details = parseAmountAndVat(cleanForVat);
        
        if (currentItem) {
            // Merge A: Item has a date but no base amount, and this new line provides the amount
            if (currentItem.Date && !currentItem.BaseAmount && details.baseAmount) {
                currentItem.RowText += " | " + lineClean;
                currentItem.BaseAmount = details.baseAmount;
                currentItem.VatAmount = details.vatAmount;
                currentItem.VatRate = details.vatRate;
                continue;
            }
            // Merge B: Line has no date and no amount (wrapped details)
            if (!date && !details.baseAmount && !details.vatAmount) {
                currentItem.RowText += " | " + lineClean;
                continue;
            }
        }
        
        if (currentItem) {
            assembled.push(currentItem);
        }
        
        currentItem = {
            Date: date ? date : '',
            RowText: lineClean,
            BaseAmount: details.baseAmount,
            VatAmount: details.vatAmount,
            VatRate: details.vatRate
        };
    }
    
    if (currentItem) {
        assembled.push(currentItem);
    }
    
    return assembled;
}

// ==========================================
// Layout-Aware PDF Text Extractor
// ==========================================
async function extractTextFromPDFPage(page) {
    const textContent = await page.getTextContent();
    const items = textContent.items;
    
    const lines = {};
    for (const item of items) {
        if (!item.str.trim()) continue;
        const y = Math.round(item.transform[5]);
        const x = item.transform[4];
        
        let clusterY = null;
        for (const existingY of Object.keys(lines)) {
            if (Math.abs(existingY - y) < 4) {
                clusterY = existingY;
                break;
            }
        }
        
        if (clusterY !== null) {
            lines[clusterY].push({ x, str: item.str });
        } else {
            lines[y] = [{ x, str: item.str }];
        }
    }
    
    const sortedY = Object.keys(lines).map(Number).sort((a, b) => b - a);
    return sortedY.map(y => {
        const sortedItems = lines[y].sort((a, b) => a.x - b.x);
        return sortedItems.map(item => item.str).join(" ");
    });
}

function checkPageAlphanumericRatio(lines) {
    const text = lines.join(" ");
    if (text.length < 50) return false;
    
    const alphanumericCount = (text.match(/[a-zA-Z0-9]/g) || []).length;
    return (alphanumericCount / text.length) >= 0.3;
}

// ==========================================
// Core Parser Routing Pipeline (Scheduler Parallel Queue)
// ==========================================
async function processInvoice(arrayBuffer) {
    appState.extractedRows = [];
    updateProgressBar(5, "Loading PDF document...");
    
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    const totalPages = pdf.numPages;
    
    const scannedJobs = [];
    
    // 1. Pre-scan all pages to execute text extracts and queue scanned targets
    for (let i = 1; i <= totalPages; i++) {
        updateProgressBar(Math.round((i / totalPages) * 15) + 5, `Pre-scanning layouts (Page ${i}/${totalPages})...`);
        const page = await pdf.getPage(i);
        const textLines = await extractTextFromPDFPage(page);
        
        const isTextBased = checkPageAlphanumericRatio(textLines);
        if (isTextBased) {
            const items = reconstructInvoiceLines(textLines);
            items.forEach(item => {
                if (item.BaseAmount !== 0 || item.VatAmount !== 0) {
                    appState.extractedRows.push({
                        Page: i,
                        Date: item.Date,
                        RowText: item.RowText,
                        BaseAmount: item.BaseAmount,
                        VatAmount: item.VatAmount,
                        VatRate: item.VatRate
                    });
                }
            });
        } else {
            const canvas = await renderPageToCanvas(page);
            scannedJobs.push({
                pageNum: i,
                canvas: canvas
            });
        }
    }
    
    // 2. Parallel OCR Queue Execution via Web Workers Scheduler
    if (scannedJobs.length > 0) {
        const totalScanned = scannedJobs.length;
        updateProgressBar(22, `Spawning concurrent OCR workers for ${totalScanned} scanned pages...`);
        
        const scheduler = Tesseract.createScheduler();
        
        // Spawn up to 4 parallel workers to run OCR concurrently
        const concurrency = Math.min(4, totalScanned);
        const workers = [];
        for (let w = 0; w < concurrency; w++) {
            const worker = await Tesseract.createWorker();
            await worker.loadLanguage('eng');
            await worker.initialize('eng');
            scheduler.addWorker(worker);
            workers.push(worker);
        }
        
        let completedJobs = 0;
        updateProgressBar(25, `Running parallel OCR (0/${totalScanned} pages completed)...`);
        
        const ocrPromises = scannedJobs.map(job => {
            return scheduler.addJob('recognize', job.canvas)
                .then(result => {
                    completedJobs++;
                    const progressVal = Math.round((completedJobs / totalScanned) * 70) + 25;
                    updateProgressBar(progressVal, `Running parallel OCR (${completedJobs}/${totalScanned} pages completed)...`);
                    
                    const ocrLines = result.data.text.split("\n");
                    const items = reconstructInvoiceLines(ocrLines);
                    items.forEach(item => {
                        if (item.BaseAmount !== 0 || item.VatAmount !== 0) {
                            appState.extractedRows.push({
                                Page: job.pageNum,
                                Date: item.Date,
                                RowText: item.RowText,
                                BaseAmount: item.BaseAmount,
                                VatAmount: item.VatAmount,
                                VatRate: item.VatRate
                            });
                        }
                    });
                })
                .catch(err => {
                    console.error(`OCR failed on page ${job.pageNum}:`, err);
                    completedJobs++;
                });
        });
        
        await Promise.all(ocrPromises);
        await scheduler.terminate();
    }
    
    updateProgressBar(100, "Invoice parsed successfully!");
    
    // Sort array by Page order since parallel OCR executes asynchronously
    appState.extractedRows.sort((a, b) => a.Page - b.Page);
    
    setTimeout(() => {
        DOM.progressIndicator.classList.add('hidden');
        DOM.searchBtn.disabled = false;
        startSecurityTimer();
    }, 1200);
}

async function renderPageToCanvas(page) {
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.height = viewport.height;
    canvas.width = viewport.width;
    
    const renderContext = {
        canvasContext: context,
        viewport: viewport
    };
    await page.render(renderContext).promise;
    return canvas;
}

// ==========================================
// Interactive Audit Search Logic
// ==========================================
function executeAuditSearch() {
    if (appState.extractedRows.length === 0) return;
    
    const termInputs = DOM.searchTermsList.querySelectorAll('.term-input');
    const terms = [];
    termInputs.forEach(input => {
        const val = input.value.trim();
        if (val) terms.push(val);
    });
    
    if (terms.length === 0) {
        alert("Please add at least one search term.");
        return;
    }
    
    DOM.resultsSection.innerHTML = '';
    DOM.resultsSection.classList.remove('hidden');
    
    terms.forEach(term => {
        const matchedRows = appState.extractedRows.filter(row => {
            const regex = new RegExp(escapeRegExp(term), 'gi');
            return row.RowText.match(regex) !== null;
        });
        
        renderTermCard(term, matchedRows);
    });
    
    DOM.resultsSection.scrollIntoView({ behavior: 'smooth' });
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Render term card containing dynamic VAT grouping breakdowns
function renderTermCard(term, matchedRows) {
    const card = document.createElement('div');
    card.className = 'term-result-box';
    
    if (matchedRows.length === 0) {
        card.innerHTML = `
            <div class="term-result-header">
                <h3>Term: "${term}"</h3>
                <span class="badge" style="background: var(--danger-light); color: var(--danger); border: 1px solid rgba(239, 68, 68, 0.2); box-shadow: none;">0 matches</span>
            </div>
            <p style="color: var(--text-muted); font-size: 0.95rem;">No items matched this term in the invoice.</p>
        `;
        DOM.resultsSection.appendChild(card);
        return;
    }
    
    // Group matches by VAT rates (e.g. 0, 9, 21, or null/'N/A')
    const vatGroups = {};
    let totalBase = 0.0;
    let totalVat = 0.0;
    
    matchedRows.forEach(row => {
        const rateKey = row.VatRate !== null ? `${row.VatRate}%` : 'Other/Unknown';
        
        if (!vatGroups[rateKey]) {
            vatGroups[rateKey] = {
                rateLabel: rateKey,
                count: 0,
                baseSum: 0.0,
                vatSum: 0.0,
                grossSum: 0.0,
                rows: []
            };
        }
        
        vatGroups[rateKey].count++;
        vatGroups[rateKey].baseSum += row.BaseAmount;
        vatGroups[rateKey].vatSum += row.VatAmount;
        vatGroups[rateKey].grossSum += (row.BaseAmount + row.VatAmount);
        vatGroups[rateKey].rows.push(row);
        
        totalBase += row.BaseAmount;
        totalVat += row.VatAmount;
    });
    
    const totalGross = totalBase + totalVat;
    
    // Build VAT Breakdown HTML lines
    let vatBreakdownRowsHtml = '';
    Object.keys(vatGroups).sort().forEach(key => {
        const g = vatGroups[key];
        vatBreakdownRowsHtml += `
            <div class="vat-breakdown-row">
                <span class="vat-rate-label">${g.rateLabel}</span>
                <span class="text-right" style="font-weight: 600;">${g.count}</span>
                <span class="text-right">€${g.baseSum.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                <span class="text-right">€${g.vatSum.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                <span class="text-right" style="font-weight: 700; color: var(--text-main);">€${g.grossSum.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
        `;
    });
    
    // Build Detailed Rows Table Lines
    let tableRowsHtml = '';
    matchedRows.forEach(row => {
        const regex = new RegExp(`(${escapeRegExp(term)})`, 'gi');
        const highlightedText = row.RowText.replace(regex, `<span class="highlight-match">$1</span>`);
        
        const rateLabel = row.VatRate !== null ? `${row.VatRate}%` : '<span style="color: var(--text-muted);">N/A</span>';
        
        tableRowsHtml += `
            <tr>
                <td>Page ${row.Page}</td>
                <td>${row.Date ? row.Date : '<span style="color: var(--text-muted); font-style: italic;">No Date</span>'}</td>
                <td>${highlightedText}</td>
                <td class="text-right">${row.VatRate !== null ? rateLabel : 'Other'}</td>
                <td class="text-right">€${row.BaseAmount.toFixed(2)}</td>
                <td class="text-right">€${row.VatAmount.toFixed(2)}</td>
                <td class="text-right" style="font-weight: 600; color: var(--text-main);">€${(row.BaseAmount + row.VatAmount).toFixed(2)}</td>
            </tr>
        `;
    });
    
    // Set Card Container HTML
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
            ${vatBreakdownRowsHtml}
        </div>
        
        <div class="term-combined-summary">
            <div class="summary-metric">
                <span class="metric-label">Combined Base</span>
                <span class="metric-val">€${totalBase.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
            <div class="summary-metric">
                <span class="metric-label">Combined VAT</span>
                <span class="metric-val">€${totalVat.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
            <div class="summary-metric highlight">
                <span class="metric-label">Combined Total</span>
                <span class="metric-val">€${totalGross.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
        </div>
        
        <div class="term-details-control">
            <button class="btn btn-secondary btn-sm toggle-details-btn" onclick="toggleDetailsLog(this)">
                <i class="fa-solid fa-chevron-down"></i> View Detailed Log
            </button>
            
            <div class="details-log-wrapper hidden">
                <div class="table-wrapper">
                    <table class="audit-table">
                        <thead>
                            <tr>
                                <th>Page</th>
                                <th>Date</th>
                                <th>Matched Item Description</th>
                                <th class="text-right">VAT Rate</th>
                                <th class="text-right">Base Amount</th>
                                <th class="text-right">VAT Amount</th>
                                <th class="text-right">Gross Total</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${tableRowsHtml}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    `;
    DOM.resultsSection.appendChild(card);
}

// Global Toggle Details function
window.toggleDetailsLog = function(btn) {
    const wrapper = btn.nextElementSibling;
    
    if (wrapper.classList.contains('hidden')) {
        wrapper.classList.remove('hidden');
        btn.innerHTML = `<i class="fa-solid fa-chevron-up"></i> Hide Detailed Log`;
    } else {
        wrapper.classList.add('hidden');
        btn.innerHTML = `<i class="fa-solid fa-chevron-down"></i> View Detailed Log`;
    }
};

// ==========================================
// Security Timer & Reset Controllers
// ==========================================
function startSecurityTimer() {
    clearInterval(appState.timerInterval);
    appState.countdownSeconds = 1200; // Reset to 20 minutes
    DOM.securityTimer.classList.remove('hidden');
    
    updateTimerDisplay();
    appState.timerInterval = setInterval(() => {
        appState.countdownSeconds--;
        updateTimerDisplay();
        
        if (appState.countdownSeconds <= 0) {
            clearInvoiceData();
            alert("⏰ Security Alert: 20 minutes elapsed. For data privacy, invoice data has been auto-deleted.");
        }
    }, 1000);
}

function updateTimerDisplay() {
    const mins = Math.floor(appState.countdownSeconds / 60);
    const secs = appState.countdownSeconds % 60;
    DOM.countdownDisplay.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function clearInvoiceData() {
    clearInterval(appState.timerInterval);
    appState.extractedRows = [];
    
    // UI Reset
    DOM.fileInput.value = '';
    DOM.fileStatusContainer.classList.add('hidden');
    DOM.progressIndicator.classList.add('hidden');
    DOM.securityTimer.classList.add('hidden');
    DOM.resultsSection.classList.add('hidden');
    DOM.resultsSection.innerHTML = '';
    DOM.searchBtn.disabled = true;
    
    // Re-initialize default inputs
    DOM.searchTermsList.innerHTML = `
        <div class="term-input-row">
            <input type="text" placeholder="e.g. Night Stay, Room, Package Charge, Logies" class="term-input">
            <button class="btn-remove-term" onclick="this.parentElement.remove()" title="Remove term">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
    `;
}

function updateProgressBar(percentage, text) {
    DOM.progressIndicator.classList.remove('hidden');
    DOM.progressBar.style.width = `${percentage}%`;
    DOM.progressText.textContent = text;
}

// ==========================================
// Application Core Events
// ==========================================
function initAppEvents() {
    // Theme Toggle Controller
    DOM.themeToggleBtn.addEventListener('click', () => {
        if (document.body.classList.contains('theme-dark-yellow')) {
            document.body.classList.remove('theme-dark-yellow');
            document.body.classList.add('theme-dark-blue');
        } else {
            document.body.classList.remove('theme-dark-blue');
            document.body.classList.add('theme-dark-yellow');
        }
    });

    // File Picker Handler
    DOM.fileInput.addEventListener('change', handleFileSelect);
    
    // Dropzone Drag-and-drop Events
    ['dragenter', 'dragover'].forEach(eventName => {
        DOM.dropzone.addEventListener(eventName, e => {
            e.preventDefault();
            DOM.dropzone.classList.add('dragover');
        }, false);
    });
    
    ['dragleave', 'drop'].forEach(eventName => {
        DOM.dropzone.addEventListener(eventName, e => {
            e.preventDefault();
            DOM.dropzone.classList.remove('dragover');
        }, false);
    });
    
    DOM.dropzone.addEventListener('drop', e => {
        const files = e.dataTransfer.files;
        if (files.length > 0 && files[0].type === 'application/pdf') {
            DOM.fileInput.files = files;
            handleFileSelect();
        } else {
            alert("Please drop a valid PDF file.");
        }
    });

    // Add search term fields
    DOM.addTermBtn.addEventListener('click', () => {
        const row = document.createElement('div');
        row.className = 'term-input-row';
        row.innerHTML = `
            <input type="text" placeholder="Enter term..." class="term-input">
            <button class="btn-remove-term" onclick="this.parentElement.remove()" title="Remove term">
                <i class="fa-solid fa-xmark"></i>
            </button>
        `;
        DOM.searchTermsList.appendChild(row);
        row.querySelector('.term-input').focus();
    });

    // Search and Delete actions
    DOM.searchBtn.addEventListener('click', executeAuditSearch);
    DOM.clearDataBtn.addEventListener('click', clearInvoiceData);
}

function handleFileSelect() {
    const file = DOM.fileInput.files[0];
    if (!file) return;
    
    DOM.fileStatusContainer.classList.remove('hidden');
    DOM.fileNameDisplay.textContent = file.name;
    DOM.fileSizeDisplay.textContent = `${Math.round(file.size / 1024).toLocaleString()} KB`;
    
    DOM.resultsSection.classList.add('hidden');
    DOM.resultsSection.innerHTML = '';
    DOM.securityTimer.classList.add('hidden');
    DOM.searchBtn.disabled = true;
    
    const reader = new FileReader();
    reader.onload = function(e) {
        processInvoice(e.target.result).catch(error => {
            console.error(error);
            updateProgressBar(0, "Error occurred during file parsing.");
            alert("❌ An error occurred while parsing the invoice. Please verify if it's a valid PDF.");
        });
    };
    reader.readAsArrayBuffer(file);
}

// Run events binding on page load
window.addEventListener('DOMContentLoaded', initAppEvents);
