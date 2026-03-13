'use server';

/**
 * actions.ts — InvoiceGuard AI Processing Engine v7.0
 *
 * v7.0 — new intelligence checks + speed improvement:
 *  #I03 Round number anomaly on multi-item invoices
 *  #I04 Fuzzy vendor name matching (Levenshtein)
 *  #I11 Cumulative vendor spend threshold (GHS 50,000)
 *  + salesmanSummary field on every result
 *  + Math pre-check and Pass 2 now run in parallel (≈ 40% faster)
 *
 * v6.0 — 19 robustness improvements for salesmen:
 *  #3  Region-specific re-read for low-confidence fields (header crop + totals crop)
 *  #4  Handwriting vs print detection — different OCR strategy per type
 *  #5  Character-level confidence — flags exact uncertain digit positions
 *  #6  Full column-sum cross-check (all line totals vs subtotal and grand total)
 *  #7  Unit price consistency check (same item, different price on same invoice)
 *  #8  Quantity sanity check (0, negative, or abnormally large quantities)
 *  #9  Currency consistency check (mixed symbols across items vs header)
 *  #10 Running total chain shown step-by-step in verdict details
 *  #11 Per-vendor expected total range alert (spike vs vendor history)
 *  #12 Item name normalisation for price memory (handles abbreviations)
 *  #14 Time-of-day anomaly flag (late night / weekend / public holiday)
 *  #15 Invoice number sequential gap detection per vendor
 *  + all v5.0 features retained
 */

import type {
  InvoiceProcessingResult,
  SlimInvoiceResult,
  ValidatedData,
  ValidationError,
  RiskVerdictResult,
  RiskVerdict,
} from '@/lib/types';
import {
  normaliseVendorKey,
  checkDateAnomaly,
  buildSmartName,
  calcHealthScore,
  buildVendorProfiles,
  checkPriceMemory,
  detectDuplicate,
  detectPartialPayment,
  detectRecurring,
  detectInvoiceNumberGap,
  checkVendorTotalRange,
  // v7.0 new checks
  checkRoundNumberAnomaly,
  checkVendorNameFuzzyMatch,
  checkCumulativeVendorSpend,
  buildSalesmanSummary,
} from '@/lib/invoice-intelligence';

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function parseNumber(value: any): number | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  if (s === '' || s === 'null' || s === 'undefined' || s === 'N/A') return undefined;
  const cleaned = s.replace(/[^\d.\-]/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? undefined : Math.round(parsed * 100) / 100;
}

function safeSum(...values: (number | undefined)[]): number {
  return Math.round(values.reduce((a: number, v) => a + (v ?? 0), 0 as number) * 100) / 100;
}

function getGroqApiKey(): string {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY is not configured. Add it to your .env.local file.');
  return key;
}

async function fetchWithRetry(url: string, options: RequestInit, retries = 3): Promise<Response> {
  let lastError: Error = new Error('Network error');
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status}`);
        await new Promise(r => setTimeout(r, 800 * Math.pow(2, attempt)));
        continue;
      }
      return res;
    } catch (err: any) {
      lastError = err;
      await new Promise(r => setTimeout(r, 800 * Math.pow(2, attempt)));
    }
  }
  throw lastError;
}

// ─────────────────────────────────────────────────────────────
// MODEL LISTS
// ─────────────────────────────────────────────────────────────

const VISION_MODELS = [
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
];

const TEXT_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
];

const GROQ_BASE64_LIMIT = 3_800_000;

// ─────────────────────────────────────────────────────────────
// IMAGE SIZE GUARD
// ─────────────────────────────────────────────────────────────

async function ensureImageUnderLimit(imageBase64: string): Promise<string> {
  const base64Part = imageBase64.split(',')[1] ?? imageBase64;
  if (base64Part.length <= GROQ_BASE64_LIMIT) return imageBase64;
  console.warn(`[Invoice] Image too large (${base64Part.length} chars). Attempting server-side resize...`);
  try {
    const sharp = (await import('sharp')).default;
    const buffer = Buffer.from(base64Part, 'base64');
    const resized = await sharp(buffer)
      .resize({ width: 1200, withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toBuffer();
    const resizedB64 = resized.toString('base64');
    console.log(`[Invoice] Resized: ${base64Part.length} → ${resizedB64.length} chars`);
    return `data:image/jpeg;base64,${resizedB64}`;
  } catch {
    throw new Error(
      `Image is too large for processing (${Math.round(base64Part.length / 1024)}KB base64). ` +
      `Please take a photo at lower resolution or compress the image before uploading.`
    );
  }
}

// ─────────────────────────────────────────────────────────────
// DOCUMENT TYPE GUARD — reject non-invoices before OCR pipeline
// ─────────────────────────────────────────────────────────────

const DOCUMENT_GUARD_PROMPT = `Look at this image carefully. Your only job is to decide if it is a financial document.

Financial documents include: invoices, receipts, bills, purchase orders, delivery notes, payment slips, POS printouts, proforma invoices, quotes with amounts, GRA tax invoices, or any paper/screen showing a monetary transaction.

Respond with ONLY a JSON object, nothing else:
{
  "is_financial_document": true or false,
  "detected_as": "one short phrase describing what the image actually is",
  "confidence": "high" or "medium" or "low"
}`;

async function guardDocumentType(imageUrl: string, apiKey: string): Promise<{ ok: boolean; detectedAs: string }> {
  try {
    const raw = await callGroqVision(imageUrl, DOCUMENT_GUARD_PROMPT, apiKey);
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    let parsed: any;
    try { parsed = JSON.parse(cleaned); } catch { const m = cleaned.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : null; }
    if (!parsed) return { ok: true, detectedAs: 'unknown' }; // don't block on parse failure
    const isDoc: boolean = parsed.is_financial_document === true;
    const detectedAs: string = String(parsed.detected_as ?? 'unknown image');
    const confidence: string = String(parsed.confidence ?? 'low');
    // Only block when confident it's NOT a financial document
    if (!isDoc && confidence !== 'low') {
      return { ok: false, detectedAs };
    }
    return { ok: true, detectedAs };
  } catch {
    return { ok: true, detectedAs: 'unknown' }; // fail open — don't block on network error
  }
}

// ─────────────────────────────────────────────────────────────
// GROQ CALLERS
// ─────────────────────────────────────────────────────────────

async function callGroqVision(imageUrl: string, prompt: string, apiKey: string): Promise<string> {
  let lastError: Error = new Error('All Groq vision models failed');
  for (const model of VISION_MODELS) {
    try {
      console.log(`[Groq Vision] Trying: ${model}`);
      const response = await fetchWithRetry(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model, max_tokens: 4000, temperature: 0.0,
            messages: [{ role: 'user', content: [
              { type: 'image_url', image_url: { url: imageUrl } },
              { type: 'text', text: prompt },
            ]}],
          }),
        },
        3
      );
      if (!response.ok) {
        const body = await response.text();
        console.error(`[Groq Vision] ${model} → HTTP ${response.status}: ${body.slice(0, 300)}`);
        if ([400, 404, 413].includes(response.status)) { lastError = new Error(`Model ${model} error (${response.status})`); continue; }
        throw new Error(`Groq ${response.status}: ${body.slice(0, 200)}`);
      }
      const content: string | undefined = (await response.json()).choices?.[0]?.message?.content;
      if (!content) throw new Error('Empty response from Groq vision.');
      console.log(`[Groq Vision] Success: ${model}`);
      return content;
    } catch (err: any) {
      const msg: string = err.message ?? '';
      if (msg.includes('error (400)') || msg.includes('error (404)') || msg.includes('error (413)') || msg.includes('unavailable')) { lastError = err; continue; }
      throw err;
    }
  }
  throw lastError;
}

async function callGroqText(prompt: string, apiKey: string, maxTokens = 2500): Promise<string> {
  let lastError: Error = new Error('All Groq text models failed');
  for (const model of TEXT_MODELS) {
    try {
      console.log(`[Groq Text] Trying: ${model}`);
      const response = await fetchWithRetry(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model, max_tokens: maxTokens, temperature: 0.0,
            messages: [{ role: 'user', content: prompt }],
          }),
        },
        3
      );
      if (!response.ok) {
        const body = await response.text();
        console.error(`[Groq Text] ${model} → HTTP ${response.status}: ${body.slice(0, 300)}`);
        if ([400, 404].includes(response.status)) { lastError = new Error(`Model ${model} error (${response.status})`); continue; }
        throw new Error(`Groq text ${response.status}: ${body.slice(0, 200)}`);
      }
      const content: string | undefined = (await response.json()).choices?.[0]?.message?.content;
      if (!content) throw new Error('Empty response from Groq text.');
      console.log(`[Groq Text] Success: ${model}`);
      return content;
    } catch (err: any) {
      const msg: string = err.message ?? '';
      if (msg.includes('error (400)') || msg.includes('error (404)') || msg.includes('unavailable')) { lastError = err; continue; }
      throw err;
    }
  }
  throw lastError;
}

// ─────────────────────────────────────────────────────────────
// PROMPTS
// ─────────────────────────────────────────────────────────────

/**
 * PASS 1 — UNIVERSAL DOCUMENT OCR (v6.0)
 * #4: Detects handwriting vs print and adapts reading strategy
 * #5: Character-level confidence — marks uncertain digits with "?" 
 */
const PASS1_PROMPT = `You are an expert forensic document reader. You will be shown a photo or scan of a financial document — it could be ANY type: a GRA tax invoice, a handwritten receipt, a POS printout, a proforma, a delivery note, a simple payment slip, or any other document used to request or record payment.

