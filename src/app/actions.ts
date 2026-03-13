'use server';

/**
 * actions.ts — InvoiceGuard AI Processing Engine v3.2
 *
 * v3.2 fixes:
 *  - SlimInvoiceResult accepted as history input (ocrText stripped client-side, fix #2)
 *  - Protocol 8 only fires when items were also found (fix #9: skip unreadable invoices)
 *  - priceWarningsAt timestamp stored on result (fix #11)
 *  - VendorProfile.itemFirstPrices tracked for cumulative drift (fix #3)
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
      `Groq's limit is ~4MB. Please take a photo at lower resolution or compress the image before uploading.`
    );
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
            model, max_tokens: 3500, temperature: 0.05,
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

const PASS1_PROMPT = `You are a forensic OCR specialist. Your job is to READ EXACTLY what is printed or handwritten on this invoice/receipt image — digit by digit, character by character. Never estimate, never round, never guess.

Read the document in FIVE separate zones and report each zone independently:

━━━━━━━━━━━━━━━━━━━━
ZONE A — HEADER (top section of document)
━━━━━━━━━━━━━━━━━━━━
DOCUMENT TYPE: [GRA Tax Invoice / Cash Receipt / Handwritten Receipt / Proforma / Other — pick one]
SELLER/VENDOR NAME: [exact name at the very top, or company letterhead]
SELLER TIN: [Tax Identification Number if visible, else NONE]
INVOICE NUMBER: [exact alphanumeric code, else NONE]
INVOICE DATE: [exact date as written, else NONE]
DUE DATE: [payment due date if visible, else NONE]
BUYER NAME: [customer/buyer name if different from seller, else NONE]

━━━━━━━━━━━━━━━━━━━━
ZONE B — LINE ITEMS TABLE (middle section: the rows of goods/services)
━━━━━━━━━━━━━━━━━━━━
List EVERY row in the table. Use this exact format per row:
ITEM [n]: Description="[text]" | Qty=[number] | UnitPrice=[number] | LineTotal=[number]
If a column is blank write NULL for that field.
Do NOT include subtotal/total rows here — only product/service rows.

━━━━━━━━━━━━━━━━━━━━
ZONE C — TOTALS SECTION (bottom rows: the money summary)
━━━━━━━━━━━━━━━━━━━━
List EVERY labelled row in the totals section in the order they appear:
TOTALS ROW [n]: Label="[exact label]" | Value=[exact number as printed]

CRITICAL RULES for Zone C:
- For GRA Tax Invoices the rows are labeled (i) through (vii). Copy EACH label and value:
    (i)   Tax Exclusive Value
    (ii)  NHIL (2.5%)
    (iii) GETFund Levy (2.5%)
    (iv)  COVID-19 Levy (1%)
    (v)   Total Levy Inclusive Value
    (vi)  VAT (15%)
    (vii) Total Tax Inclusive Value  ← THIS is the grand total the customer pays
- For non-GRA documents list every row (Subtotal, Discount, Tax, Total, etc.)
- Copy numbers EXACTLY as printed. "10,010.00" → write "10,010.00", do NOT simplify to "10010".

━━━━━━━━━━━━━━━━━━━━
ZONE D — GRAND TOTAL (the single final amount)
━━━━━━━━━━━━━━━━━━━━
GRAND TOTAL AMOUNT: [the final payable number, exactly as written]
GRAND TOTAL LABEL: [the label next to it, e.g. "Total Tax Inclusive Value" or "TOTAL"]
CURRENCY: [GHS / USD / GBP / EUR / as shown, default GHS]

━━━━━━━━━━━━━━━━━━━━
ZONE E — ANOMALIES & CONFIDENCE
━━━━━━━━━━━━━━━━━━━━
IMAGE QUALITY: [Clear / Slightly blurry / Dark / Very hard to read]
UNCERTAIN FIELDS: [list any field you are not 100% sure about]
ANY OTHER TEXT: [stamps, handwritten notes, signatures, payment method, etc.]`;

function buildMathPreCheckPrompt(transcription: string): string {
  return `You are an arithmetic auditor. Below is a raw OCR transcription of an invoice. Check whether the numbers are internally consistent BEFORE anyone converts this to structured data.

TRANSCRIPTION:
${transcription}

YOUR TASK:
1. Extract every number from Zone B (line items) and Zone C (totals).
2. Sum all LineTotal values from Zone B to get ITEMS_SUM.
3. Identify the pre-tax subtotal from Zone C (row (i) for GRA, or "Subtotal" for others).
4. Identify each tax component and sum them to get TAX_SUM.
5. Identify the grand total from Zone D or Zone C last row.
6. Check: does ITEMS_SUM ≈ subtotal? Does subtotal + TAX_SUM ≈ grand total?

Report ONLY this JSON — no markdown, no explanation:
{
  "items_sum": number_or_null,
  "subtotal_from_transcription": number_or_null,
  "tax_sum_from_transcription": number_or_null,
  "grand_total_from_transcription": number_or_null,
  "items_match_subtotal": true_or_false_or_null,
  "subtotal_plus_tax_matches_total": true_or_false_or_null,
  "discrepancies": ["list any mismatch with details"],
  "is_gra_invoice": true_or_false,
  "corrected_grand_total": number_or_null,
  "math_notes": ["any observations"]
}`;
}

function buildPass2Prompt(transcription: string, mathCheck: any): string {
  const mathContext = mathCheck
    ? `
ARITHMETIC AUDIT RESULTS (verified by a separate math pass — TRUST these numbers):
- Items sum: ${mathCheck.items_sum ?? 'unknown'}
- Subtotal (pre-tax): ${mathCheck.subtotal_from_transcription ?? 'unknown'}
- Tax total: ${mathCheck.tax_sum_from_transcription ?? 'unknown'}
- Grand total: ${mathCheck.grand_total_from_transcription ?? 'unknown'}
- Items match subtotal: ${mathCheck.items_match_subtotal ?? 'unknown'}
- Subtotal + Tax matches Grand Total: ${mathCheck.subtotal_plus_tax_matches_total ?? 'unknown'}
- Discrepancies found: ${(mathCheck.discrepancies ?? []).join('; ') || 'none'}
- Is GRA invoice: ${mathCheck.is_gra_invoice ?? 'unknown'}
- Math-corrected grand total: ${mathCheck.corrected_grand_total ?? 'use transcription value'}

CRITICAL: If "math-corrected grand total" is provided, use it as the "total" field.
` : '';

  return `You are a JSON data extraction specialist. Convert the invoice transcription below into the exact JSON schema specified. Use the arithmetic audit results to resolve any ambiguity.

TRANSCRIPTION:
${transcription}
${mathContext}

EXTRACTION RULES:
1. "total" MUST be the final amount the customer pays (Grand Total from Zone D / row (vii) for GRA). NEVER use row (i) Tax Exclusive Value as the total.
2. "subtotal" = pre-tax base amount (row (i) for GRA, or items sum for simple receipts).
3. "tax" = the SUM of ALL tax components. For GRA: NHIL + GETFund + COVID Levy + VAT.
4. All monetary values: strip currency symbols and commas. "GHS 10,010.00" → 10010.00 as a number.
5. "customer_name" = the VENDOR/SELLER name (top of document, Zone A SELLER field).
6. For missing fields use null — do not invent values.
7. "confidence" fields: "high" (clearly visible), "medium" (partially visible/inferred), "low" (guessed or unclear).

Respond ONLY with this JSON — no markdown, no explanation, no trailing text:

{
  "invoice_number": "string or null",
  "invoice_number_confidence": "high|medium|low",
  "date": "YYYY-MM-DD or original string or null",
  "date_confidence": "high|medium|low",
  "due_date": "string or null",
  "customer_name": "SELLER/VENDOR name from top of document, or null",
  "customer_name_confidence": "high|medium|low",
  "buyer_name": "buyer/customer name if different from seller, or null",
  "category": "one of: Groceries | Building Materials | Office Supplies | Utilities | Transport | Dining | Electronics | Healthcare | Fuel | Other",
  "is_gra_invoice": true_or_false,
  "supplier_tin": "string or null",
  "currency": "GHS or detected currency",
  "items": [
    {
      "name": "string or null",
      "quantity": number_or_null,
      "unit_price": number_or_null,
      "unit_price_confidence": "high|medium|low",
      "line_total": number_or_null,
      "line_total_confidence": "high|medium|low"
    }
  ],
  "subtotal": number_or_null,
  "subtotal_confidence": "high|medium|low",
  "nhil": number_or_null,
  "getfund": number_or_null,
  "covid_levy": number_or_null,
  "vat": number_or_null,
  "vat_confidence": "high|medium|low",
  "tax": number_or_null,
  "tax_confidence": "high|medium|low",
  "total": number_or_null,
  "total_confidence": "high|medium|low",
  "ocr_notes": "any uncertainties, hard-to-read areas, or important observations"
}`;
}

const RECONCILIATION_PROMPT = `You are a forensic auditor doing a TARGETED re-read of one specific section of an invoice image.

FOCUS ONLY on the TOTALS / SUMMARY section at the BOTTOM of the document — ignore everything else.

Your ONLY task is to find and transcribe the FINAL GRAND TOTAL — the single largest, most prominent number at the very bottom, representing the full amount to be paid.

For GRA invoices: this is row (vii) "Total Tax Inclusive Value".
For cash receipts: this is the circled, underlined, or boxed final number.
For printed receipts: this is the "TOTAL", "AMOUNT DUE", or "BALANCE DUE" line.

Read EVERY number you can see in the bottom third of the document and list them:
TOTAL ZONE NUMBERS:
- [label]: [exact number as printed]
- [label]: [exact number as printed]
...

GRAND TOTAL: [the final payable amount — exact digits]
GRAND TOTAL LABEL: [the exact label next to it]
CONFIDENCE: [high / medium / low]
REASON FOR UNCERTAINTY (if not high): [explain what makes it hard to read]`;

// ─────────────────────────────────────────────────────────────
// LAYER 4 — DETERMINISTIC MATH ENGINE
// ─────────────────────────────────────────────────────────────

interface MathResult {
  correctedSubtotal: number | undefined;
  correctedTax:      number | undefined;
  correctedTotal:    number | undefined;
  mathOverride:      boolean;
  mathNotes:         string[];
  mathErrors:        string[];
}

function runMathEngine(ai: any): MathResult {
  const mathNotes:  string[] = [];
  const mathErrors: string[] = [];
  let mathOverride = false;

  const subtotal  = parseNumber(ai.subtotal);
  const nhil      = parseNumber(ai.nhil);
  const getfund   = parseNumber(ai.getfund);
  const covidLevy = parseNumber(ai.covid_levy);
  const vat       = parseNumber(ai.vat);
  const aiTax     = parseNumber(ai.tax);
  const aiTotal   = parseNumber(ai.total);

  let correctedTax = aiTax;
  const hasGraLevies = nhil !== undefined || getfund !== undefined || covidLevy !== undefined || vat !== undefined;
  if (hasGraLevies) {
    const computedTax = safeSum(nhil, getfund, covidLevy, vat);
    if (aiTax === undefined) {
      correctedTax = computedTax;
      mathNotes.push(`Tax derived from levies: NHIL(${nhil ?? 0}) + GETFund(${getfund ?? 0}) + COVID(${covidLevy ?? 0}) + VAT(${vat ?? 0}) = ${computedTax}`);
    } else if (Math.abs(computedTax - aiTax) > 0.05) {
      mathNotes.push(`Tax corrected from ${aiTax} → ${computedTax} (levies sum)`);
      correctedTax = computedTax;
      mathOverride = true;
    }
  }

  if (ai.is_gra_invoice && subtotal && subtotal > 0) {
    const expectedNhil    = Math.round(subtotal * 0.025 * 100) / 100;
    const expectedGetfund = Math.round(subtotal * 0.025 * 100) / 100;
    const expectedCovid   = Math.round(subtotal * 0.010 * 100) / 100;
    const levyBase        = safeSum(subtotal, nhil ?? expectedNhil, getfund ?? expectedGetfund, covidLevy ?? expectedCovid);
    const expectedVat     = Math.round(levyBase * 0.15 * 100) / 100;
    if (nhil !== undefined && Math.abs(nhil - expectedNhil) > 0.15)
      mathErrors.push(`NHIL: invoice shows ${nhil.toFixed(2)}, expected ~${expectedNhil.toFixed(2)} (2.5% of ${subtotal.toFixed(2)}). Verify.`);
    if (getfund !== undefined && Math.abs(getfund - expectedGetfund) > 0.15)
      mathErrors.push(`GETFund: invoice shows ${getfund.toFixed(2)}, expected ~${expectedGetfund.toFixed(2)} (2.5% of ${subtotal.toFixed(2)}). Verify.`);
    if (covidLevy !== undefined && Math.abs(covidLevy - expectedCovid) > 0.15)
      mathErrors.push(`COVID-19 Levy: invoice shows ${covidLevy.toFixed(2)}, expected ~${expectedCovid.toFixed(2)} (1% of ${subtotal.toFixed(2)}). Verify.`);
    if (vat !== undefined && Math.abs(vat - expectedVat) > 1.50)
      mathErrors.push(`VAT: invoice shows ${vat.toFixed(2)}, expected ~${expectedVat.toFixed(2)} (15% on levy base ${levyBase.toFixed(2)}). Verify.`);
  }

  let correctedTotal = aiTotal;
  if (subtotal !== undefined && correctedTax !== undefined) {
    const computedTotal = safeSum(subtotal, correctedTax);
    if (aiTotal === undefined) {
      correctedTotal = computedTotal;
      mathNotes.push(`Total computed: ${subtotal} + ${correctedTax} = ${computedTotal}`);
      mathOverride = true;
    } else if (Math.abs(computedTotal - aiTotal) > 0.10) {
      const pct = Math.abs(computedTotal - aiTotal) / Math.max(aiTotal, 1) * 100;
      if (pct > 1) {
        mathErrors.push(
          `Grand total mismatch: subtotal(${subtotal.toFixed(2)}) + tax(${correctedTax.toFixed(2)}) = ${computedTotal.toFixed(2)}, ` +
          `but invoice shows ${aiTotal.toFixed(2)} (diff ${Math.abs(aiTotal - computedTotal).toFixed(2)}). ` +
          (ai.is_gra_invoice ? 'Trusting printed total for GRA invoice.' : 'Math override applied.')
        );
        if (!ai.is_gra_invoice) { correctedTotal = computedTotal; mathOverride = true; }
      }
    }
  }

  return { correctedSubtotal: subtotal, correctedTax, correctedTotal, mathOverride, mathNotes, mathErrors };
}

// ─────────────────────────────────────────────────────────────
// LAYER 5 — HALLUCINATION GUARD
// ─────────────────────────────────────────────────────────────

interface HallucinationReport {
  isHallucinated: boolean;
  flags: string[];
  totalUncertain: boolean;
}

function runHallucinationGuard(ai: any, math: MathResult): HallucinationReport {
  const flags: string[] = [];
  const total    = math.correctedTotal ?? parseNumber(ai.total);
  const subtotal = math.correctedSubtotal;
  const tax      = math.correctedTax;
  const items    = ai.items ?? [];

  if (total !== undefined && subtotal !== undefined && total < subtotal)
    flags.push(`Grand total (${total}) is less than subtotal (${subtotal}) — impossible. Likely a misread.`);
  if ((total === undefined || total === 0) && items.length > 0)
    flags.push(`Grand total is zero/missing but ${items.length} line items were found. Total was not read correctly.`);
  if (tax !== undefined && subtotal !== undefined && subtotal > 0 && tax > subtotal)
    flags.push(`Tax (${tax}) exceeds subtotal (${subtotal}) — implies >100% tax rate. Verify manually.`);
  for (const item of items) {
    const lt = parseNumber(item.line_total);
    if (lt !== undefined && total !== undefined && total > 0 && lt > total * 1.05)
      flags.push(`Item "${item.name}" line total (${lt}) exceeds grand total (${total}) — likely a misread.`);
  }
  if (ai.date) {
    const year = parseInt(String(ai.date).slice(0, 4));
    if (year < 2000 || year > 2030)
      flags.push(`Invoice date year "${year}" is implausible. Date may have been misread.`);
  }
  if (ai.total_confidence === 'low' && math.correctedTotal === undefined)
    flags.push(`Grand total extracted with LOW confidence and cannot be verified mathematically. Manual review required.`);
  const allNullLineTotals = items.length > 0 && items.every((i: any) => parseNumber(i.line_total) === undefined);
  if (allNullLineTotals && items.length > 0)
    flags.push(`No line totals could be read for any item. Items table may not have been captured correctly.`);

  const totalUncertain =
    (ai.total_confidence === 'low' && math.correctedTotal === undefined) ||
    (total === undefined || total === 0);

  return { isHallucinated: flags.length > 0, flags, totalUncertain };
}

// ─────────────────────────────────────────────────────────────
// PROTOCOL 9 — SALESMAN RISK VERDICT
// ─────────────────────────────────────────────────────────────

function buildRiskVerdict(params: {
  errors:                ValidationError[];
  hallucinationFlags:    string[];
  mathErrors:            string[];
  isDuplicate:           boolean;
  duplicateOfId?:        string;
  isPartialPayment:      boolean;
  partialOrigTotal?:     number;
  priceWarnings:         string[];
  total:                 number | undefined;
  reconciliationApplied: boolean;
  mathOverride:          boolean;
}): RiskVerdictResult {
  const {
    errors, hallucinationFlags, mathErrors,
    isDuplicate, duplicateOfId,
    isPartialPayment, partialOrigTotal,
    priceWarnings, total,
    reconciliationApplied, mathOverride,
  } = params;

  const details: string[] = [];
  let verdict: RiskVerdict = 'ACCEPT';
  let reason = 'Invoice checks out. You can collect the money.';
  let moneyAtRisk = 0;

  const hasCriticalMathError = mathErrors.length > 0;
  const hasHallucination = hallucinationFlags.some(f =>
    f.includes('Grand total') || f.includes('impossible') || f.includes('line total')
  );

  if (isDuplicate) {
    verdict = 'REJECT';
    reason = `STOP — this invoice has already been submitted before${duplicateOfId ? ` (ID: ${duplicateOfId})` : ''}. Do NOT collect money again.`;
    moneyAtRisk = total ?? 0;
    details.push('Duplicate invoice detected. Collecting again would be paying twice.');
  } else if (isPartialPayment && partialOrigTotal !== undefined) {
    verdict = 'CAUTION';
    reason = `This looks like a partial payment. The original invoice total was ${partialOrigTotal.toFixed(2)} but this one shows ${total?.toFixed(2) ?? '?'}. Confirm with your manager before accepting.`;
    moneyAtRisk = partialOrigTotal - (total ?? 0);
    details.push(`Partial payment: expected ${partialOrigTotal.toFixed(2)}, received ${total?.toFixed(2) ?? '?'}`);
  } else if (hasHallucination && total === undefined) {
    verdict = 'ESCALATE';
    reason = `The invoice total could not be read reliably. Do NOT collect money — call your manager to verify the amount first.`;
    moneyAtRisk = 0;
    details.push(...hallucinationFlags);
  } else if (hasCriticalMathError) {
    verdict = 'ESCALATE';
    reason = `The numbers on this invoice do not add up correctly. Call your manager before accepting payment — there may be an error or manipulation.`;
    moneyAtRisk = total ?? 0;
    details.push(...mathErrors);
  } else if (priceWarnings.length > 0) {
    const bigSpike = priceWarnings.some(w => { const m = w.match(/(\d+)%/); return m && parseInt(m[1]) > 50; });
    verdict = bigSpike ? 'ESCALATE' : 'CAUTION';
    reason = bigSpike
      ? `One or more item prices have more than doubled since the last invoice from this vendor. Do not accept without manager approval.`
      : `Some item prices are significantly higher than the last invoice from this vendor. Double-check the prices before collecting.`;
    moneyAtRisk = total ?? 0;
    details.push(...priceWarnings);
  } else if (errors.some(e => e.field === 'total')) {
    verdict = 'CAUTION';
    reason = `The grand total has an issue. Verify the amount (${total?.toFixed(2) ?? 'unknown'}) matches what's printed on the invoice before collecting.`;
    moneyAtRisk = total ?? 0;
    details.push(...errors.filter(e => e.field === 'total').map(e => e.message));
  } else if (errors.some(e => ['invoice_number', 'customer_name', 'date'].includes(e.field))) {
    verdict = 'CAUTION';
    const missing = errors.filter(e => ['invoice_number', 'customer_name', 'date'].includes(e.field)).map(e => e.field.replace('_', ' ')).join(', ');
    reason = `Invoice is missing key information (${missing}). Collect only if the vendor can clarify these details.`;
    moneyAtRisk = 0;
    details.push(...errors.map(e => e.message));
  } else if (errors.length === 0 && hallucinationFlags.length === 0 && mathErrors.length === 0) {
    verdict = 'ACCEPT';
    if (reconciliationApplied) {
      reason = `Invoice verified after extra re-check. The total of ${total?.toFixed(2) ?? '?'} is confirmed. You can collect the money.`;
    } else if (mathOverride) {
      verdict = 'CAUTION';
      reason = `Invoice total was auto-corrected by arithmetic verification to ${total?.toFixed(2) ?? '?'}. Verify the number matches what's printed.`;
    } else {
      reason = `All checks passed. Invoice total is ${total?.toFixed(2) ?? '?'}. You can collect the money.`;
    }
  } else {
    verdict = 'CAUTION';
    reason = `Invoice has minor issues — review the flagged fields before collecting ${total !== undefined ? total.toFixed(2) : 'the stated amount'}.`;
    moneyAtRisk = 0;
    details.push(...errors.map(e => e.message));
  }

  for (const f of hallucinationFlags) { if (!details.includes(f)) details.push(f); }

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
// fix #2: accepts SlimInvoiceResult[] (ocrText stripped client-side)
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

    // PASS 1
    console.log('[Invoice] Pass 1: region-aware OCR...');
    const transcription = await callGroqVision(imageUrl, PASS1_PROMPT, groqApiKey);
    console.log('[Invoice] Pass 1 done, length:', transcription.length);

    // LAYER 2 — Math pre-check
    console.log('[Invoice] Math pre-check...');
    let mathCheck: any = null;
    try {
      mathCheck = parseGroqJson(await callGroqText(buildMathPreCheckPrompt(transcription), groqApiKey, 1000));
      console.log('[Invoice] Math pre-check result:', JSON.stringify(mathCheck).slice(0, 200));
    } catch (e) { console.warn('[Invoice] Math pre-check failed (non-fatal):', e); }

    // PASS 2
    console.log('[Invoice] Pass 2: structured JSON extraction...');
    let rawJson = '';
    try {
      rawJson = await callGroqText(buildPass2Prompt(transcription, mathCheck), groqApiKey, 2500);
    } catch (textErr) {
      console.warn('[Invoice] All text models failed for Pass 2, falling back to vision model:', textErr);
      rawJson = await callGroqVision(imageUrl, buildPass2Prompt(transcription, mathCheck), groqApiKey);
    }

    let ai = parseGroqJson(rawJson);
    let math = runMathEngine(ai);
    let hallucinationReport = runHallucinationGuard(ai, math);

    // PROTOCOL 8 — Reconciliation re-query
    // fix #9: only fire when items were found (otherwise the totals zone doesn't exist to re-read)
    let reconciliationApplied = false;
    const hasItems = (ai.items ?? []).length > 0;
    if (hallucinationReport.totalUncertain && hasItems) {
      console.log('[Invoice] Protocol 8: reconciliation re-query...');
      try {
        const reconText = await callGroqVision(imageUrl, RECONCILIATION_PROMPT, groqApiKey);
        const totalMatch = reconText.match(/GRAND TOTAL:\s*([\d,]+\.?\d*)/i);
        const confidenceMatch = reconText.match(/CONFIDENCE:\s*(high|medium|low)/i);
        if (totalMatch) {
          const reconTotal = parseNumber(totalMatch[1]);
          const reconConf = (confidenceMatch?.[1] ?? 'medium').toLowerCase();
          if (reconTotal && reconTotal > 0 && reconConf !== 'low') {
            ai = { ...ai, total: reconTotal, total_confidence: reconConf };
            math = runMathEngine(ai);
            hallucinationReport = runHallucinationGuard(ai, math);
            reconciliationApplied = true;
            console.log(`[Invoice] Reconciliation: total → ${reconTotal} (${reconConf})`);
          }
        }
      } catch (e) { console.warn('[Invoice] Protocol 8 failed (non-fatal):', e); }
    }

    // BUILD VALIDATED DATA
    const validatedData: ValidatedData = {
      invoice_number: ai.invoice_number || undefined,
      date:           ai.date || undefined,
      customer_name:  ai.customer_name || undefined,
      category:       ai.category || undefined,
      subtotal:       math.correctedSubtotal,
      tax:            math.correctedTax,
      total:          math.correctedTotal ?? parseNumber(ai.total),
      items: (ai.items ?? []).map((item: any) => ({
        name:       item.name || undefined,
        quantity:   parseNumber(item.quantity) ?? item.quantity,
        unit_price: parseNumber(item.unit_price),
        line_total: parseNumber(item.line_total),
      })),
    };

    // VALIDATION ERRORS
    const errors: ValidationError[] = [];
    if (!validatedData.invoice_number)
      errors.push({ field: 'invoice_number', message: 'Invoice number is missing or unreadable.' });
    if (!validatedData.customer_name)
      errors.push({ field: 'customer_name', message: 'Vendor/store name is missing or unreadable.' });
    if (validatedData.total === undefined)
      errors.push({ field: 'total', message: 'Grand total is missing. Check the bottom of the invoice.' });
    if (!validatedData.items || validatedData.items.length === 0)
      errors.push({ field: 'items', message: 'No line items found on this invoice.' });
    if (ai.total_confidence === 'low' && !reconciliationApplied)
      errors.push({ field: 'total', message: `Grand total was difficult to read (low confidence). Verify the amount: ${validatedData.total?.toFixed(2) ?? 'unknown'}.` });
    if (ai.subtotal_confidence === 'low')
      errors.push({ field: 'subtotal', message: 'Subtotal was difficult to read. Please verify.' });
    if (ai.customer_name_confidence === 'low')
      errors.push({ field: 'customer_name', message: `Vendor name was partially readable. Verify: "${validatedData.customer_name}".` });
    for (const flag of hallucinationReport.flags)
      errors.push({ field: 'hallucination', message: `⚠️ ${flag}` });
    for (const msg of math.mathErrors)
      errors.push({ field: 'math', message: msg });

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
          if (Math.abs(expected - lineTotal) > 0.10)
            errors.push({ field: `items[${i}].line_total`, message: `"${item.name || 'Item'}" maths: ${qty} × ${unitPrice.toFixed(2)} = ${expected.toFixed(2)}, invoice shows ${lineTotal.toFixed(2)} (diff ${Math.abs(lineTotal - expected).toFixed(2)}).` });
        }
      }
    }
    itemsSum = Math.round(itemsSum * 100) / 100;

    if (validatedData.subtotal !== undefined && itemsSum > 0 && Math.abs(itemsSum - validatedData.subtotal) > 0.10)
      errors.push({ field: 'subtotal', message: `Line items sum to ${itemsSum.toFixed(2)} but subtotal shows ${validatedData.subtotal.toFixed(2)}.` });
    if (validatedData.subtotal !== undefined && validatedData.tax !== undefined && validatedData.total !== undefined) {
      const expectedTotal = safeSum(validatedData.subtotal, validatedData.tax);
      if (Math.abs(expectedTotal - validatedData.total) / Math.max(validatedData.total, 1) * 100 > 1)
        errors.push({ field: 'total', message: `Total check: ${validatedData.subtotal.toFixed(2)} + tax ${validatedData.tax.toFixed(2)} = ${expectedTotal.toFixed(2)}, invoice shows ${validatedData.total.toFixed(2)}.` });
    }
    if (!ai.is_gra_invoice && validatedData.subtotal && validatedData.tax && validatedData.subtotal > 0) {
      const impliedRate = Math.round((validatedData.tax / validatedData.subtotal) * 10000) / 100;
      if (impliedRate > 0 && Math.abs(impliedRate - taxRatePct) > 8)
        errors.push({ field: 'tax', message: `Tax rate appears unusual: ${impliedRate}% (expected ~${taxRatePct}%). Verify before receiving payment.` });
    }
    const dateWarning = checkDateAnomaly(validatedData.date);
    if (dateWarning) errors.push({ field: 'date', message: dateWarning });

    // PROTOCOL 6 — Vendor price memory
    let priceWarnings: string[] = [];
    const priceWarningsAt = new Date().toISOString(); // fix #11
    if (invoiceHistory.length > 0) {
      const vendorProfiles = buildVendorProfiles(invoiceHistory as InvoiceProcessingResult[]);
      const vendorKey = normaliseVendorKey(validatedData.customer_name);
      const tempResult = { id: '__temp__', validatedData, errors: [], isValid: true, ocrText: '', status: 'verified' as const, createdAt: new Date().toISOString() } as InvoiceProcessingResult;
      priceWarnings = checkPriceMemory(tempResult, vendorProfiles[vendorKey]);
      for (const w of priceWarnings) errors.push({ field: 'price_memory', message: w });
    }

    // PROTOCOL 7 — Duplicate + partial payment detection
    let isDuplicate = false, duplicateOfId: string | undefined;
    let isPartialPayment = false, partialPaymentOriginalTotal: number | undefined, partialPaymentOriginalId: string | undefined;
    let isRecurring = false, recurringDelta: number | undefined;

    if (invoiceHistory.length > 0) {
      const tempForDetection = { id: '__new__', validatedData, errors, isValid: errors.length === 0, ocrText: '', status: 'verified' as const, createdAt: new Date().toISOString(), vendorKey: normaliseVendorKey(validatedData.customer_name) } as InvoiceProcessingResult;
      const dupResult = detectDuplicate(tempForDetection, invoiceHistory as InvoiceProcessingResult[]);
      isDuplicate = dupResult.isDuplicate;
      duplicateOfId = dupResult.duplicateOfId;

      if (isDuplicate) {
        errors.push({ field: 'duplicate', message: `🔴 DUPLICATE INVOICE: Already recorded${duplicateOfId ? ` (matches ID ${duplicateOfId})` : ''}. Do NOT collect money again.` });
      } else {
        const partialResult = detectPartialPayment(tempForDetection, invoiceHistory as InvoiceProcessingResult[]);
        isPartialPayment = partialResult.isPartial;
        partialPaymentOriginalTotal = partialResult.originalTotal;
        partialPaymentOriginalId = partialResult.originalId;
        if (isPartialPayment && partialPaymentOriginalTotal !== undefined)
          errors.push({ field: 'partial_payment', message: `⚠️ PARTIAL PAYMENT: Original total was ${partialPaymentOriginalTotal.toFixed(2)}, this shows ${validatedData.total?.toFixed(2) ?? '?'}. Confirm with manager.` });

        const vendorProfiles = buildVendorProfiles(invoiceHistory as InvoiceProcessingResult[]);
        const recurringResult = detectRecurring(tempForDetection, vendorProfiles[normaliseVendorKey(validatedData.customer_name)]);
        isRecurring = recurringResult.isRecurring;
        recurringDelta = recurringResult.recurringDelta;
      }
    }

    // PROTOCOL 9 — Salesman risk verdict
    const riskVerdict = buildRiskVerdict({
      errors, hallucinationFlags: hallucinationReport.flags, mathErrors: math.mathErrors,
      isDuplicate, duplicateOfId, isPartialPayment, partialOrigTotal: partialPaymentOriginalTotal,
      priceWarnings, total: validatedData.total, reconciliationApplied, mathOverride: math.mathOverride,
    });

    // BUILD FINAL RESULT
    const isValid = errors.length === 0;
    const ocrText =
      `[InvoiceGuard AI v3.2 | ${ai.currency ?? 'GHS'}${ai.is_gra_invoice ? ' | GRA Tax Invoice' : ''}${ai.supplier_tin ? ` | TIN: ${ai.supplier_tin}` : ''}]\n\n` +
      `PASS 1 — REGION-AWARE OCR:\n${transcription}\n\n` +
      (ai.is_gra_invoice ? `GRA Levy Breakdown:\n  (i) ${ai.subtotal} | (ii) NHIL ${ai.nhil} | (iii) GETFund ${ai.getfund} | (iv) COVID ${ai.covid_levy} | (vi) VAT ${ai.vat} | (vii) TOTAL ${ai.total}\n\n` : '') +
      (mathCheck ? `Arithmetic Pre-Check: items_sum=${mathCheck.items_sum} subtotal=${mathCheck.subtotal_from_transcription} tax=${mathCheck.tax_sum_from_transcription} total=${mathCheck.grand_total_from_transcription} match=${mathCheck.subtotal_plus_tax_matches_total}\n\n` : '') +
      (math.mathNotes.length ? `Math Engine: ${math.mathNotes.join(' | ')}\n\n` : '') +
      (hallucinationReport.flags.length ? `Hallucination Guard:\n  ${hallucinationReport.flags.join('\n  ')}\n\n` : '') +
      `Field Confidence: Invoice#=${ai.invoice_number_confidence} Date=${ai.date_confidence} Vendor=${ai.customer_name_confidence} Subtotal=${ai.subtotal_confidence} Tax=${ai.tax_confidence} Total=${ai.total_confidence}` +
      (math.mathOverride ? ' | ⚠️ Math override' : '') + (reconciliationApplied ? ' | ✅ Reconciled' : '') + '\n\n' +
      (priceWarnings.length ? `Price Warnings:\n  ${priceWarnings.join('\n  ')}\n\n` : '') +
      `Risk Verdict: ${riskVerdict.verdict} — ${riskVerdict.reason}\n\n` +
      `PASS 2 — EXTRACTED JSON:\n${JSON.stringify(ai, null, 2)}`;

    const result: InvoiceProcessingResult = {
      id: crypto.randomUUID(), isValid, errors, validatedData, ocrText,
      status:                  isValid ? 'verified' : 'error',
      createdAt:               new Date().toISOString(),
      dueDate:                 ai.due_date || undefined,
      vendorKey:               normaliseVendorKey(validatedData.customer_name),
      smartName:               buildSmartName(validatedData),
      currency:                ai.currency || 'GHS',
      isDuplicate, duplicateOfId,
      isPartialPayment, partialPaymentOriginalTotal, partialPaymentOriginalId,
      isRecurring, recurringDelta,
      priceWarnings,
      priceWarningsAt,         // fix #11
      reconciliationApplied,
      riskVerdict,
    };
    result.healthScore = calcHealthScore(result);
    return result;

  } catch (error: any) {
    const msg = typeof error?.message === 'string' && error.message.length < 800 ? error.message : 'Unknown server error';
    console.error('--- processInvoice error ---', error);
    throw new Error(`Invoice processing failed: ${msg}`);
  }
}