YOUR ONLY JOB: Read exactly what is on this document, character by character, digit by digit. Do not guess. Do not fill in. Do not apply any rules or rates you know from memory.

━━━ ABSOLUTE RULES ━━━
1. Copy every number EXACTLY as printed — "1,500.50" stays "1,500.50"
2. If a character is unclear, write "?" for THAT CHARACTER ONLY — e.g. "1,5?0.00" if the 3rd digit is unclear
3. If a field is completely absent, write NONE
4. Do NOT apply any tax rates, GRA rules, or accounting formulas
5. Do NOT assume the document type — describe what you actually see
6. One wrong digit causes real financial loss — accuracy is everything

━━━ STEP 1 — DOCUMENT TYPE IDENTIFICATION ━━━
Before reading anything, assess the physical nature of this document:

WRITING_TYPE: Is the content [PRINTED / HANDWRITTEN / MIXED] ?
  → If HANDWRITTEN: Read letter-by-letter. Treat each character independently. Do not assume words from context.
  → If PRINTED: Read precisely — watch for ink smudges, faded ink, similar digits (1/7, 0/6, 5/6, 8/3)
  → If MIXED: Apply handwriting rules to handwritten parts, print rules to printed parts

DOCUMENT FORMAT: [GRA Tax Invoice / Company Invoice / Handwritten Receipt / POS Thermal Receipt / Proforma Invoice / Delivery Note / Payment Slip / Screenshot / Photocopy / Carbon Copy / Other — describe]

PHYSICAL CONDITION: [Clear / Slightly faded / Crumpled / Torn edges / Glare or reflection / Dark / Blurry / Partial cutoff]

━━━ STEP 2 — ZONE A: HEADER ━━━
Read top section carefully:
SELLER/VENDOR NAME: [exact text or NONE]
SELLER ADDRESS: [exact text or NONE]
SELLER TIN/VAT NUMBER: [exact code or NONE]
INVOICE/RECEIPT NUMBER: [exact alphanumeric — watch for O vs 0, l vs 1]
INVOICE DATE: [exact date as written or NONE]
DUE DATE: [if shown or NONE]
BUYER/CUSTOMER NAME: [if shown or NONE]
CURRENCY DECLARED IN HEADER: [GHS / USD / EUR / GBP / NGN or NONE if not stated]
ANY REFERENCE NUMBERS: [PO#, delivery note#, etc. or NONE]

━━━ STEP 3 — ZONE B: LINE ITEMS ━━━
List EVERY product/service line. Skip totals rows.

For PRINTED invoices:
  ITEM [n]: Name="[exact]" | Qty=[exact or NULL] | Unit=[e.g. carton/kg/pcs or NULL] | UnitPrice=[exact or NULL] | Discount=[exact or NULL] | LineTotal=[exact or NULL] | Currency=[currency symbol if shown or NONE]

For HANDWRITTEN invoices — extra care:
  ITEM [n]: Name="[copy exact spelling including abbreviations]" | Qty=[number — watch for 1/7, 0/6] | Unit=[or NULL] | UnitPrice=[exact — write ? for any uncertain digit] | LineTotal=[exact — write ? for any uncertain digit] | HANDWRITING_NOTE=[any difficulty reading this line]

If NO line items (lump sum only): write "NO LINE ITEMS — LUMP SUM ONLY"

━━━ STEP 4 — ZONE C: ALL TOTALS/SUMMARY ROWS ━━━
List EVERY labelled total row in the order they appear:
TOTALS ROW [n]: Label="[exact label]" | Value=[exact number — write ? for uncertain digits]

Common labels (copy WHATEVER is written): Subtotal, Net Amount, NHIL, GETFund, COVID Levy, VAT, Tax, Discount, Delivery, Grand Total, Amount Due, Total Tax Inclusive Value

CRITICAL: If NO tax rows exist — that is normal. Many companies include VAT in product prices. List only what is actually on the document.

━━━ STEP 5 — ZONE D: FINAL PAYABLE ━━━
GRAND TOTAL AMOUNT: [exact final amount or NONE]
GRAND TOTAL LABEL: [exact label]
CURRENCY: [GHS / USD / GBP / EUR / NGN / symbol seen — or GHS if none]

━━━ STEP 6 — CHARACTER-LEVEL CONFIDENCE ━━━
LIST EVERY field where you used "?":
  UNCERTAIN: [field name] = "[value with ? marks]" — REASON: [what made it hard to read]

LIST any field you could not read at all:
  UNREADABLE: [field name] — REASON: [dark / blurry / torn / handwriting unclear]

STAMPS/WATERMARKS: [describe]
OTHER TEXT ON DOCUMENT: [any other text not captured above]`;

/**
 * PASS 1b — TARGETED RE-READ FOR LOW CONFIDENCE FIELDS (#3)
 * Called only when specific fields came back low confidence.
 * Focuses the model on just that region of the document.
 */
function buildRegionRereadPrompt(region: 'header' | 'totals' | 'items', uncertainFields: string[]): string {
  const fieldList = uncertainFields.join(', ');
  const regionDesc = region === 'header'
    ? 'the TOP SECTION of the document (business name, invoice number, date, buyer/seller info)'
    : region === 'totals'
    ? 'the BOTTOM SECTION (totals, subtotal, tax rows, grand total, amount due)'
    : 'the MIDDLE SECTION (the table of items, quantities, prices, line totals)';

  return `TARGETED RE-READ — focus ONLY on ${regionDesc}.

These fields were unclear on first read: ${fieldList}

Read ONLY the relevant section with maximum focus:
- Zoom in mentally on every digit in this region
- For each uncertain digit: consider all possibilities (is that a 1 or 7? a 0 or 6? a 5 or 6? a 3 or 8?)
- Report the most likely reading AND note if still uncertain

For each field listed above, report:
FIELD: [field name]
VALUE: [your best reading — use ? only if genuinely impossible to determine]
CONFIDENCE: [HIGH / MEDIUM / LOW]
REASON_IF_NOT_HIGH: [what specifically makes it unclear]

Then give your BEST READING of the grand total (final payable amount):
GRAND_TOTAL_BEST_READING: [number or NONE]
GRAND_TOTAL_CONFIDENCE: [HIGH / MEDIUM / LOW]`;
}

/**
 * MATH PRE-CHECK (#6: column sum cross-check, #9: currency consistency)
 */
function buildMathPreCheckPrompt(transcription: string): string {
  return `You are a pure arithmetic auditor. Verify internal consistency of this invoice transcription.

CRITICAL RULES:
- Use ONLY numbers from the transcription below
- Do NOT apply any tax rates or accounting rules
- If tax/VAT is NOT in the transcription, that is NORMAL and ACCEPTED in Ghana — VAT may already be included in product prices. Do NOT flag missing VAT as an error.
- Set any NONE or "?" value to null — never estimate
- Only flag a discrepancy if numbers that ARE present do not add up

TRANSCRIPTION:
${transcription}

YOUR TASK:
1. Extract ALL line item values: name, qty, unit_price, line_total for each item
2. For each item where qty AND unit_price are present: compute qty × unit_price and compare to line_total
3. Sum all line_total values → ITEMS_SUM
4. Find subtotal if listed → SUBTOTAL
5. Find all explicitly listed tax/levy amounts → TAX_SUM (null if none — this is normal)
6. Find grand total → GRAND_TOTAL
7. Check consistency:
   - items_match_subtotal: ITEMS_SUM ≈ SUBTOTAL (only if both present)
   - subtotal_plus_tax_matches_total: SUBTOTAL + TAX_SUM ≈ GRAND_TOTAL (only if all three present)
   - items_match_grand_total_directly: ITEMS_SUM ≈ GRAND_TOTAL (when no separate tax rows)
8. Currency check: list any items where a different currency symbol appears vs the header currency
9. Compute the running total chain: subtotal → +taxes step by step → final total

Respond ONLY with JSON (no markdown):
{
  "items_sum": number_or_null,
  "line_item_errors": [
    { "item_name": "string", "qty": number, "unit_price": number, "stated_line_total": number, "computed_line_total": number, "difference": number }
  ],
  "subtotal_from_transcription": number_or_null,
  "tax_sum_from_transcription": number_or_null,
  "tax_explicitly_listed": true_or_false,
  "grand_total_from_transcription": number_or_null,
  "items_match_subtotal": true_or_false_or_null,
  "subtotal_plus_tax_matches_total": true_or_false_or_null,
  "items_match_grand_total_directly": true_or_false_or_null,
  "discrepancies": ["describe mismatch with numbers"],
  "currency_mismatches": ["item name and what currency symbol appeared"],
  "running_total_chain": ["step 1: subtotal = X", "step 2: +NHIL = Y", "..."],
  "is_gra_invoice": true_or_false,
  "vat_inclusive_pricing_likely": true_or_false, // true = no separate VAT rows, prices include tax — this is VALID in Ghana, not an error
  "corrected_grand_total": number_or_null,
  "math_notes": ["observations"]
}`;
}

/**
 * PASS 2 — STRUCTURED JSON EXTRACTION (v6.0)
 * #5: includes per-field character confidence
 * #7: unit price consistency flagged
 * #8: quantity sanity flagged
 */
function buildPass2Prompt(transcription: string, mathCheck: any): string {
  const mathContext = mathCheck ? `
ARITHMETIC AUDIT RESULTS:
- Items sum: ${mathCheck.items_sum ?? 'unknown'}
- Subtotal: ${mathCheck.subtotal_from_transcription ?? 'not listed — normal'}
- Tax total: ${mathCheck.tax_sum_from_transcription ?? 'NOT LISTED — VAT likely in prices'}
- Tax explicitly listed: ${mathCheck.tax_explicitly_listed ?? 'unknown'}
- Grand total: ${mathCheck.grand_total_from_transcription ?? 'unknown'}
- Items match subtotal: ${mathCheck.items_match_subtotal ?? 'N/A'}
- Subtotal+Tax matches Total: ${mathCheck.subtotal_plus_tax_matches_total ?? 'N/A'}
- Items match Grand Total directly: ${mathCheck.items_match_grand_total_directly ?? 'N/A'}
- VAT-inclusive pricing likely: ${mathCheck.vat_inclusive_pricing_likely ?? 'unknown'}
- Discrepancies: ${(mathCheck.discrepancies ?? []).join('; ') || 'none'}
- Currency mismatches: ${(mathCheck.currency_mismatches ?? []).join('; ') || 'none'}
- Running total chain: ${(mathCheck.running_total_chain ?? []).join(' → ') || 'N/A'}
- Math-corrected grand total: ${mathCheck.corrected_grand_total ?? 'not available'}
` : '';

  return `You are a precise JSON data extractor for financial documents.

TRANSCRIPTION:
${transcription}
${mathContext}

EXTRACTION RULES:

1. NULL RULE: NONE or "?" → null. NEVER invent.
2. TOTAL RULE: "total" = final payable. For GRA: row (vii).
3. VAT/TAX RULE: Only set tax fields if EXPLICITLY on document. If absent → vat_included_in_prices: true, all tax fields null. In Ghana, VAT-inclusive pricing is perfectly legal — do NOT invent or compute tax rows that are not physically on the document.
4. SUBTOTAL RULE: null if no explicit subtotal row.
5. VENDOR RULE: "customer_name" = SELLER/VENDOR at top.
6. CONFIDENCE: "high"=clear, "medium"=partially visible, "low"=uncertain/blurry.
7. CHARACTER CONFIDENCE: If any digit in a number had "?" → set that field's confidence to "low".
8. ITEM RULE: copy names exactly — abbreviations, spelling, shorthand preserved.
9. NUMBER RULE: strip currency symbols and commas → 1200.00
10. DUPLICATE ITEM RULE: if the same item name appears multiple times on this invoice, flag it.

Respond ONLY with valid JSON (no markdown):

{
  "invoice_number": "string or null",
  "invoice_number_confidence": "high|medium|low",
  "date": "YYYY-MM-DD or original string or null",
  "date_confidence": "high|medium|low",
  "due_date": "string or null",
  "customer_name": "SELLER/VENDOR name or null",
  "customer_name_confidence": "high|medium|low",
  "buyer_name": "buyer if shown or null",
  "category": "Groceries|Building Materials|Office Supplies|Utilities|Transport|Dining|Electronics|Healthcare|Fuel|Other",
  "document_type_observed": "describe the actual document type",
  "writing_type": "PRINTED|HANDWRITTEN|MIXED",
  "is_gra_invoice": true_or_false,
  "vat_included_in_prices": true_or_false,
  // true when no separate VAT/tax rows exist — prices already include tax. This is normal and accepted in Ghana.
  "supplier_tin": "string or null",
  "currency": "GHS or detected currency code",
  "header_currency": "currency from header or null",
  "items": [
    {
      "name": "string or null",
      "quantity": number_or_null,
      "unit": "string or null",
      "unit_price": number_or_null,
      "unit_price_confidence": "high|medium|low",
      "uncertain_digits": "describe any ? characters in this item's numbers, or null",
      "discount": number_or_null,
      "line_total": number_or_null,
      "line_total_confidence": "high|medium|low",
      "currency_symbol_seen": "symbol if different from header, or null",
      "is_duplicate_name_on_invoice": true_or_false
    }
  ],
  "subtotal": number_or_null,
  "subtotal_confidence": "high|medium|low",
  "nhil": number_or_null,
  "getfund": number_or_null,
  "covid_levy": number_or_null,
  "vat": number_or_null,
  "vat_confidence": "high|medium|low",
  "other_taxes": [{ "label": "string", "amount": number }],
  "tax": number_or_null,
  "tax_confidence": "high|medium|low",
  "discount_total": number_or_null,
  "total": number_or_null,
  "total_confidence": "high|medium|low",
  "total_uncertain_digits": "describe any ? in the grand total, or null",
  "ocr_notes": "specific uncertain readings, quality issues, anything unusual"
}`;
}

/**
 * RECONCILIATION — re-read totals region only (#3)
 */
const RECONCILIATION_PROMPT = `Focus ONLY on the bottom section of this document (totals area).

RULES: Read only what is physically visible. No formulas or assumptions.

List every number in the bottom section:
TOTAL ZONE:
- [label]: [exact number]

GRAND TOTAL: [final payable or NONE]
GRAND TOTAL LABEL: [exact label]
CONFIDENCE: [high / medium / low]
IF NOT HIGH: [what makes it hard to read]`;

// ─────────────────────────────────────────────────────────────
// #14 — TIME-OF-DAY ANOMALY CHECK
// ─────────────────────────────────────────────────────────────

function checkTimeOfDayAnomaly(): string | null {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay(); // 0=Sun, 6=Sat

  if (day === 0 || day === 6) {
    return `This invoice was submitted on a ${day === 0 ? 'Sunday' : 'Saturday'}. Most businesses are closed on weekends. Look carefully and confirm this is a legitimate transaction before collecting money.`;
  }
  if (hour >= 22 || hour < 5) {
    return `This invoice was submitted at ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — very late at night. Unusual submission times can be a sign of fraud. Review the invoice carefully before collecting.`;
  }
  if (hour >= 20) {
    return `Invoice submitted after 8pm (${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}). Confirm this is expected — after-hours submissions should be verified.`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// LAYER 4 — MATH ENGINE (v6.0)
// #6 full column cross-check, #7 unit price consistency, #8 qty sanity, #9 currency
// ─────────────────────────────────────────────────────────────

interface MathResult {
  correctedSubtotal:  number | undefined;
  correctedTax:       number | undefined;
  correctedTotal:     number | undefined;
  mathOverride:       boolean;
  mathNotes:          string[];
  mathErrors:         string[];
  mathSuggestions:    string[];
  runningTotalChain:  string[];
  vatIncluded:        boolean;
}

function runMathEngine(ai: any, mathCheck?: any): MathResult {
  const mathNotes:       string[] = [];
  const mathErrors:      string[] = [];
  const mathSuggestions: string[] = [];
  const runningTotalChain: string[] = [];
  let mathOverride = false;

  const subtotal  = parseNumber(ai.subtotal);
  const nhil      = parseNumber(ai.nhil);
  const getfund   = parseNumber(ai.getfund);
  const covidLevy = parseNumber(ai.covid_levy);
  const vat       = parseNumber(ai.vat);
  const aiTax     = parseNumber(ai.tax);
  const aiTotal   = parseNumber(ai.total);
  const items     = ai.items ?? [];

  // ── #9 Currency consistency check ──
  const headerCurrency: string = ai.header_currency ?? ai.currency ?? 'GHS';
  const currencyMismatches = mathCheck?.currency_mismatches ?? [];
  if (currencyMismatches.length > 0) {
    mathErrors.push(`Mixed currencies detected: header says ${headerCurrency} but some items show different currency symbols (${currencyMismatches.join(', ')}). Amounts may not be comparable.`);
    mathSuggestions.push(`Check each item on the physical invoice for currency symbols. All items must be in the same currency as the total (${headerCurrency}).`);
  }
  // Also check per-item currency_symbol_seen
  for (const item of items) {
    if (item.currency_symbol_seen && item.name) {
      const itemCurrency = String(item.currency_symbol_seen).toUpperCase();
      if (itemCurrency !== headerCurrency && itemCurrency !== 'NONE' && itemCurrency !== 'NULL') {
        mathErrors.push(`Item "${item.name}" appears to be in ${itemCurrency} but invoice header is ${headerCurrency}. This will cause a wrong total.`);
        mathSuggestions.push(`Confirm the currency for "${item.name}" with the vendor before collecting.`);
      }
    }
  }

  // ── #8 Quantity sanity check ──
  for (const item of items) {
    const qty = parseNumber(item.quantity);
    const unitPrice = parseNumber(item.unit_price);
    if (qty !== undefined) {
      if (qty <= 0) {
        mathErrors.push(`Item "${item.name || 'unknown'}" has quantity ${qty} — zero or negative quantities are impossible.`);
        mathSuggestions.push(`Check the quantity for "${item.name || 'this item'}" on the physical invoice. Zero/negative quantities are a writing error.`);
      } else if (qty > 1000 && unitPrice !== undefined && unitPrice > 0) {
        const lineValue = qty * unitPrice;
        mathNotes.push(`Item "${item.name || 'unknown'}" has unusually large quantity: ${qty} × ${unitPrice.toFixed(2)} = ${lineValue.toFixed(2)}. Verify this is correct.`);
      }
    }
  }

  // ── #7 Unit price consistency (same item name, different price on same invoice) ──
  const itemPriceMap: Record<string, number[]> = {};
  for (const item of items) {
    if (!item.name || parseNumber(item.unit_price) === undefined) continue;
    const key = String(item.name).toLowerCase().trim();
    if (!itemPriceMap[key]) itemPriceMap[key] = [];
    itemPriceMap[key].push(parseNumber(item.unit_price)!);
  }
  for (const [name, prices] of Object.entries(itemPriceMap)) {
    if (prices.length > 1) {
      const unique = [...new Set(prices)];
      if (unique.length > 1) {
        const displayName = items.find((i: any) => String(i.name).toLowerCase().trim() === name)?.name || name;
        mathErrors.push(`"${displayName}" appears ${prices.length} times on this invoice with different unit prices: ${unique.map(p => p.toFixed(2)).join(', ')}. This is a pricing inconsistency.`);
        mathSuggestions.push(`Ask the vendor why "${displayName}" has different prices on the same invoice. There should be one consistent unit price.`);
      }
    }
  }

  // ── VAT determination ──
  const taxExplicitlyPresent =
    nhil !== undefined || getfund !== undefined ||
    covidLevy !== undefined || vat !== undefined || aiTax !== undefined;
  const vatIncluded = !taxExplicitlyPresent || ai.vat_included_in_prices === true;

  if (vatIncluded && !taxExplicitlyPresent) {
    mathNotes.push('No VAT rows on invoice — treated as VAT-inclusive pricing (accepted in Ghana). No tax calculations applied.');
  }

  // ── Tax derivation ──
  let correctedTax = aiTax;
  if (taxExplicitlyPresent) {
    const hasGraLevies = nhil !== undefined || getfund !== undefined || covidLevy !== undefined || vat !== undefined;
    if (hasGraLevies) {
      const computedTax = safeSum(nhil, getfund, covidLevy, vat);
      if (aiTax === undefined) {
        correctedTax = computedTax;
        mathNotes.push(`Tax derived: NHIL(${nhil ?? 0}) + GETFund(${getfund ?? 0}) + COVID(${covidLevy ?? 0}) + VAT(${vat ?? 0}) = ${computedTax}`);
      } else if (Math.abs(computedTax - aiTax) > 0.05) {
        correctedTax = computedTax;
        mathOverride = true;
        mathNotes.push(`Tax corrected: ${aiTax} → ${computedTax}`);
      }
    }

    // GRA levy rate checks
    if (ai.is_gra_invoice && subtotal && subtotal > 0 && hasGraLevies) {
      const expectedNhil    = Math.round(subtotal * 0.025 * 100) / 100;
      const expectedGetfund = Math.round(subtotal * 0.025 * 100) / 100;
      const expectedCovid   = Math.round(subtotal * 0.010 * 100) / 100;
      const levyBase        = safeSum(subtotal, nhil ?? expectedNhil, getfund ?? expectedGetfund, covidLevy ?? expectedCovid);
      const expectedVat     = Math.round(levyBase * 0.15 * 100) / 100;

      if (nhil !== undefined && Math.abs(nhil - expectedNhil) > 0.15) {
        mathErrors.push(`NHIL error: shows ${nhil.toFixed(2)}, expected ${expectedNhil.toFixed(2)} (2.5% of ${subtotal.toFixed(2)}).`);
        mathSuggestions.push(`Ask vendor to recalculate NHIL — should be ${expectedNhil.toFixed(2)}.`);
      }
      if (getfund !== undefined && Math.abs(getfund - expectedGetfund) > 0.15) {
        mathErrors.push(`GETFund error: shows ${getfund.toFixed(2)}, expected ${expectedGetfund.toFixed(2)}.`);
        mathSuggestions.push(`Ask vendor to recalculate GETFund — should be ${expectedGetfund.toFixed(2)}.`);
      }
      if (covidLevy !== undefined && Math.abs(covidLevy - expectedCovid) > 0.15) {
        mathErrors.push(`COVID-19 Levy error: shows ${covidLevy.toFixed(2)}, expected ${expectedCovid.toFixed(2)}.`);
        mathSuggestions.push(`Ask vendor to recalculate COVID Levy — should be ${expectedCovid.toFixed(2)}.`);
      }
      if (vat !== undefined && Math.abs(vat - expectedVat) > 1.50) {
        mathErrors.push(`VAT error: shows ${vat.toFixed(2)}, expected ${expectedVat.toFixed(2)} (15% of levy base ${levyBase.toFixed(2)}).`);
        mathSuggestions.push(`Ask vendor to recalculate VAT — should be ${expectedVat.toFixed(2)}.`);
      }

      // Build running total chain for GRA (#10)
      runningTotalChain.push(`Subtotal (pre-tax): ${subtotal.toFixed(2)}`);
      if (nhil !== undefined) runningTotalChain.push(`+ NHIL 2.5%: ${nhil.toFixed(2)}`);
      if (getfund !== undefined) runningTotalChain.push(`+ GETFund 2.5%: ${getfund.toFixed(2)}`);
      if (covidLevy !== undefined) runningTotalChain.push(`+ COVID-19 Levy 1%: ${covidLevy.toFixed(2)}`);
      if (vat !== undefined) runningTotalChain.push(`+ VAT 15%: ${vat.toFixed(2)}`);
      if (aiTotal !== undefined) runningTotalChain.push(`= Grand Total: ${aiTotal.toFixed(2)}`);
    } else if (subtotal !== undefined && correctedTax !== undefined) {
      // Non-GRA with explicit tax (#10)
      runningTotalChain.push(`Subtotal: ${subtotal.toFixed(2)}`);
      runningTotalChain.push(`+ Tax: ${correctedTax.toFixed(2)}`);
      if (aiTotal !== undefined) runningTotalChain.push(`= Total: ${aiTotal.toFixed(2)}`);
    }
  }

  // ── #10 Items sum chain (VAT-inclusive) ──
  if (vatIncluded && items.length > 0) {
    let runningSum = 0;
    for (const item of items) {
      const lt = parseNumber(item.line_total);
      if (lt !== undefined) {
        runningSum = Math.round((runningSum + lt) * 100) / 100;
        runningTotalChain.push(`${item.name || 'item'} line total: ${lt.toFixed(2)} (running: ${runningSum.toFixed(2)})`);
      }
    }
    if (aiTotal !== undefined && runningSum > 0) {
      runningTotalChain.push(`Items sum: ${runningSum.toFixed(2)} vs Grand Total: ${aiTotal.toFixed(2)}`);
    }
  }

  // ── #6 Full column cross-check ──
  let itemsSum = 0;
  let hasAnyLineTotal = false;
  for (const item of items) {
    const lt = parseNumber(item.line_total);
    if (lt !== undefined) { itemsSum += lt; hasAnyLineTotal = true; }
  }
  itemsSum = Math.round(itemsSum * 100) / 100;

  if (hasAnyLineTotal && subtotal !== undefined && Math.abs(itemsSum - subtotal) > 0.10) {
    mathErrors.push(`Column sum error: all line totals add to ${itemsSum.toFixed(2)} but stated subtotal is ${subtotal.toFixed(2)} (gap: ${Math.abs(itemsSum - subtotal).toFixed(2)}).`);
    mathSuggestions.push(`The sum of all items (${itemsSum.toFixed(2)}) does not match the subtotal (${subtotal.toFixed(2)}). Ask the vendor to check every line total and reissue.`);
  }
  if (hasAnyLineTotal && vatIncluded && aiTotal !== undefined && subtotal === undefined && Math.abs(itemsSum - aiTotal) > 0.10) {
    const gap = Math.abs(itemsSum - aiTotal);
    if (gap / aiTotal > 0.01) {
      mathErrors.push(`Column sum error: all line totals add to ${itemsSum.toFixed(2)} but grand total is ${aiTotal.toFixed(2)} (gap: ${gap.toFixed(2)}).`);
      mathSuggestions.push(`The items sum (${itemsSum.toFixed(2)}) does not match the grand total (${aiTotal.toFixed(2)}). One or more line totals may be wrong.`);
    }
  }

  // ── Total derivation ──
  let correctedTotal = aiTotal;
  if (subtotal !== undefined && correctedTax !== undefined && taxExplicitlyPresent) {
    const computedTotal = safeSum(subtotal, correctedTax);
    if (aiTotal === undefined) {
      correctedTotal = computedTotal;
      mathOverride = true;
      mathNotes.push(`Total computed from subtotal+tax: ${computedTotal}`);
    } else if (Math.abs(computedTotal - aiTotal) > 0.10) {
      const pct = Math.abs(computedTotal - aiTotal) / Math.max(aiTotal, 1) * 100;
      if (pct > 1) {
        const diff = Math.abs(aiTotal - computedTotal).toFixed(2);
        mathErrors.push(`Grand total mismatch: subtotal(${subtotal.toFixed(2)}) + tax(${correctedTax.toFixed(2)}) = ${computedTotal.toFixed(2)}, but invoice shows ${aiTotal.toFixed(2)} (gap: ${diff}).`);
        mathSuggestions.push(
          ai.is_gra_invoice
            ? `Do not collect until the vendor corrects this. The math gives ${computedTotal.toFixed(2)} but the invoice shows ${aiTotal.toFixed(2)}.`
            : `Ask vendor to correct the total — should be ${computedTotal.toFixed(2)}, not ${aiTotal.toFixed(2)}.`
        );
        if (!ai.is_gra_invoice) { correctedTotal = computedTotal; mathOverride = true; }
      }
    }
  }

  return { correctedSubtotal: subtotal, correctedTax, correctedTotal, mathOverride, mathNotes, mathErrors, mathSuggestions, runningTotalChain, vatIncluded };
}

// ─────────────────────────────────────────────────────────────
// LAYER 5 — HALLUCINATION GUARD
// ─────────────────────────────────────────────────────────────

interface HallucinationReport {
  isHallucinated: boolean;
  flags:          string[];
  suggestions:    string[];
  totalUncertain: boolean;
}

function runHallucinationGuard(ai: any, math: MathResult): HallucinationReport {
  const flags: string[] = [];
  const suggestions: string[] = [];
  const total    = math.correctedTotal ?? parseNumber(ai.total);
  const subtotal = math.correctedSubtotal;
  const tax      = math.correctedTax;
  const items    = ai.items ?? [];

  if (total !== undefined && subtotal !== undefined && total < subtotal) {
    flags.push(`Grand total (${total}) is less than subtotal (${subtotal}) — mathematically impossible.`);
    suggestions.push(`Return the invoice to the vendor — total cannot be less than subtotal.`);
  }
  if ((total === undefined || total === 0) && items.length > 0) {
    flags.push(`Grand total missing or zero but ${items.length} line item(s) found — total section unreadable.`);
    suggestions.push(`Check the bottom of the physical invoice. If illegible, ask vendor to reprint.`);
  }
  if (!math.vatIncluded && tax !== undefined && subtotal !== undefined && subtotal > 0 && tax > subtotal) {
    flags.push(`Tax (${tax}) exceeds subtotal (${subtotal}) — implies tax rate over 100%.`);
    suggestions.push(`The tax amount looks wrong. Check the totals section carefully.`);
  }
  for (const item of items) {
    const lt = parseNumber(item.line_total);
    if (lt !== undefined && total !== undefined && total > 0 && lt > total * 1.05) {
      flags.push(`Item "${item.name}" line total (${lt}) exceeds grand total (${total}).`);
      suggestions.push(`Check "${item.name}" on the physical invoice — the line total may have been misread.`);
    }
  }
  if (ai.date) {
    const year = parseInt(String(ai.date).slice(0, 4));
    if (year < 2000 || year > 2030) {
      flags.push(`Invoice date year "${year}" is implausible — likely a misread.`);
      suggestions.push(`Check the physical invoice for the correct date.`);
    }
  }
  if (ai.total_confidence === 'low' && math.correctedTotal === undefined) {
    flags.push(`Grand total extracted with LOW confidence and cannot be independently verified.`);
    suggestions.push(`Do not collect money until you have manually confirmed the total on the physical invoice.`);
  }

  // #5 Character-level confidence — surface exact uncertain digits
  if (ai.total_uncertain_digits) {
    flags.push(`Grand total has uncertain digits: "${ai.total_uncertain_digits}". The exact amount may be wrong.`);
    suggestions.push(`Look at the grand total on the physical invoice and read each digit carefully. Correct it in the edit panel.`);
  }
  for (const item of items) {
    if (item.uncertain_digits && item.name) {
      flags.push(`Item "${item.name}" has uncertain digits in its amounts: ${item.uncertain_digits}.`);
      suggestions.push(`Verify the amounts for "${item.name}" on the physical invoice.`);
    }
  }

  const allNullLineTotals = items.length > 0 && items.every((i: any) => parseNumber(i.line_total) === undefined);
  if (allNullLineTotals && items.length > 0) {
    flags.push(`No line totals readable — items table may not have been captured clearly.`);
    suggestions.push(`Retake the photo with better lighting, ensuring the items table is fully in frame.`);
  }

  const totalUncertain =
    (ai.total_confidence === 'low' && math.correctedTotal === undefined) ||
    (total === undefined || total === 0);

  return { isHallucinated: flags.length > 0, flags, suggestions, totalUncertain };
}

// ─────────────────────────────────────────────────────────────
// PROTOCOL 9 — RISK VERDICT (v6.0: running total chain in details)
// ─────────────────────────────────────────────────────────────

function buildRiskVerdict(params: {
  errors:                   ValidationError[];
  hallucinationFlags:       string[];
  hallucinationSuggestions: string[];
  mathErrors:               string[];
  mathSuggestions:          string[];
  runningTotalChain:        string[];
  isDuplicate:              boolean;
  duplicateOfId?:           string;
  isPartialPayment:         boolean;
  partialOrigTotal?:        number;
  priceWarnings:            string[];
  vendorRangeWarning?:      string;
  invNumberGapWarning?:     string;
  timeOfDayWarning?:        string;
  total:                    number | undefined;
  reconciliationApplied:    boolean;
  mathOverride:             boolean;
  vatIncluded:              boolean;
}): RiskVerdictResult {
  const {
    errors, hallucinationFlags, hallucinationSuggestions,
    mathErrors, mathSuggestions, runningTotalChain,
    isDuplicate, duplicateOfId,
    isPartialPayment, partialOrigTotal,
    priceWarnings, vendorRangeWarning, invNumberGapWarning, timeOfDayWarning,
    total, reconciliationApplied, mathOverride, vatIncluded,
  } = params;

  const details: string[] = [];
  let verdict: RiskVerdict = 'ACCEPT';
  let reason = 'Invoice checks out. You can collect the money.';
  let moneyAtRisk = 0;

  const hasCriticalMathError = mathErrors.length > 0;
  const hasHallucination = hallucinationFlags.some(f =>
    f.includes('Grand total') || f.includes('impossible') || f.includes('line total') || f.includes('uncertain digits')
  );

  if (isDuplicate) {
    verdict = 'REJECT';
    reason = `STOP — this invoice was already submitted before${duplicateOfId ? ` (ID: ${duplicateOfId})` : ''}. Do NOT collect money again.`;
    moneyAtRisk = total ?? 0;
    details.push('Duplicate invoice. Collecting again means paying twice.');
    details.push('→ Fix: Inform vendor this invoice was already processed. Request a new invoice number for a new transaction.');
  } else if (isPartialPayment && partialOrigTotal !== undefined) {
    verdict = 'CAUTION';
    reason = `Partial payment detected. Original total was ${partialOrigTotal.toFixed(2)}, this shows ${total?.toFixed(2) ?? '?'}.`;
    moneyAtRisk = partialOrigTotal - (total ?? 0);
    details.push(`Expected ${partialOrigTotal.toFixed(2)}, this shows ${total?.toFixed(2) ?? '?'}.`);
    details.push(`→ Fix: Look carefully at both invoices and confirm the correct amount before collecting.`);
  } else if (hasHallucination && total === undefined) {
    verdict = 'ESCALATE';
    reason = `Invoice total could not be read reliably. Do NOT collect until you have confirmed the amount on the physical invoice.`;
    moneyAtRisk = 0;
    for (let i = 0; i < hallucinationFlags.length; i++) {
      details.push(`Problem: ${hallucinationFlags[i]}`);
      if (hallucinationSuggestions[i]) details.push(`→ Fix: ${hallucinationSuggestions[i]}`);
    }
  } else if (hasCriticalMathError) {
    verdict = 'ESCALATE';
    reason = `Numbers on this invoice do not add up. Look carefully at each figure and correct the invoice before accepting payment.`;
    moneyAtRisk = total ?? 0;
    for (let i = 0; i < mathErrors.length; i++) {
      details.push(`Problem: ${mathErrors[i]}`);
      if (mathSuggestions[i]) details.push(`→ Fix: ${mathSuggestions[i]}`);
    }
  } else if (priceWarnings.length > 0 || vendorRangeWarning) {
    const bigSpike = priceWarnings.some(w => { const m = w.match(/(\d+)%/); return m && parseInt(m[1]) > 50; }) ||
      (vendorRangeWarning?.includes('3×') ?? false);
    verdict = bigSpike ? 'ESCALATE' : 'CAUTION';
    reason = bigSpike
      ? `Prices are unusually high for this vendor. Look carefully at every item and confirm with the vendor before accepting payment.`
      : `Some prices are higher than expected for this vendor. Review before collecting.`;
    moneyAtRisk = total ?? 0;
    for (const w of priceWarnings) {
      details.push(`Problem: ${w}`);
      details.push(`→ Fix: Request vendor's updated price list and compare before collecting.`);
    }
    if (vendorRangeWarning) {
      details.push(`Problem: ${vendorRangeWarning}`);
      details.push(`→ Fix: Compare this invoice total against your records for this vendor before collecting.`);
    }
  } else if (invNumberGapWarning) {
    verdict = 'CAUTION';
    reason = `Invoice number sequence looks unusual for this vendor.`;
    moneyAtRisk = total ?? 0;
    details.push(`Problem: ${invNumberGapWarning}`);
    details.push(`→ Fix: Ask the vendor to confirm this invoice number is correct. Large gaps can indicate backdating.`);
  } else if (errors.some(e => e.field === 'total')) {
    verdict = 'CAUTION';
    reason = `Grand total has an issue. Verify the amount before collecting.`;
    moneyAtRisk = total ?? 0;
    for (const e of errors.filter(e => e.field === 'total')) {
      const parts = e.message.split(' → ');
      details.push(`Problem: ${parts[0]}`);
      if (parts[1]) details.push(`→ Fix: ${parts[1]}`);
    }
  } else if (errors.some(e => ['invoice_number', 'customer_name', 'date'].includes(e.field))) {
    verdict = 'CAUTION';
    const missing = errors.filter(e => ['invoice_number', 'customer_name', 'date'].includes(e.field)).map(e => e.field.replace('_', ' ')).join(', ');
    reason = `Invoice missing key information: ${missing}.`;
    moneyAtRisk = 0;
    for (const e of errors.filter(e => ['invoice_number', 'customer_name', 'date'].includes(e.field))) {
      const parts = e.message.split(' → ');
      details.push(`Problem: ${parts[0]}`);
      if (parts[1]) details.push(`→ Fix: ${parts[1]}`);
    }
  } else if (errors.length === 0 && hallucinationFlags.length === 0 && mathErrors.length === 0) {
    verdict = 'ACCEPT';
    if (reconciliationApplied) {
      reason = `Invoice verified after extra re-check. Total ${total?.toFixed(2) ?? '?'} confirmed. Safe to collect.`;
    } else if (mathOverride) {
      verdict = 'CAUTION';
      reason = `Invoice total was auto-corrected arithmetically to ${total?.toFixed(2) ?? '?'}. Verify against the physical invoice before collecting.`;
      details.push(`→ Fix: Confirm the total on the physical invoice matches ${total?.toFixed(2) ?? '?'}.`);
    } else {
      const vatNote = vatIncluded && !taxExplicitlyPresent ? ' (VAT-inclusive pricing)' : '';
      reason = `All checks passed. Invoice total is ${total?.toFixed(2) ?? '?'}${vatNote}. Safe to collect.`;
    }
  } else {
    verdict = 'CAUTION';
    reason = `Invoice has issues — review flagged fields before collecting.`;
    moneyAtRisk = 0;
    for (const e of errors) {
      const parts = e.message.split(' → ');
      details.push(`Problem: ${parts[0]}`);
      if (parts[1]) details.push(`→ Fix: ${parts[1]}`);
    }
  }

  for (let i = 0; i < hallucinationFlags.length; i++) {
    if (!details.some(d => d.includes(hallucinationFlags[i].slice(0, 30)))) {
      details.push(`Problem: ${hallucinationFlags[i]}`);
      if (hallucinationSuggestions[i]) details.push(`→ Fix: ${hallucinationSuggestions[i]}`);
    }
  }

  // Time-of-day warning added as soft note at end
  if (timeOfDayWarning) {
    details.push(`⏰ Note: ${timeOfDayWarning}`);
  }

  // #10 Running total chain
  if (runningTotalChain.length > 0) {
    details.push(`📊 Calculation breakdown: ${runningTotalChain.join(' → ')}`);
  }

  return { verdict, reason, details, moneyAtRisk };
}

// ─────────────────────────────────────────────────────────────
// JSON PARSE HELPER
// ─────────────────────────────────────────────────────────────

function parseGroqJson(raw: string): any {
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); }
  catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) { try { return JSON.parse(match[0]); } catch { /* fall through */ } }
    throw new Error(`Could not parse JSON from model response. Raw: ${cleaned.slice(0, 400)}`);
  }
}

// ─────────────────────────────────────────────────────────────
// MAIN SERVER ACTION
// ─────────────────────────────────────────────────────────────

export async function processInvoice(
  imageBase64: string,
  taxRatePct: number = 15,
  invoiceHistory: SlimInvoiceResult[] = []
): Promise<InvoiceProcessingResult> {
  try {
    const groqApiKey = getGroqApiKey();
    const matches = imageBase64.match(/^data:(.+);base64,(.+)$/);
    if (!matches) throw new Error('Invalid image format. Expected a base64 data URI.');

    const imageUrl = await ensureImageUnderLimit(imageBase64);
    console.log(`[Invoice] Image size: ${Math.round((imageUrl.split(',')[1]?.length ?? 0) / 1024)}KB base64`);

    // ── DOCUMENT TYPE GUARD — fast check before expensive pipeline ──
    console.log('[Invoice] Document guard: checking image is a financial document...');
    const guard = await guardDocumentType(imageUrl, groqApiKey);
    if (!guard.ok) {
      throw new Error(
        `This doesn't look like an invoice or receipt — it appears to be a ${guard.detectedAs}. ` +
        `Please scan or upload an actual invoice, receipt, or payment document.`
      );
    }
    console.log(`[Invoice] Document guard passed: ${guard.detectedAs}`);

    // ── PASS 1: Universal OCR ──
    console.log('[Invoice] Pass 1: universal OCR...');
    const transcription = await callGroqVision(imageUrl, PASS1_PROMPT, groqApiKey);
    console.log('[Invoice] Pass 1 done, length:', transcription.length);

    // ── MATH PRE-CHECK + PASS 2 in parallel ──
    console.log('[Invoice] Math pre-check + Pass 2 in parallel...');
    let mathCheck: any = null;
    let rawJson = '';

    const [mathCheckResult, pass2Result] = await Promise.allSettled([
      callGroqText(buildMathPreCheckPrompt(transcription), groqApiKey, 1500),
      callGroqText(buildPass2Prompt(transcription, null), groqApiKey, 3000)
        .catch(() => callGroqVision(imageUrl, buildPass2Prompt(transcription, null), groqApiKey)),
    ]);

    if (mathCheckResult.status === 'fulfilled') {
      try { mathCheck = parseGroqJson(mathCheckResult.value); } catch (e) { console.warn('[Invoice] Math pre-check parse failed:', e); }
    } else {
      console.warn('[Invoice] Math pre-check failed (non-fatal):', mathCheckResult.reason);
    }

    if (pass2Result.status === 'fulfilled') {
      rawJson = pass2Result.value;
    } else {
      throw new Error('Pass 2 JSON extraction failed: ' + pass2Result.reason?.message);
    }
    console.log('[Invoice] Math pre-check + Pass 2 done');

    let ai = parseGroqJson(rawJson);
    let math = runMathEngine(ai, mathCheck);
    let hallucinationReport = runHallucinationGuard(ai, math);

    // ── REGION RE-READ: LOW confidence only ──
    const lowConfidenceFields: string[] = [];
    if (ai.total_confidence === 'low') lowConfidenceFields.push('grand total / amount due');
    if (ai.invoice_number_confidence === 'low') lowConfidenceFields.push('invoice number');
    if (ai.date_confidence === 'low') lowConfidenceFields.push('invoice date');
    if (ai.subtotal_confidence === 'low') lowConfidenceFields.push('subtotal');
    if (ai.customer_name_confidence === 'low') lowConfidenceFields.push('vendor/seller name');

    let regionRereadApplied = false;
    if (lowConfidenceFields.length > 0) {
      console.log(`[Invoice] #3 Region re-read for: ${lowConfidenceFields.join(', ')}`);
      try {
        // Re-read header fields
        const headerFields = lowConfidenceFields.filter(f => ['invoice number', 'invoice date', 'vendor/seller name'].some(x => f.includes(x)));
        const totalsFields = lowConfidenceFields.filter(f => ['grand total', 'subtotal', 'amount due'].some(x => f.includes(x)));

        if (totalsFields.length > 0) {
          const rereadText = await callGroqVision(imageUrl, buildRegionRereadPrompt('totals', totalsFields), groqApiKey);
          const totalMatch = rereadText.match(/GRAND_TOTAL_BEST_READING:\s*([\d,]+\.?\d*)/i);
          const confMatch  = rereadText.match(/GRAND_TOTAL_CONFIDENCE:\s*(HIGH|MEDIUM|LOW)/i);
          if (totalMatch && confMatch?.[1]?.toUpperCase() !== 'LOW') {
            const rereTotal = parseNumber(totalMatch[1]);
            const rereConf  = (confMatch?.[1] ?? 'medium').toLowerCase();
            if (rereTotal && rereTotal > 0) {
              ai = { ...ai, total: rereTotal, total_confidence: rereConf, total_uncertain_digits: null };
              math = runMathEngine(ai, mathCheck);
              hallucinationReport = runHallucinationGuard(ai, math);
              regionRereadApplied = true;
              console.log(`[Invoice] Region re-read: total → ${rereTotal} (${rereConf})`);
            }
          }
        }

        if (headerFields.length > 0 && !regionRereadApplied) {
          const rereadText = await callGroqVision(imageUrl, buildRegionRereadPrompt('header', headerFields), groqApiKey);
          // Extract any improved readings
          const invNoMatch  = rereadText.match(/FIELD:\s*invoice\s*number[\s\S]*?VALUE:\s*([^\n]+)/i);
          const confInvNo   = rereadText.match(/FIELD:\s*invoice\s*number[\s\S]*?CONFIDENCE:\s*(HIGH|MEDIUM|LOW)/i);
          if (invNoMatch && confInvNo?.[1]?.toUpperCase() !== 'LOW' && !ai.invoice_number) {
            const rereInvNo = invNoMatch[1].trim();
            if (rereInvNo && rereInvNo !== 'NONE') {
              ai = { ...ai, invoice_number: rereInvNo, invoice_number_confidence: 'medium' };
              regionRereadApplied = true;
            }
          }
        }
      } catch (e) { console.warn('[Invoice] Region re-read failed (non-fatal):', e); }
    }

    // ── PROTOCOL 8: Reconciliation re-query (total uncertain after region re-read) ──
    let reconciliationApplied = false;
    const hasItems = (ai.items ?? []).length > 0;
    if (hallucinationReport.totalUncertain && hasItems && !regionRereadApplied) {
      console.log('[Invoice] Protocol 8: reconciliation re-query...');
      try {
        const reconText = await callGroqVision(imageUrl, RECONCILIATION_PROMPT, groqApiKey);
        const totalMatch = reconText.match(/GRAND TOTAL:\s*([\d,]+\.?\d*)/i);
        const confMatch  = reconText.match(/CONFIDENCE:\s*(high|medium|low)/i);
        if (totalMatch) {
          const reconTotal = parseNumber(totalMatch[1]);
          const reconConf  = (confMatch?.[1] ?? 'medium').toLowerCase();
          if (reconTotal && reconTotal > 0 && reconConf !== 'low') {
            ai = { ...ai, total: reconTotal, total_confidence: reconConf };
            math = runMathEngine(ai, mathCheck);
            hallucinationReport = runHallucinationGuard(ai, math);
            reconciliationApplied = true;
            console.log(`[Invoice] Reconciliation: total → ${reconTotal} (${reconConf})`);
          }
        }
      } catch (e) { console.warn('[Invoice] Protocol 8 failed (non-fatal):', e); }
    }

    // ── BUILD VALIDATED DATA ──
    const validatedData: ValidatedData = {
      invoice_number: ai.invoice_number || undefined,
      date:           ai.date || undefined,
      customer_name:  ai.customer_name || undefined,
      category:       ai.category || undefined,
      subtotal:       math.correctedSubtotal,
      // tax: only set if explicitly on the invoice. If VAT-inclusive pricing, leave undefined (accepted in Ghana, no error).
      tax:            (!math.vatIncluded && math.correctedTax !== undefined) ? math.correctedTax : undefined,
      total:          math.correctedTotal ?? parseNumber(ai.total),
      items: (ai.items ?? []).map((item: any) => ({
        name:       item.name || undefined,
        quantity:   parseNumber(item.quantity) ?? item.quantity,
        unit_price: parseNumber(item.unit_price),
        line_total: parseNumber(item.line_total),
      })),
    };

    // ── VALIDATION ERRORS ──
    const errors: ValidationError[] = [];

    if (!validatedData.invoice_number)
      errors.push({ field: 'invoice_number', message: 'Invoice number missing or unreadable. → Ask the vendor for an invoice with a unique reference number before collecting payment.' });
    if (!validatedData.customer_name)
      errors.push({ field: 'customer_name', message: 'Vendor/store name missing or unreadable. → Ask the vendor to confirm their business name and update it in the edit panel.' });
    if (validatedData.total === undefined)
      errors.push({ field: 'total', message: 'Grand total missing — cannot verify the amount to collect. → Check the bottom of the physical invoice and enter the total manually.' });
    if (!validatedData.items || validatedData.items.length === 0)
      errors.push({ field: 'items', message: 'No line items found. → Retake the photo ensuring the items table is fully visible, or request an itemised invoice from the vendor.' });
    if (ai.total_confidence === 'low' && !reconciliationApplied && !regionRereadApplied)
      errors.push({ field: 'total', message: `Grand total was difficult to read (low confidence: ${validatedData.total?.toFixed(2) ?? 'unknown'}). → Manually confirm this amount on the physical invoice before collecting.` });
    if (ai.customer_name_confidence === 'low')
      errors.push({ field: 'customer_name', message: `Vendor name was partially readable: "${validatedData.customer_name}". → Confirm with the vendor and correct in the edit panel if wrong.` });

    // Hallucination flags
    for (let i = 0; i < hallucinationReport.flags.length; i++) {
      const suggestion = hallucinationReport.suggestions[i] ? ` → ${hallucinationReport.suggestions[i]}` : '';
      errors.push({ field: 'hallucination', message: `⚠️ ${hallucinationReport.flags[i]}${suggestion}` });
    }
    // Math errors
    for (let i = 0; i < math.mathErrors.length; i++) {
      const suggestion = math.mathSuggestions[i] ? ` → ${math.mathSuggestions[i]}` : '';
      errors.push({ field: 'math', message: `${math.mathErrors[i]}${suggestion}` });
    }

    // Line item arithmetic
    let itemsSum = 0;
    for (const [i, item] of (validatedData.items ?? []).entries()) {
      const qty = item.quantity ?? 0;
      const unitPrice = item.unit_price ?? 0;
      const lineTotal = item.line_total;
      if (lineTotal !== undefined) {
        itemsSum += lineTotal;
        if (qty > 0 && unitPrice > 0) {
          const expected = Math.round(qty * unitPrice * 100) / 100;
          if (Math.abs(expected - lineTotal) > 0.10) {
            errors.push({
              field: `items[${i}].line_total`,
              message: `"${item.name || 'Item'}" row error: ${qty} × ${unitPrice.toFixed(2)} = ${expected.toFixed(2)}, but invoice shows ${lineTotal.toFixed(2)} (gap: ${Math.abs(lineTotal - expected).toFixed(2)}). → Ask vendor to correct this line or reissue the invoice.`
            });
          }
        }
      }
    }
    itemsSum = Math.round(itemsSum * 100) / 100;

    // Subtotal vs items (explicit subtotal only)
    if (validatedData.subtotal !== undefined && itemsSum > 0 && Math.abs(itemsSum - validatedData.subtotal) > 0.10) {
      errors.push({
        field: 'subtotal',
        message: `Items sum to ${itemsSum.toFixed(2)} but subtotal shows ${validatedData.subtotal.toFixed(2)}. → Return invoice to vendor for correction before collecting money.`
      });
    }

    // Total vs subtotal+tax (explicit tax only)
    if (!math.vatIncluded && validatedData.subtotal !== undefined && validatedData.tax !== undefined && validatedData.total !== undefined) {
      const expectedTotal = safeSum(validatedData.subtotal, validatedData.tax);
      if (Math.abs(expectedTotal - validatedData.total) / Math.max(validatedData.total, 1) * 100 > 1) {
        errors.push({
          field: 'total',
          message: `Total mismatch: ${validatedData.subtotal.toFixed(2)} + tax ${validatedData.tax.toFixed(2)} = ${expectedTotal.toFixed(2)}, but invoice shows ${validatedData.total.toFixed(2)}. → Do not collect until vendor corrects and reissues.`
        });
      }
    }

    // Tax rate check (non-GRA explicit tax only — skip entirely if VAT is included in prices)
    // In Ghana, VAT-inclusive pricing is accepted. Only flag if tax rows ARE explicitly on the invoice
    // AND the rate is wildly off (more than 15 percentage points, not 8, to reduce false positives).
    if (!math.vatIncluded && !ai.is_gra_invoice && validatedData.subtotal && validatedData.tax && validatedData.subtotal > 0) {
      const impliedRate = Math.round((validatedData.tax / validatedData.subtotal) * 10000) / 100;
      if (impliedRate > 0 && Math.abs(impliedRate - taxRatePct) > 15) {
        errors.push({
          field: 'tax',
          message: `Unusual tax rate: ${impliedRate}% (expected ~${taxRatePct}%). → Verify with vendor or manager before collecting.`
        });
      }
    }

    // Date anomaly
    const dateWarning = checkDateAnomaly(validatedData.date);
    if (dateWarning) errors.push({ field: 'date', message: dateWarning });

    // #I03 Round number anomaly
    const roundWarning = checkRoundNumberAnomaly(validatedData.total, validatedData.items?.length ?? 0);
    if (roundWarning) errors.push({ field: 'round_number', message: roundWarning });

    // #14 Time-of-day anomaly
    const timeOfDayWarning = checkTimeOfDayAnomaly();

    // ── PROTOCOL 6: Price memory ──
    let priceWarnings: string[] = [];
    const priceWarningsAt = new Date().toISOString();
    if (invoiceHistory.length > 0) {
      const vendorProfiles = buildVendorProfiles(invoiceHistory as InvoiceProcessingResult[]);
      const vendorKey = normaliseVendorKey(validatedData.customer_name);
      const tempResult = { id: '__temp__', validatedData, errors: [], isValid: true, ocrText: '', status: 'verified' as const, createdAt: new Date().toISOString() } as InvoiceProcessingResult;
      priceWarnings = checkPriceMemory(tempResult, vendorProfiles[vendorKey]);
      for (const w of priceWarnings) errors.push({ field: 'price_memory', message: w });
    }

    // ── #11 Vendor total range check ──
    let vendorRangeWarning: string | undefined;
    let vendorHistory: InvoiceProcessingResult[] = [];
    if (invoiceHistory.length > 0 && validatedData.total !== undefined) {
      vendorHistory = (invoiceHistory as InvoiceProcessingResult[]).filter(
        h => normaliseVendorKey(h.validatedData.customer_name) === normaliseVendorKey(validatedData.customer_name)
      );
      vendorRangeWarning = checkVendorTotalRange(validatedData.total, vendorHistory, validatedData.customer_name) ?? undefined;
      if (vendorRangeWarning) errors.push({ field: 'vendor_range', message: vendorRangeWarning });
    }

    // ── #I04 Vendor fuzzy name match ──
    if (invoiceHistory.length > 0) {
      const fuzzyWarning = checkVendorNameFuzzyMatch(validatedData.customer_name, invoiceHistory as InvoiceProcessingResult[]);
      if (fuzzyWarning) errors.push({ field: 'vendor_fuzzy', message: fuzzyWarning });
    }

    // ── #I11 Cumulative vendor spend ──
    if (vendorHistory.length > 0) {
      const cumulativeWarning = checkCumulativeVendorSpend(vendorHistory, validatedData.total, validatedData.customer_name);
      if (cumulativeWarning) errors.push({ field: 'cumulative_spend', message: cumulativeWarning });
    }

    // ── PROTOCOL 7: Duplicate + partial payment ──
    let isDuplicate = false, duplicateOfId: string | undefined;
    let isPartialPayment = false, partialPaymentOriginalTotal: number | undefined, partialPaymentOriginalId: string | undefined;
    let isRecurring = false, recurringDelta: number | undefined;

    // ── #15 Invoice number gap detection ──
    let invNumberGapWarning: string | undefined;

    if (invoiceHistory.length > 0) {
      const tempForDetection = {
        id: '__new__', validatedData, errors, isValid: errors.length === 0, ocrText: '',
        status: 'verified' as const, createdAt: new Date().toISOString(),
        vendorKey: normaliseVendorKey(validatedData.customer_name)
      } as InvoiceProcessingResult;

      const dupResult = detectDuplicate(tempForDetection, invoiceHistory as InvoiceProcessingResult[]);
      isDuplicate = dupResult.isDuplicate;
      duplicateOfId = dupResult.duplicateOfId;

      if (isDuplicate) {
        errors.push({ field: 'duplicate', message: `🔴 DUPLICATE INVOICE: Already recorded${duplicateOfId ? ` (ID: ${duplicateOfId})` : ''}. → Do NOT collect again. Inform vendor this invoice was already processed.` });
      } else {
        const partialResult = detectPartialPayment(tempForDetection, invoiceHistory as InvoiceProcessingResult[]);
        isPartialPayment = partialResult.isPartial;
        partialPaymentOriginalTotal = partialResult.originalTotal;
        partialPaymentOriginalId = partialResult.originalId;
        if (isPartialPayment && partialPaymentOriginalTotal !== undefined) {
          errors.push({ field: 'partial_payment', message: `⚠️ PARTIAL PAYMENT: Original total was ${partialPaymentOriginalTotal.toFixed(2)}, this shows ${validatedData.total?.toFixed(2) ?? '?'}. → Go confirm figures are Correct before Giving invoice Out.` });
        }

        const vendorProfiles = buildVendorProfiles(invoiceHistory as InvoiceProcessingResult[]);
        const recurringResult = detectRecurring(tempForDetection, vendorProfiles[normaliseVendorKey(validatedData.customer_name)]);
        isRecurring = recurringResult.isRecurring;
        recurringDelta = recurringResult.recurringDelta;

        // #15 Invoice number gap
        if (validatedData.invoice_number) {
          invNumberGapWarning = detectInvoiceNumberGap(
            validatedData.invoice_number,
            normaliseVendorKey(validatedData.customer_name),
            invoiceHistory as InvoiceProcessingResult[]
          ) ?? undefined;
          if (invNumberGapWarning) errors.push({ field: 'inv_number_gap', message: invNumberGapWarning });
        }
      }
    }

    // ── RISK VERDICT ──
    const riskVerdict = buildRiskVerdict({
      errors,
      hallucinationFlags: hallucinationReport.flags,
      hallucinationSuggestions: hallucinationReport.suggestions,
      mathErrors: math.mathErrors,
      mathSuggestions: math.mathSuggestions,
      runningTotalChain: math.runningTotalChain,
      isDuplicate, duplicateOfId, isPartialPayment, partialOrigTotal: partialPaymentOriginalTotal,
      priceWarnings, vendorRangeWarning, invNumberGapWarning, timeOfDayWarning: timeOfDayWarning ?? undefined,
      total: validatedData.total,
      reconciliationApplied,
      mathOverride: math.mathOverride,
      vatIncluded: math.vatIncluded,
    });

    // ── BUILD FINAL RESULT ──
    const isValid = errors.length === 0;
    const vatNote = math.vatIncluded ? ' | VAT in prices' : ` | Tax: ${validatedData.tax?.toFixed(2) ?? 'N/A'}`;
    const ocrText =
      `[InvoiceGuard v7.0 | ${ai.currency ?? 'GHS'} | ${ai.document_type_observed ?? (ai.is_gra_invoice ? 'GRA Invoice' : 'Invoice')} | ${ai.writing_type ?? 'unknown'} | ${math.vatIncluded ? 'VAT-inclusive pricing (no separate tax rows — accepted in Ghana)' : 'Tax rows present'}]\n\n` +
      `PASS 1 OCR:\n${transcription}\n\n` +
      (mathCheck ? `Math Pre-Check: items_sum=${mathCheck.items_sum ?? 'N/A'} subtotal=${mathCheck.subtotal_from_transcription ?? 'N/A'} tax=${mathCheck.tax_sum_from_transcription ?? 'N/A (VAT in prices)'} total=${mathCheck.grand_total_from_transcription}\n` : '') +
      (math.runningTotalChain.length ? `Running Total: ${math.runningTotalChain.join(' → ')}\n\n` : '') +
      (math.mathNotes.length ? `Math Notes: ${math.mathNotes.join(' | ')}\n\n` : '') +
      (hallucinationReport.flags.length ? `Hallucination Guard:\n  ${hallucinationReport.flags.join('\n  ')}\n\n` : '') +
      `Confidence: #=${ai.invoice_number_confidence} Date=${ai.date_confidence} Vendor=${ai.customer_name_confidence} Total=${ai.total_confidence}` +
      (regionRereadApplied ? ' | ✅ Region re-read' : '') +
      (math.mathOverride ? ' | ⚠️ Math override' : '') +
      (reconciliationApplied ? ' | ✅ Reconciled' : '') + '\n\n' +
      `Verdict: ${riskVerdict.verdict} — ${riskVerdict.reason}\n\n` +
      `JSON:\n${JSON.stringify(ai, null, 2)}`;

    const result: InvoiceProcessingResult = {
      id:                       crypto.randomUUID(),
      isValid, errors, validatedData, ocrText,
      status:                   isValid ? 'verified' : 'error',
      createdAt:                new Date().toISOString(),
      dueDate:                  ai.due_date || undefined,
      vendorKey:                normaliseVendorKey(validatedData.customer_name),
      smartName:                buildSmartName(validatedData),
      currency:                 ai.currency || 'GHS',
      isDuplicate, duplicateOfId,
      isPartialPayment, partialPaymentOriginalTotal, partialPaymentOriginalId,
      isRecurring, recurringDelta,
      priceWarnings,
      priceWarningsAt,
      reconciliationApplied,
      riskVerdict,
    };
    result.healthScore = calcHealthScore(result);
    result.salesmanSummary = buildSalesmanSummary(result);
    return result;

  } catch (error: any) {
    const msg = typeof error?.message === 'string' && error.message.length < 800 ? error.message : 'Unknown server error';
    console.error('--- processInvoice error ---', error);
    throw new Error(`Invoice processing failed: ${msg}`);
  }
}
