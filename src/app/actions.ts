'use server';

/**
 * actions.ts — InvoiceGuard AI Processing Engine v7.0
 *
 * v7.0 — new intelligence checks + speed improvement:
 *  #I03 Round number anomaly on multi-item invoices
 *  #I04 Fuzzy vendor name matching (Levenshtein)
 *  #I11 Cumulative vendor spend threshold (GHS 50,000)
 *  + salesmanSummary field on every result
 *  + Math pre-check and Pass 2 now run in parallel (approx 40% faster)
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
 *
 * v7.1 — Handwriting OCR improvements:
 *  - 5 critical rules added to PASS1_PROMPT to prevent skipping unknown item names
 *  - Examples of real Ghana electrical items (SASSIN, TRUNKING, ROSETTE) added
 *  - High-value item warning (watch for lines with prices 50+ GHS)
 *  - ESCALATE / column-sum error messages updated to say "rewrite the correct invoice"
 *
 * v7.2 — Quantity & digit misread fixes (from real COFKANS invoice analysis):
 *  - QUANTITY FIRST rule: read the QTY column digit-by-digit before item name
 *  - 9 vs 8 warning extended: SASSIN unit price is 90, never 80
 *  - Multi-digit quantity warning: 9, 5, 3, 2 are common qty values — not just 1
 *  - Line total cross-check: if qty>1 and line total = unit price, flag as likely qty misread
 *  - Date year sanity: if year < 2015 on a Ghana invoice, flag as possible misread
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
    checkCustomerCreditHistory,
} from '@/lib/invoice-intelligence';

// -----------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------

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

// -----------------------------------------------------------------
// MODEL LISTS
// -----------------------------------------------------------------

const VISION_MODELS = [
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
];

// -----------------------------------------------------------------
// GEMINI VISION (free tier — better handwriting OCR than Groq Llama)
// Set GEMINI_API_KEY in .env.local to enable.
// Falls back to Groq if not set.
// -----------------------------------------------------------------
async function callOpenRouterVision(imageUrl: string, prompt: string, apiKey: string): Promise<string> {
  const match = imageUrl.match(/^data:(.+);base64,(.+)$/);
  const base64Data = match ? match[2] : imageUrl;
  const mimeType = match ? match[1] : 'image/jpeg';

  const response = await fetchWithRetry(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://invoiceguard.app',
        'X-Title': 'InvoiceGuard',
      },
      body: JSON.stringify({
        model: 'openrouter/auto',
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}` } },
            { type: 'text', text: prompt },
          ]
        }],
        temperature: 0.0,
        max_tokens: 4000,
      }),
    },
    3
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from OpenRouter.');
  return content;
}

async function callGeminiVision(imageUrl: string, prompt: string, apiKey: string): Promise<string> {
  // Extract base64 data and mime type
  const match = imageUrl.match(/^data:(.+);base64,(.+)$/);
  const mimeType = match ? match[1] : 'image/jpeg';
  const base64Data = match ? match[2] : imageUrl;

  const response = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mimeType, data: base64Data } },
            { text: prompt }
          ]
        }],
        generationConfig: { temperature: 0.0, maxOutputTokens: 4000 },
      }),
    },
    3
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini vision error ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error('Empty response from Gemini vision.');
  return content;
}

function getVisionCaller(imageUrl: string, prompt: string): Promise<string> {
  // OpenRouter is the primary vision provider — free, no daily limit, better OCR
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (openRouterKey) {
    console.log('[Vision] Using OpenRouter (gemini-2.0-flash-exp:free)');
    return callOpenRouterVision(imageUrl, prompt, openRouterKey).catch(async (err: Error) => {
      console.warn(`[Vision] OpenRouter failed: ${err.message} — falling back to Gemini/Groq`);
      return getGeminiFallback(imageUrl, prompt);
    });
  }
  return getGeminiFallback(imageUrl, prompt);
}

function getGeminiFallback(imageUrl: string, prompt: string): Promise<string> {
  // Collect all Gemini keys — rotate through them to spread load across free-tier projects
  const geminiKeys = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
  ].filter(Boolean) as string[];

  const groqKey = process.env.GROQ_API_KEY;

  if (geminiKeys.length > 0) {
    // Pick a random key from available keys to distribute load
    const key = geminiKeys[Math.floor(Math.random() * geminiKeys.length)];
    console.log(`[Vision] Using Gemini 2.0 Flash (key ...${key.slice(-6)})`);
    return callGeminiVision(imageUrl, prompt, key).catch(async (err: Error) => {
      // If this key is rate-limited, try the others in sequence
      console.warn(`[Vision] Gemini key ...${key.slice(-6)} failed: ${err.message}`);
      for (const fallbackKey of geminiKeys.filter(k => k !== key)) {
        try {
          console.log(`[Vision] Trying fallback Gemini key ...${fallbackKey.slice(-6)}`);
          return await callGeminiVision(imageUrl, prompt, fallbackKey);
        } catch (e2) {
          console.warn(`[Vision] Fallback key also failed: ${(e2 as Error).message}`);
        }
      }
      // All Gemini keys exhausted — fall back to Groq
      if (groqKey) {
        console.warn('[Vision] All Gemini keys failed, falling back to Groq');
        return callGroqVision(imageUrl, prompt, groqKey);
      }
      throw new Error('All vision API keys exhausted. Add more GEMINI_API_KEY_2/3 keys or top up billing.');
    });
  }

  if (groqKey) {
    console.log('[Vision] Using Groq Llama vision (set GEMINI_API_KEY for better results)');
    return callGroqVision(imageUrl, prompt, groqKey);
  }

  throw new Error('No vision API key found. Set GEMINI_API_KEY or GROQ_API_KEY in .env.local');
}

const TEXT_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
];

const GROQ_BASE64_LIMIT = 3_800_000;

// -----------------------------------------------------------------
// IMAGE SIZE GUARD
// -----------------------------------------------------------------

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
    console.log(`[Invoice] Resized: ${base64Part.length} -> ${resizedB64.length} chars`);
    return `data:image/jpeg;base64,${resizedB64}`;
  } catch {
    throw new Error(
      `Image is too large for processing (${Math.round(base64Part.length / 1024)}KB base64). ` +
      `Please take a photo at lower resolution or compress the image before uploading.`
    );
  }
}

// -----------------------------------------------------------------
// DOCUMENT TYPE GUARD
// -----------------------------------------------------------------

const DOCUMENT_GUARD_PROMPT = `Look at this image carefully. Your only job is to decide if it is a financial document.

Financial documents include: invoices, receipts, bills, purchase orders, delivery notes, payment slips, POS printouts, proforma invoices, quotes with amounts, GRA tax invoices, or any paper/screen showing a monetary transaction.

Respond with ONLY a JSON object, nothing else:
{
  "is_financial_document": true or false,
  "detected_as": "one short phrase describing what the image actually is",
  "confidence": "high" or "medium" or "low"
}`;

async function guardDocumentType(imageUrl: string): Promise<{ ok: boolean; detectedAs: string }> {
  try {
    const raw = await getVisionCaller(imageUrl, DOCUMENT_GUARD_PROMPT);
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    let parsed: any;
    try { parsed = JSON.parse(cleaned); } catch { const m = cleaned.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : null; }
    if (!parsed) return { ok: true, detectedAs: 'unknown' };
    const isDoc: boolean = parsed.is_financial_document === true;
    const detectedAs: string = String(parsed.detected_as ?? 'unknown image');
    const confidence: string = String(parsed.confidence ?? 'low');
    if (!isDoc && confidence !== 'low') {
      return { ok: false, detectedAs };
    }
    return { ok: true, detectedAs };
  } catch {
    return { ok: true, detectedAs: 'unknown' };
  }
}

// -----------------------------------------------------------------
// GROQ CALLERS
// -----------------------------------------------------------------

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
        console.error(`[Groq Vision] ${model} -> HTTP ${response.status}: ${body.slice(0, 300)}`);
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
        console.error(`[Groq Text] ${model} -> HTTP ${response.status}: ${body.slice(0, 300)}`);
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

// OpenRouter text fallback — used when Groq text hits 429
async function callOpenRouterText(prompt: string, apiKey: string, maxTokens = 2500): Promise<string> {
  const response = await fetchWithRetry(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://invoiceguard.app',
        'X-Title': 'InvoiceGuard',
      },
      body: JSON.stringify({
        model: 'openrouter/auto',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.0,
        max_tokens: maxTokens,
      }),
    },
    3
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter text error ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from OpenRouter text.');
  console.log('[OpenRouter Text] Success');
  return content;
}

// Smart text caller: tries Groq first, falls back to OpenRouter on 429
async function callText(prompt: string, maxTokens = 2500): Promise<string> {
  const groqKey = process.env.GROQ_API_KEY;
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (groqKey) {
    try {
      return await callGroqText(prompt, groqKey, maxTokens);
    } catch (err: any) {
      if (err.message?.includes('429') || err.message?.includes('HTTP 429')) {
        console.warn('[Text] Groq 429, falling back to OpenRouter text');
        if (openRouterKey) return callOpenRouterText(prompt, openRouterKey, maxTokens);
      }
      throw err;
    }
  }
  if (openRouterKey) return callOpenRouterText(prompt, openRouterKey, maxTokens);
  throw new Error('No text API key available.');
}

// -----------------------------------------------------------------
// PROMPTS
// -----------------------------------------------------------------

/**
 * PASS 1 - UNIVERSAL DOCUMENT OCR (v6.0 + v7.1 handwriting improvements)
 * #4: Detects handwriting vs print and adapts reading strategy
 * #5: Character-level confidence
 * v7.1: 5 critical handwriting rules prevent skipping unknown item names
 */
const PASS1_PROMPT = `You must NEVER invent financial data that does not appear on the invoice.
If VAT, tax, or any charges are not explicitly written on the invoice, you must ignore them completely.
Violating this rule is considered a calculation error.

You are an expert forensic document reader. You will be shown a photo or scan of a financial document — it could be ANY type: a GRA tax invoice, a handwritten receipt, a POS printout, a proforma, a delivery note, a simple payment slip, or any other document used to request or record payment.

YOUR ONLY JOB: Read exactly what is on this document, character by character, digit by digit. Do not guess. Do not fill in. Do not apply any rules or rates you know from memory.

ABSOLUTE RULES:
1. Copy every number EXACTLY as printed — "1,500.50" stays "1,500.50"
2. If a character is unclear, write "?" for THAT CHARACTER ONLY — e.g. "1,5?0.00" if the 3rd digit is unclear
3. If a field is completely absent, write NONE
4. Do NOT apply any tax rates, GRA rules, or accounting formulas
5. Do NOT assume the document type — describe what you actually see
6. One wrong digit causes real financial loss — accuracy is everything

STEP 1 — DOCUMENT TYPE IDENTIFICATION:
Before reading anything, assess the physical nature of this document:

WRITING_TYPE: Is the content [PRINTED / HANDWRITTEN / MIXED] ?
  -> If HANDWRITTEN: Read letter-by-letter. Treat each character independently. Do not assume words from context.
  -> If PRINTED: Read precisely — watch for ink smudges, faded ink, similar digits (1/7, 0/6, 5/6, 8/3)
  -> If MIXED: Apply handwriting rules to handwritten parts, print rules to printed parts

DOCUMENT FORMAT: [GRA Tax Invoice / Company Invoice / Handwritten Receipt / POS Thermal Receipt / Proforma Invoice / Delivery Note / Payment Slip / Screenshot / Photocopy / Carbon Copy / Other — describe]

PHYSICAL CONDITION: [Clear / Slightly faded / Crumpled / Torn edges / Glare or reflection / Dark / Blurry / Partial cutoff]

STEP 2 — ZONE A: HEADER:
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

STEP 3 — ZONE B: LINE ITEMS:
List EVERY product/service line. Skip totals rows.

For PRINTED invoices:
  ITEM [n]: Name="[exact]" | Qty=[exact or NULL] | Unit=[e.g. carton/kg/pcs or NULL] | UnitPrice=[exact or NULL] | Discount=[exact or NULL] | LineTotal=[exact or NULL] | Currency=[currency symbol if shown or NONE]

For HANDWRITTEN invoices — extra care:
  ITEM [n]: Name="[copy exact spelling including abbreviations]" | Qty=[number — watch for 1/7, 0/6] | Unit=[or NULL] | UnitPrice=[exact — write ? for any uncertain digit] | LineTotal=[exact — write ? for any uncertain digit] | HANDWRITING_NOTE=[any difficulty reading this line]

WARNING — CRITICAL HANDWRITING RULES — READ EVERY LINE, SKIP NOTHING:
1. NEVER skip a line because the item name looks strange, abbreviated, or unfamiliar.
   Real Ghana electrical/building items include: "6WAY 1PHASE SASSIN" (consumer unit/distribution board), "TRUNKING", "CUT-OFF", "ROSETTE", "SASSIN" (distribution board), "3WAY SWITCH", "TV SOCKET", "ISOLATOR". Copy the name exactly as written even if you don't recognise it.

2. QUANTITY COLUMN — READ THIS FIRST, BEFORE THE ITEM NAME:
   The QTY column is on the LEFT. Read it digit-by-digit as a standalone number BEFORE you read the description.
   - Common Ghana invoice quantities are: 1, 2, 3, 5, 9, 10 — NOT always 1.
   - A "9" in the QTY column means NINE items, not one. A "5" means FIVE items.
   - NEVER assume qty=1 just because the item name starts with a digit (e.g. "13Amp" — the 13 is part of the item name, not the quantity).
   - After reading qty AND unit_price, compute qty × unit_price and check it matches the line total in the TOTAL column. If it does not match, reread the quantity.
   - EXAMPLE: QTY=9, UNIT=8.00, TOTAL=72.00 → 9×8=72 ✓. If you read qty=1 and get 1×8=8≠72, you misread the quantity — go back and look again.

2b. "NPC" PREFIX IN DESCRIPTION — THIS IS THE QUANTITY:
   On many Ghana handwritten invoices, the vendor writes the quantity INSIDE the description column as a prefix like "5PC", "2PC", "3PC", "1PC" instead of (or in addition to) the QTY column.
   - If the description starts with a number followed by "PC" or "PCS" (e.g. "5PC 2Gang Switch"), the number before PC IS the quantity.
   - Use that number as the qty value. Example: "5PC 2Gang Switch" → qty=5, name="2Gang Switch".
   - If the QTY column also has a number AND the description has NPC prefix, use whichever makes qty × unit_price = line_total.
   - NEVER output qty=1 for a row where the description says "5PC" or "9PC" — that is always wrong.

3. DIGIT 9 vs 8 WARNING — CRITICAL FOR SASSIN PRICES:
   The handwritten digit "9" is frequently misread as "8" or "2". Before writing ANY price:
   - SASSIN / 6WAY 1PHASE SASSIN unit price is almost always 90 GHS. Never 80 GHS. If you see 80 next to SASSIN, look again — it is 90.
   - Similarly: a price of 20 or 25 for SASSIN is wrong — it is 90 or 95.
   - The digit "9" has a round top and a tail going down-right. "8" has two stacked loops. "2" has a curved top and flat base. Look carefully.

4. LINE TOTAL SANITY CHECK — USE ARITHMETIC:
   After reading each row, compute: qty × unit_price. If the result does not match the line total you read:
   - First recheck the QUANTITY and check for "NPC" prefix in the description
   - Then recheck the UNIT PRICE
   - Then recheck the LINE TOTAL
   - EXAMPLE of common error: description says "5PC 2Gang Switch", unit price 6.00, line total 30.00.
     If you read qty=1 → 1×6=6≠30. Correct reading: qty=5 (from "5PC") → 5×6=30 ✓.
   Do this for EVERY row before moving on.

5. HIGH-VALUE ITEMS: Watch especially for items with unit prices 50.00, 90.00, 100.00, 120.00 or above — these are often the hardest to read but most financially important. If you see a large number anywhere on a line, it belongs to that line.
6. COUNT ALL LINES: Before finishing, count the total number of item rows you can see. Make sure your item count matches the physical number of rows in the table. If you missed any, go back and read them.
7. SMUDGED OR FAINT LINES: If a row is faint, tilted, or partially covered — still read it. Use ? for uncertain digits. Do NOT silently omit it.
8. SIMILAR ITEM NAMES: If the same item appears twice (e.g. "2GANG SWITCH" and "2GANG 2WAY SWITCH"), list BOTH as separate items — do not merge them.
9. STAMPS, CIRCLES AND NOTES ARE NOT LINE ITEMS — BUT MUST BE REPORTED:
   - Text written inside a circle (e.g. "Not Paid", "Paid", "2034") is a STAMP or NOTE — NOT a line item.
   - "Not Paid", "Paid", "Received", "Cancelled", "On Credit", "Credit", "Balance Due" written anywhere are PAYMENT STATUS notes.
   - A number written alone in a circle or next to "Not Paid" is the TOTAL being referenced, not a new line item.
   - ONLY include rows that are inside the items TABLE with a description and a unit price.
   - HOWEVER: You MUST report any payment status notes in the OTHER TEXT section at the end.
   - CREDIT SALE DETECTION: If you see "Not Paid", "On Credit", "Credit Sale", "Balance", "Owing" anywhere on the document, report it as:
     PAYMENT_STATUS: NOT_PAID (or PAID or CREDIT or PARTIAL)
     CREDIT_NOTE: [exact text seen]

10. VERIFY YOUR TOTAL: After reading all items, add up all your line totals. If they do not match the grand total written on the invoice, go back and recheck every QUANTITY first — a qty of 9 misread as 1 will cause a large gap.
11. DATE FORMAT — CRITICAL: Ghana invoices use several date formats — handle ALL of them:
    FORMAT A: DD-MM-YY written as one string e.g. "14-06-24" → 2024-06-14
    FORMAT B: Separate boxes labelled Day / Month / Year e.g. Day=24, Month=10, Year=25 → 2025-10-24
    FORMAT C: DD/MM/YYYY e.g. "24/10/2025" → 2025-10-24
    For FORMAT B (separate boxes): read each box independently and combine them.
    YEAR SANITY: Ghana invoices use DD-MM-YY format, NOT DD-MM-YYYY.
    - "14-06-24" means 14th June 2024 — the year is 24, meaning 2024.
    - "14-06-2012" is WRONG — nobody writes a 4-digit year starting with 20 on a handwritten Ghana invoice.
    - If you see a date where the year part is 2 digits (24, 23, 22 etc.), convert it: 24 = 2024, 23 = 2023.
    - NEVER output a year before 2020 for a Ghana handwritten invoice unless you are absolutely certain.
    - EXAMPLE: date written as "14-06-24" → output as "2024-06-14", NOT "2012-06-14".

If NO line items (lump sum only): write "NO LINE ITEMS — LUMP SUM ONLY"

STEP 4 — ZONE C: ALL TOTALS/SUMMARY ROWS:
List EVERY labelled total row in the order they appear:
TOTALS ROW [n]: Label="[exact label]" | Value=[exact number — write ? for uncertain digits]

Common labels (copy WHATEVER is written): Subtotal, Net Amount, NHIL, GETFund, COVID Levy, VAT, Tax, Discount, Delivery, Grand Total, Amount Due, Total Tax Inclusive Value

CRITICAL: If NO tax rows exist — that is normal. Many companies include VAT in product prices. List only what is actually on the document.

STEP 5 — ZONE D: FINAL PAYABLE:
GRAND TOTAL AMOUNT: [exact final amount or NONE]
GRAND TOTAL LABEL: [exact label]
CURRENCY: [GHS / USD / GBP / EUR / NGN / symbol seen — or GHS if none]

STEP 6 — CHARACTER-LEVEL CONFIDENCE:
LIST EVERY field where you used "?":
  UNCERTAIN: [field name] = "[value with ? marks]" — REASON: [what made it hard to read]

LIST any field you could not read at all:
  UNREADABLE: [field name] — REASON: [dark / blurry / torn / handwriting unclear]

STAMPS/WATERMARKS: [describe]
OTHER TEXT ON DOCUMENT: [any other text not captured above]`;

/**
 * PASS 1b — TARGETED RE-READ FOR LOW CONFIDENCE FIELDS (#3)
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
  return `STRICT RULE: NEVER invent VAT or tax. If tax is not in the transcription, all tax fields must be null.

You are a pure arithmetic auditor. Verify internal consistency of this invoice transcription.

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
2. For each item where qty AND unit_price are present: compute qty x unit_price and compare to line_total
3. Sum all line_total values -> ITEMS_SUM
4. Find subtotal if listed -> SUBTOTAL
5. Find all explicitly listed tax/levy amounts -> TAX_SUM (null if none — this is normal)
6. Find grand total -> GRAND_TOTAL
7. Check consistency:
   - items_match_subtotal: ITEMS_SUM approx SUBTOTAL (only if both present)
   - subtotal_plus_tax_matches_total: SUBTOTAL + TAX_SUM approx GRAND_TOTAL (only if all three present)
   - items_match_grand_total_directly: ITEMS_SUM approx GRAND_TOTAL (when no separate tax rows)
8. Currency check: list any items where a different currency symbol appears vs the header currency
9. Compute the running total chain: subtotal -> +taxes step by step -> final total

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
  "vat_inclusive_pricing_likely": true_or_false,
  "corrected_grand_total": number_or_null,
  "math_notes": ["observations"]
}`;
}

/**
 * PASS 2 — STRUCTURED JSON EXTRACTION (v6.0)
 */
function buildPass2Prompt(transcription: string, mathCheck: any): string {
  // VAT RULE prepended to every Pass 2 call
  const VAT_RULE = `STRICT RULE: You must NEVER invent VAT, tax, or any financial data not present in the transcription below.
If VAT or tax does not appear in the transcription, set all tax fields to null and vat_included_in_prices to true.
Violating this rule is a calculation error.\n\n`;

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
- Running total chain: ${(mathCheck.running_total_chain ?? []).join(' -> ') || 'N/A'}
- Math-corrected grand total: ${mathCheck.corrected_grand_total ?? 'not available'}
` : '';

  return `${VAT_RULE}You are a precise JSON data extractor for financial documents.

TRANSCRIPTION:
${transcription}
${mathContext}

EXTRACTION RULES:

1. NULL RULE: NONE or "?" -> null. NEVER invent.
2. TOTAL RULE: "total" = final payable. For GRA: row (vii).
3. VAT/TAX RULE: Only set tax fields if EXPLICITLY on document. If absent -> vat_included_in_prices: true, all tax fields null.
4. SUBTOTAL RULE: null if no explicit subtotal row.
5. VENDOR RULE: "customer_name" = SELLER/VENDOR at top.
6. CONFIDENCE: "high"=clear, "medium"=partially visible, "low"=uncertain/blurry.
7. CHARACTER CONFIDENCE: If any digit in a number had "?" -> set that field's confidence to "low".
8. ITEM RULE: copy names exactly — abbreviations, spelling, shorthand preserved.
9. NUMBER RULE: strip currency symbols and commas -> 1200.00
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
  "ocr_notes": "specific uncertain readings, quality issues, anything unusual",
  "payment_status": "PAID or NOT_PAID or CREDIT or PARTIAL or null",
  "credit_note": "exact text seen on invoice indicating credit/unpaid status, or null"
}`;
}

/**
 * PASS 1c — MISSING ITEMS RE-READ
 * Triggered when items_sum is significantly less than subtotal/total.
 * Forces the model to recount every row and find the missing line(s).
 */
function buildMissingItemsRereadPrompt(knownItems: string[], knownSum: number, statedTotal: number): string {
  const gap = (statedTotal - knownSum).toFixed(2);
  const itemList = knownItems.length > 0
    ? knownItems.map((n, i) => `  ${i + 1}. ${n}`).join('\n')
    : '  (none captured yet)';
  return `URGENT — MISSING OR MISREAD LINE ITEMS DETECTED

The line items found so far only add up to ${knownSum.toFixed(2)}, but the invoice subtotal/total is ${statedTotal.toFixed(2)}.
There is a gap of ${gap} — this means either a line item was MISSED or a price was MISREAD.

Items found so far:
${itemList}

YOUR TASK: Examine ONLY the items table on this invoice, with extreme care.

1. RECHECK EVERY PRICE in the list above — look at the original invoice and confirm each unit price and line total is correct.
   - Specifically: "SASSIN" or "6WAY 1PHASE SASSIN" items commonly have unit prices of 80, 90, or 100 GHS — NOT 20. If you see a SASSIN with price 20, look again.
   - A line total of "20" when the unit price should be "90" is a common OCR error (9 misread as 2).

2. COUNT ALL ROWS — look for any row in the table that is NOT in the list above.
   - Look for rows written smaller, lighter, at an angle, or at the very edge of the table.
   - Look for items like: "SASSIN ISOLATOR", "20AMP ISOLATOR", "CIRCUIT BREAKER", "MAIN SWITCH", "DB BOARD"

3. For each row you find that is NOT in the list above, output:
   ITEM [n]: Name="[exact text as written]" | Qty=[number] | UnitPrice=[number] | LineTotal=[number]

4. For any price in the list above that you believe is WRONG, output:
   PRICE_CORRECTION: Item="[name]" | CorrectUnitPrice=[number] | CorrectLineTotal=[number] | Reason=[why]

Finally state:
TOTAL_ROWS_COUNTED: [number]
MISSING_VALUE_EXPLANATION: [your best explanation for the ${gap} gap]`;
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

// -----------------------------------------------------------------
// #14 — TIME-OF-DAY ANOMALY CHECK (v7.6 — Ghana-aware)
// Ghana salesmen work Mon–Sat. Sunday is the only rest day.
// After-hours warning removed — salesmen work late legitimately.
// Only truly suspicious times are flagged: past midnight or Sunday.
// -----------------------------------------------------------------

function checkTimeOfDayAnomaly(): string | null {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay(); // 0=Sun, 6=Sat

  // Sunday only — Saturday is a normal work day in Ghana
  if (day === 0) {
    return `This invoice was submitted on a Sunday. Confirm this is a genuine transaction — most businesses are closed on Sundays.`;
  }
  // Only flag truly suspicious late-night hours (midnight to 4am)
  if (hour >= 0 && hour < 4) {
    return `Invoice submitted at ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — unusually late at night. Verify this is not a backdated or fraudulent submission.`;
  }
  return null;
}



// -----------------------------------------------------------------
// LAYER 4 — MATH ENGINE (v6.0)
// -----------------------------------------------------------------

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

  // #9 Currency consistency check
  const headerCurrency: string = ai.header_currency ?? ai.currency ?? 'GHS';
  const currencyMismatches = mathCheck?.currency_mismatches ?? [];
  if (currencyMismatches.length > 0) {
    mathErrors.push(`Mixed currencies detected: header says ${headerCurrency} but some items show different currency symbols (${currencyMismatches.join(', ')}). Amounts may not be comparable.`);
    mathSuggestions.push(`Check each item on the physical invoice for currency symbols. All items must be in the same currency as the total (${headerCurrency}).`);
  }
  for (const item of items) {
    if (item.currency_symbol_seen && item.name) {
      const itemCurrency = String(item.currency_symbol_seen).toUpperCase();
      if (itemCurrency !== headerCurrency && itemCurrency !== 'NONE' && itemCurrency !== 'NULL') {
        mathErrors.push(`Item "${item.name}" appears to be in ${itemCurrency} but invoice header is ${headerCurrency}. This will cause a wrong total.`);
        mathSuggestions.push(`Confirm the currency for "${item.name}" with the vendor before collecting.`);
      }
    }
  }

  // #8 Quantity sanity check
  for (const item of items) {
    const qty = parseNumber(item.quantity);
    const unitPrice = parseNumber(item.unit_price);
    if (qty !== undefined) {
      if (qty <= 0) {
        mathErrors.push(`Item "${item.name || 'unknown'}" has quantity ${qty} — zero or negative quantities are impossible.`);
        mathSuggestions.push(`Check the quantity for "${item.name || 'this item'}" on the physical invoice. Zero/negative quantities are a writing error.`);
      } else if (qty > 1000 && unitPrice !== undefined && unitPrice > 0) {
        const lineValue = qty * unitPrice;
        mathNotes.push(`Item "${item.name || 'unknown'}" has unusually large quantity: ${qty} x ${unitPrice.toFixed(2)} = ${lineValue.toFixed(2)}. Verify this is correct.`);
      }
    }
  }

  // #7 Unit price consistency (same item name, different price on same invoice)
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
        mathErrors.push(`"${displayName}" appears ${prices.length} times on this invoice with different unit prices: ${unique.map((p: number) => p.toFixed(2)).join(', ')}. This is a pricing inconsistency.`);
        mathSuggestions.push(`Ask the vendor why "${displayName}" has different prices on the same invoice. There should be one consistent unit price.`);
      }
    }
  }

  // ================================================================
  // VAT / TAX BULLETPROOF ZONE — v7.4
  // RULE: Tax is ONLY used if ALL of these are true:
  //   1. At least one tax field (nhil/getfund/covid/vat/tax) is a real number > 0
  //   2. ai.vat_included_in_prices is explicitly false
  //   3. For GRA invoices: is_gra_invoice must be true AND tax rows must be present
  // If ANY condition fails -> vatIncluded = true, all tax = undefined, no tax math
  // ================================================================

  // Step 1: hard-null any tax value that is 0 or negative (AI sometimes returns 0 meaning 'not present')
  const nhilSafe      = (nhil      !== undefined && nhil      > 0) ? nhil      : undefined;
  const getfundSafe   = (getfund   !== undefined && getfund   > 0) ? getfund   : undefined;
  const covidSafe     = (covidLevy !== undefined && covidLevy > 0) ? covidLevy : undefined;
  const vatSafe       = (vat       !== undefined && vat       > 0) ? vat       : undefined;
  const aiTaxSafe     = (aiTax     !== undefined && aiTax     > 0) ? aiTax     : undefined;

  // Step 2: tax is only 'present' if at least one safe value exists
  const taxExplicitlyPresent =
    nhilSafe !== undefined || getfundSafe !== undefined ||
    covidSafe !== undefined || vatSafe !== undefined || aiTaxSafe !== undefined;

  // Step 3: if AI says vat_included=true, override any stray tax values
  const aiSaysVatIncluded = ai.vat_included_in_prices === true;

  // Step 4: final vatIncluded determination
  const vatIncluded = !taxExplicitlyPresent || aiSaysVatIncluded;

  if (vatIncluded) {
    if (!taxExplicitlyPresent) {
      mathNotes.push('No VAT/tax rows on invoice — VAT-inclusive pricing. No tax calculations applied.');
    } else {
      // AI found tax values but also said vat_included=true — trust vat_included, ignore tax values
      mathNotes.push('AI flagged vat_included_in_prices=true — ignoring any stray tax values extracted.');
    }
  }

  // Step 5: tax derivation — ONLY runs when vatIncluded is false
  let correctedTax: number | undefined = undefined;
  if (!vatIncluded && taxExplicitlyPresent) {
    const hasGraLevies = nhilSafe !== undefined || getfundSafe !== undefined || covidSafe !== undefined || vatSafe !== undefined;
    if (hasGraLevies) {
      const computedTax = safeSum(nhilSafe, getfundSafe, covidSafe, vatSafe);
      if (aiTaxSafe === undefined) {
        correctedTax = computedTax;
        mathNotes.push(`Tax derived from GRA levies: NHIL(${nhilSafe ?? 0}) + GETFund(${getfundSafe ?? 0}) + COVID(${covidSafe ?? 0}) + VAT(${vatSafe ?? 0}) = ${computedTax}`);
      } else if (Math.abs(computedTax - aiTaxSafe) > 0.05) {
        correctedTax = computedTax;
        mathOverride = true;
        mathNotes.push(`Tax corrected from GRA levies: ${aiTaxSafe} -> ${computedTax}`);
      } else {
        correctedTax = aiTaxSafe;
      }
    } else {
      // Only aiTax present (no breakdown) — use it directly
      correctedTax = aiTaxSafe;
    }

    // Step 6: GRA levy rate verification (ONLY for confirmed GRA invoices with levies)
    if (ai.is_gra_invoice === true && subtotal && subtotal > 0 && hasGraLevies) {
      const expectedNhil    = Math.round(subtotal * 0.025 * 100) / 100;
      const expectedGetfund = Math.round(subtotal * 0.025 * 100) / 100;
      const expectedCovid   = Math.round(subtotal * 0.010 * 100) / 100;
      const levyBase        = safeSum(subtotal, nhilSafe ?? expectedNhil, getfundSafe ?? expectedGetfund, covidSafe ?? expectedCovid);
      const expectedVat     = Math.round(levyBase * 0.15 * 100) / 100;

      if (nhilSafe !== undefined && Math.abs(nhilSafe - expectedNhil) > 0.15)
        mathErrors.push(`NHIL error: shows ${nhilSafe.toFixed(2)}, expected ${expectedNhil.toFixed(2)} (2.5% of ${subtotal.toFixed(2)}). -> Ask vendor to correct NHIL.`);
      if (getfundSafe !== undefined && Math.abs(getfundSafe - expectedGetfund) > 0.15)
        mathErrors.push(`GETFund error: shows ${getfundSafe.toFixed(2)}, expected ${expectedGetfund.toFixed(2)}. -> Ask vendor to correct GETFund.`);
      if (covidSafe !== undefined && Math.abs(covidSafe - expectedCovid) > 0.15)
        mathErrors.push(`COVID-19 Levy error: shows ${covidSafe.toFixed(2)}, expected ${expectedCovid.toFixed(2)}. -> Ask vendor to correct COVID Levy.`);
      if (vatSafe !== undefined && Math.abs(vatSafe - expectedVat) > 1.50)
        mathErrors.push(`VAT error: shows ${vatSafe.toFixed(2)}, expected ${expectedVat.toFixed(2)} (15% of levy base ${levyBase.toFixed(2)}). -> Ask vendor to correct VAT.`);

      runningTotalChain.push(`Subtotal (pre-tax): ${subtotal.toFixed(2)}`);
      if (nhilSafe !== undefined) runningTotalChain.push(`+ NHIL 2.5%: ${nhilSafe.toFixed(2)}`);
      if (getfundSafe !== undefined) runningTotalChain.push(`+ GETFund 2.5%: ${getfundSafe.toFixed(2)}`);
      if (covidSafe !== undefined) runningTotalChain.push(`+ COVID-19 Levy 1%: ${covidSafe.toFixed(2)}`);
      if (vatSafe !== undefined) runningTotalChain.push(`+ VAT 15%: ${vatSafe.toFixed(2)}`);
      if (aiTotal !== undefined) runningTotalChain.push(`= Grand Total: ${aiTotal.toFixed(2)}`);
    } else if (subtotal !== undefined && correctedTax !== undefined) {
      runningTotalChain.push(`Subtotal: ${subtotal.toFixed(2)}`);
      runningTotalChain.push(`+ Tax: ${correctedTax.toFixed(2)}`);
      if (aiTotal !== undefined) runningTotalChain.push(`= Total: ${aiTotal.toFixed(2)}`);
    }
  }

  // #10 Items sum chain (VAT-inclusive)
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

  // #6 Full column cross-check
  let itemsSum = 0;
  let hasAnyLineTotal = false;
  for (const item of items) {
    const lt = parseNumber(item.line_total);
    if (lt !== undefined) { itemsSum += lt; hasAnyLineTotal = true; }
  }
  itemsSum = Math.round(itemsSum * 100) / 100;

  if (hasAnyLineTotal && subtotal !== undefined && Math.abs(itemsSum - subtotal) > 0.10) {
    if (itemsSum > subtotal * 1.5) {
      // OCR hallucinated extra rows — items sum way exceeds subtotal
      mathNotes.push(`Items sum (${itemsSum.toFixed(2)}) far exceeds subtotal (${subtotal.toFixed(2)}) — OCR likely read a note/total as a line item. Subtotal used as-is.`);
    } else {
      mathErrors.push(`Column sum error: all line totals add to ${itemsSum.toFixed(2)} but stated subtotal is ${subtotal.toFixed(2)} (gap: ${Math.abs(itemsSum - subtotal).toFixed(2)}). One or more line items may be missing or misread.`);
      mathSuggestions.push(`The items sum (${itemsSum.toFixed(2)}) does not match the subtotal (${subtotal.toFixed(2)}). Count the rows on the physical invoice — a high-value item may have been missed. Correct and rescan.`);
    }
  }
  if (hasAnyLineTotal && vatIncluded && aiTotal !== undefined && subtotal === undefined && Math.abs(itemsSum - aiTotal) > 0.10) {
    const gap = Math.abs(itemsSum - aiTotal);
    if (gap / aiTotal > 0.01) {
      if (itemsSum > aiTotal * 1.5) {
        // Items sum is WAY more than total — AI hallucinated extra rows (e.g. read "Not Paid 2034" as a line item)
        // Do NOT flag as a math error — flag as an OCR note only
        mathNotes.push(`Items sum (${itemsSum.toFixed(2)}) exceeds grand total (${aiTotal.toFixed(2)}) — likely OCR hallucinated extra rows. Grand total used as-is.`);
      } else if (itemsSum < aiTotal) {
        // Items sum is LESS than total — possible missing line items
        mathErrors.push(`Column sum error: all line totals add to ${itemsSum.toFixed(2)} but grand total is ${aiTotal.toFixed(2)} (gap: ${gap.toFixed(2)}).`);
        mathSuggestions.push(`The items sum (${itemsSum.toFixed(2)}) does not match the grand total (${aiTotal.toFixed(2)}). One or more line totals may be wrong.`);
      }
      // If items > total but < 1.5x — flag normally
      else {
        mathErrors.push(`Column sum error: all line totals add to ${itemsSum.toFixed(2)} but grand total is ${aiTotal.toFixed(2)} (gap: ${gap.toFixed(2)}).`);
        mathSuggestions.push(`The items sum (${itemsSum.toFixed(2)}) does not match the grand total (${aiTotal.toFixed(2)}). One or more line totals may be wrong.`);
      }
    }
  }

  // Total derivation
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

// -----------------------------------------------------------------
// LAYER 5 — HALLUCINATION GUARD
// -----------------------------------------------------------------

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
    const dateStr = String(ai.date);
    // Try to parse year robustly — handle YYYY-MM-DD and DD-MM-YYYY and DD-MM-YY
    let year: number | null = null;
    const isoMatch = dateStr.match(/^(\d{4})-\d{2}-\d{2}$/);
    const ghanaMatch = dateStr.match(/^\d{2}-\d{2}-(\d{2,4})$/);
    if (isoMatch) {
      year = parseInt(isoMatch[1]);
    } else if (ghanaMatch) {
      const y = parseInt(ghanaMatch[1]);
      year = y < 100 ? 2000 + y : y;
    }
    if (year !== null && (year < 2010 || year > 2030)) {
      flags.push(`Invoice date year "${year}" is implausible — likely a misread.`);
      suggestions.push(`Check the physical invoice for the correct date.`);
    }
  }
  if (ai.total_confidence === 'low' && math.correctedTotal === undefined) {
    flags.push(`Grand total extracted with LOW confidence and cannot be independently verified.`);
    suggestions.push(`Do not collect money until you have manually confirmed the total on the physical invoice.`);
  }

  if (ai.total_uncertain_digits) {
    flags.push(`Grand total has uncertain digits: "${ai.total_uncertain_digits}". The exact amount may be wrong.`);
    suggestions.push(`Look at the grand total on the physical invoice and read each digit carefully. Correct it in the edit panel.`);
  }
  for (const item of items) {
    // Only flag uncertain digits if the value actually contains '?' — not just a confidence note
    if (item.uncertain_digits && item.name && String(item.uncertain_digits).includes('?')) {
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

// -----------------------------------------------------------------
// PROTOCOL 9 — RISK VERDICT
// -----------------------------------------------------------------

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
    details.push('-> Fix: Inform vendor this invoice was already processed. Request a new invoice number for a new transaction.');
  } else if (isPartialPayment && partialOrigTotal !== undefined) {
    verdict = 'CAUTION';
    reason = `Partial payment detected. Original total was ${partialOrigTotal.toFixed(2)}, this shows ${total?.toFixed(2) ?? '?'}.`;
    moneyAtRisk = partialOrigTotal - (total ?? 0);
    details.push(`Expected ${partialOrigTotal.toFixed(2)}, this shows ${total?.toFixed(2) ?? '?'}.`);
    details.push(`-> Fix: Look carefully at both invoices and confirm the correct amount before collecting.`);
  } else if (hasHallucination && total === undefined) {
    verdict = 'ESCALATE';
    reason = `Invoice total could not be read reliably. Do NOT collect until you have confirmed the amount on the physical invoice.`;
    moneyAtRisk = 0;
    for (let i = 0; i < hallucinationFlags.length; i++) {
      details.push(`Problem: ${hallucinationFlags[i]}`);
      if (hallucinationSuggestions[i]) details.push(`-> Fix: ${hallucinationSuggestions[i]}`);
    }
  } else if (hasCriticalMathError) {
    verdict = 'ESCALATE';
    reason = `Numbers on this invoice do not add up. Check every line carefully and rewrite the correct invoice before accepting payment.`;
    moneyAtRisk = total ?? 0;
    for (let i = 0; i < mathErrors.length; i++) {
      details.push(`Problem: ${mathErrors[i]}`);
      if (mathSuggestions[i]) details.push(`-> Fix: ${mathSuggestions[i]}`);
    }
  } else if (priceWarnings.length > 0 || vendorRangeWarning) {
    const bigSpike = priceWarnings.some(w => { const m = w.match(/(\d+)%/); return m && parseInt(m[1]) > 50; }) ||
      (vendorRangeWarning?.includes('3x') ?? false);
    verdict = bigSpike ? 'ESCALATE' : 'CAUTION';
    reason = bigSpike
      ? `Prices are unusually high for this vendor. Look carefully at every item and confirm with the vendor before accepting payment.`
      : `Some prices are higher than expected for this vendor. Review before collecting.`;
    moneyAtRisk = total ?? 0;
    for (const w of priceWarnings) {
      details.push(`Problem: ${w}`);
      details.push(`-> Fix: Request vendor's updated price list and compare before collecting.`);
    }
    if (vendorRangeWarning) {
      details.push(`Problem: ${vendorRangeWarning}`);
      details.push(`-> Fix: Compare this invoice total against your records for this vendor before collecting.`);
    }
  } else if (invNumberGapWarning) {
    verdict = 'CAUTION';
    reason = `Invoice number sequence looks unusual for this vendor.`;
    moneyAtRisk = total ?? 0;
    details.push(`Problem: ${invNumberGapWarning}`);
    details.push(`-> Fix: Ask the vendor to confirm this invoice number is correct. Large gaps can indicate backdating.`);
  } else if (errors.some(e => e.field === 'total')) {
    verdict = 'CAUTION';
    reason = `Grand total has an issue. Verify the amount before collecting.`;
    moneyAtRisk = total ?? 0;
    for (const e of errors.filter(e => e.field === 'total')) {
      const parts = e.message.split(' -> ');
      details.push(`Problem: ${parts[0]}`);
      if (parts[1]) details.push(`-> Fix: ${parts[1]}`);
    }
  } else if (errors.some(e => ['invoice_number', 'customer_name', 'date'].includes(e.field))) {
    verdict = 'CAUTION';
    const missing = errors.filter(e => ['invoice_number', 'customer_name', 'date'].includes(e.field)).map(e => e.field.replace('_', ' ')).join(', ');
    reason = `Invoice missing key information: ${missing}.`;
    moneyAtRisk = 0;
    for (const e of errors.filter(e => ['invoice_number', 'customer_name', 'date'].includes(e.field))) {
      const parts = e.message.split(' -> ');
      details.push(`Problem: ${parts[0]}`);
      if (parts[1]) details.push(`-> Fix: ${parts[1]}`);
    }
  } else if (errors.length === 0 && hallucinationFlags.length === 0 && mathErrors.length === 0) {
    verdict = 'ACCEPT';
    if (reconciliationApplied) {
      reason = `Invoice verified after extra re-check. Total ${total?.toFixed(2) ?? '?'} confirmed. Safe to collect.`;
    } else if (mathOverride) {
      verdict = 'CAUTION';
      reason = `Invoice total was auto-corrected arithmetically to ${total?.toFixed(2) ?? '?'}. Verify against the physical invoice before collecting.`;
      details.push(`-> Fix: Confirm the total on the physical invoice matches ${total?.toFixed(2) ?? '?'}.`);
    } else {
      const vatNote = vatIncluded ? ' (VAT-inclusive pricing)' : '';
      reason = `All checks passed. Invoice total is ${total?.toFixed(2) ?? '?'}${vatNote}. Safe to collect.`;
    }
  } else {
    verdict = 'CAUTION';
    reason = `Invoice has issues — review flagged fields before collecting.`;
    moneyAtRisk = 0;
    for (const e of errors) {
      const parts = e.message.split(' -> ');
      details.push(`Problem: ${parts[0]}`);
      if (parts[1]) details.push(`-> Fix: ${parts[1]}`);
    }
  }

  for (let i = 0; i < hallucinationFlags.length; i++) {
    if (!details.some(d => d.includes(hallucinationFlags[i].slice(0, 30)))) {
      details.push(`Problem: ${hallucinationFlags[i]}`);
      if (hallucinationSuggestions[i]) details.push(`-> Fix: ${hallucinationSuggestions[i]}`);
    }
  }

  // #10 — Only show time warning if it's genuinely suspicious (Sunday or midnight)
  // After-8pm warnings were removed in v7.6 — Ghana salesmen work late legitimately.
  // Only Sunday or midnight-to-4am warnings are appended.
  if (timeOfDayWarning && (
    timeOfDayWarning.includes('Sunday') ||
    timeOfDayWarning.includes('late at night')
  )) {
    details.push(`Note: ${timeOfDayWarning}`);
  }

  if (runningTotalChain.length > 0) {
    details.push(`Calculation breakdown: ${runningTotalChain.join(' -> ')}`);
  }

  return { verdict, reason, details, moneyAtRisk };
}

// -----------------------------------------------------------------
// JSON PARSE HELPER
// -----------------------------------------------------------------

function parseGroqJson(raw: string): any {
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); }
  catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) { try { return JSON.parse(match[0]); } catch { /* fall through */ } }
    throw new Error(`Could not parse JSON from model response. Raw: ${cleaned.slice(0, 400)}`);
  }
}

// -----------------------------------------------------------------
// v7.7 — POST-OCR ITEM NAME CORRECTION
// Fixes common OCR garbles without touching numbers.
// Sorted by frequency of occurrence on real Ghana invoices.
// -----------------------------------------------------------------

function correctItemName(name: string): string {
  if (!name) return name;
  let n = name.trim();

  // Common OCR letter substitutions at start of item names
  const prefixFixes: [RegExp, string][] = [
    // B/G -> 1 at start (BAMP -> 13AMP, GAMP -> 13AMP)
    [/^BAMP\b/i,          '13AMP'],
    [/^GAMP\b/i,          '13AMP'],
    [/^BGANG/i,           '2GANG'],
    [/^GGANG/i,           '2GANG'],
    [/^BWAY\b/i,          '2WAY'],
    [/^GWAY\b/i,          '2WAY'],
    [/^BPIN\b/i,          '3PIN'],
    [/^GPIN\b/i,          '3PIN'],
    [/^BCORE\b/i,         '3CORE'],
    [/^GCORE\b/i,         '3CORE'],
  ];
  for (const [rx, fix] of prefixFixes) {
    if (rx.test(n)) { n = n.replace(rx, fix); break; }
  }

  // Whole-word OCR garbles — common Ghana electrical/hardware items
  const wordFixes: [RegExp, string][] = [
    [/\bSASSIN\b/gi,              'SASSIN DB'],
    [/\bGKWAY\b/gi,              '2GANG 2WAY'],
    [/\bBGANG\b/gi,              '2GANG'],
    [/\bBSOCKET\b/gi,            '13AMP SOCKET'],
    [/\bGSOCKET\b/gi,            '13AMP SOCKET'],
    [/\bDBOARD\b/gi,             'DB BOARD'],
    [/\bD\.BOARD\b/gi,           'DB BOARD'],
    [/\bCIRCUIT\s*BR[EA]+KER\b/gi, 'CIRCUIT BREAKER'],
    [/\bCB\s*\d+A/gi,            (m: string) => m.replace(/^CB\s*/i, '').trim() + ' CIRCUIT BREAKER'],
    [/\bFLEX\s*CABLE\b/gi,       'FLEX CABLE'],
    [/\bFL[EX]+\s*CORD\b/gi,     'FLEX CORD'],
    [/\bTRUNKING\b/gi,           'CABLE TRUNKING'],
    [/\bROSETTE\b/gi,            'CEILING ROSE'],
    [/\bISO[LI]+ATOR\b/gi,       'ISOLATOR'],
    [/\bCONDU[I]+T\b/gi,        'CONDUIT'],
    [/\bARMOUR[ED]*\s*CABLE\b/gi,'ARMOURED CABLE'],
    // Grocery OCR garbles
    [/\bMlLO\b/gi,               'MILO'],
    [/\bMIL0\b/gi,               'MILO'],
    [/\bNESCAFE\b/gi,            'NESCAFE'],
    [/\bMAGGI[E]*\b/gi,          'MAGGI'],
    [/\bCARNATI0N\b/gi,          'CARNATION'],
    [/\bCARNACTION\b/gi,         'CARNATION'],
    [/\bKOSMOS\b/gi,             'KOSMOS'],
    [/\bTOM[A]+TO\s*PU[R]+EE\b/gi, 'TOMATO PUREE'],
    [/\bTOM[A]+TO\s*P[A]+STE\b/gi, 'TOMATO PASTE'],
    [/\bSARDINE[S]*\b/gi,        'SARDINES'],
    [/\bMACKER[EL]+\b/gi,        'MACKEREL'],
    [/\bVEG[E]*\s*OIL\b/gi,     'VEGETABLE OIL'],
    [/\bP[AO]LM\s*OIL\b/gi,     'PALM OIL'],
    [/\bB[AO]SMATI\b/gi,        'BASMATI RICE'],
    // Building materials
    [/\bCEM[E]*NT\b/gi,          'CEMENT'],
    [/\bP\.?C[E]*M[E]*NT\b/gi,  'PORTLAND CEMENT'],
    [/\bPLYW[O0]+D\b/gi,        'PLYWOOD'],
    [/\bALUZINC\b/gi,            'ALUZINC ROOFING SHEET'],
    [/\bG[\.]?I[\.]?\s*SHEET\b/gi, 'GI SHEET'],
    [/\bPAINT\s*EM[UL]+\b/gi,   'EMULSION PAINT'],
    [/\bBLOCK[S]*\s*(6|9)\b/gi, (m: string) => m.replace(/BLOCK[S]*/i, 'BLOCK').toUpperCase()],
  ];
  for (const [rx, fix] of wordFixes) {
    if (typeof fix === 'string') {
      n = n.replace(rx, fix);
    } else {
      n = n.replace(rx, fix as any);
    }
  }

  // Clean up extra spaces
  return n.replace(/\s+/g, ' ').trim();
}

// -----------------------------------------------------------------
// MAIN SERVER ACTION
// -----------------------------------------------------------------

export async function processInvoice(
  imageBase64: string,
  taxRatePct: number = 15,
  invoiceHistory: SlimInvoiceResult[] = []
): Promise<InvoiceProcessingResult> {
  try {
    // v7.7: groqApiKey is optional — OpenRouter/Gemini are primary vision providers
    const groqApiKey = process.env.GROQ_API_KEY ?? null;
    if (!groqApiKey && !process.env.OPENROUTER_API_KEY && !process.env.GEMINI_API_KEY) {
      throw new Error('No API key configured. Set OPENROUTER_API_KEY, GEMINI_API_KEY, or GROQ_API_KEY in .env.local');
    }
    const matches = imageBase64.match(/^data:(.+);base64,(.+)$/);
    if (!matches) throw new Error('Invalid image format. Expected a base64 data URI.');

    const imageUrl = await ensureImageUnderLimit(imageBase64);
    console.log(`[Invoice] Image size: ${Math.round((imageUrl.split(',')[1]?.length ?? 0) / 1024)}KB base64`);

    // Document type guard — v7.6: uses getVisionCaller (OpenRouter first)
    console.log('[Invoice] Document guard: checking image is a financial document...');
    const guard = await guardDocumentType(imageUrl);
    if (!guard.ok) {
      throw new Error(
        `This doesn't look like an invoice or receipt — it appears to be a ${guard.detectedAs}. ` +
        `Please scan or upload an actual invoice, receipt, or payment document.`
      );
    }
    console.log(`[Invoice] Document guard passed: ${guard.detectedAs}`);

    // Pass 1: Universal OCR
    console.log('[Invoice] Pass 1: universal OCR...');
    const transcription = await getVisionCaller(imageUrl, PASS1_PROMPT);
    console.log('[Invoice] Pass 1 done, length:', transcription.length);

    // Math pre-check + Pass 2 in parallel
    console.log('[Invoice] Math pre-check + Pass 2 in parallel...');
    let mathCheck: any = null;
    let rawJson = '';

    const [mathCheckResult, pass2Result] = await Promise.allSettled([
      callText(buildMathPreCheckPrompt(transcription), 1500),
      callText(buildPass2Prompt(transcription, null), 8000)
        .catch(() => getVisionCaller(imageUrl, buildPass2Prompt(transcription, null))),
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

    // v7.7 — #6 Post-OCR item name correction
    // Fixes common OCR garbles on Ghana handwritten invoices without touching numbers
    if (ai.items && Array.isArray(ai.items)) {
      ai = { ...ai, items: ai.items.map((item: any) => ({
        ...item,
        name: item.name ? correctItemName(item.name) : item.name,
      }))};
    }

    let math = runMathEngine(ai, mathCheck);
    let hallucinationReport = runHallucinationGuard(ai, math);

    // Region re-read for low confidence fields
    const lowConfidenceFields: string[] = [];
    if (ai.total_confidence === 'low') lowConfidenceFields.push('grand total / amount due');
    if (ai.invoice_number_confidence === 'low') lowConfidenceFields.push('invoice number');
    if (ai.date_confidence === 'low') lowConfidenceFields.push('invoice date');
    if (ai.subtotal_confidence === 'low') lowConfidenceFields.push('subtotal');
    if (ai.customer_name_confidence === 'low') lowConfidenceFields.push('vendor/seller name');

    let regionRereadApplied = false;
    if (lowConfidenceFields.length > 0) {
      console.log(`[Invoice] Region re-read for: ${lowConfidenceFields.join(', ')}`);
      try {
        const headerFields = lowConfidenceFields.filter(f => ['invoice number', 'invoice date', 'vendor/seller name'].some(x => f.includes(x)));
        const totalsFields = lowConfidenceFields.filter(f => ['grand total', 'subtotal', 'amount due'].some(x => f.includes(x)));

        if (totalsFields.length > 0) {
          const rereadText = await getVisionCaller(imageUrl, buildRegionRereadPrompt('totals', totalsFields));
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
              console.log(`[Invoice] Region re-read: total -> ${rereTotal} (${rereConf})`);
            }
          }
        }

        if (headerFields.length > 0 && !regionRereadApplied) {
          const rereadText = await getVisionCaller(imageUrl, buildRegionRereadPrompt('header', headerFields));
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

    // Pass 1c: Vision-based items re-extraction when items sum is >8% below subtotal/total.
    // Sends the IMAGE back to the vision model with a focused prompt — no text-only fallback.
    let missingItemsRereadApplied = false;
    if (!regionRereadApplied) {
      const aiItems: any[] = ai.items ?? [];
      const aiItemsSum = Math.round(aiItems.reduce((s: number, i: any) => {
        const lt = parseNumber(i.line_total);
        return s + (lt ?? 0);
      }, 0) * 100) / 100;
      const statedRef = parseNumber(ai.subtotal) ?? parseNumber(ai.total);
      if (
        statedRef !== undefined &&
        statedRef > 0 &&
        aiItemsSum > 0 &&
        (statedRef - aiItemsSum) / statedRef > 0.08
      ) {
        const gap = (statedRef - aiItemsSum).toFixed(2);
        console.log(`[Invoice] Pass 1c: gap ${gap} (items ${aiItemsSum} vs stated ${statedRef}). Re-reading image for missing items.`);
        try {
          const knownItemLines = aiItems.map((i: any, idx: number) => {
            const lt = parseNumber(i.line_total);
            return `  ${idx + 1}. "${i.name || 'unknown'}" qty=${i.quantity ?? '?'} unitPrice=${i.unit_price ?? '?'} lineTotal=${lt?.toFixed(2) ?? '?'}`;
          }).join('\n');

          const pass1cPrompt = `FOCUSED ITEMS RE-READ

I already read this invoice and found these items (total = ${aiItemsSum.toFixed(2)}):
${knownItemLines}

But the invoice grand total is ${statedRef.toFixed(2)} — there is a gap of ${gap}.
Either I missed a row OR I misread a price.

Look at the items table in the image and output ALL rows as JSON, replacing my previous list entirely.

CRITICAL RULES:
- Output EVERY row in the table, EXACTLY ONCE. Do not skip any.
- READ THE QTY COLUMN FIRST for every row. Common quantities are 1, 2, 3, 5, 9, 10. A large line total with a small unit price means a large quantity.
- NPC PREFIX: If the description starts with "5PC", "2PC", "9PC" etc., that number IS the quantity. "5PC 2Gang Switch" means qty=5.
- For "SASSIN" or "6WAY 1PHASE SASSIN": the unit price is 90 GHS. Never 80. If you see 80, it is a misread 9 → 8 error.
- ARITHMETIC CHECK: after reading each row, verify qty × unit_price = line_total. If it does not match, first check for NPC prefix in the description, then reread the quantity.
- Do NOT invent rows. Only include rows physically present in the image.
- Use null for any value you cannot read.

Respond ONLY with a JSON array — no markdown, no explanation:
[
  { "name": "string", "quantity": number_or_null, "unit_price": number_or_null, "line_total": number_or_null },
  ...
]`;

          const rereadRaw = await getVisionCaller(imageUrl, pass1cPrompt);
          console.log('[Invoice] Pass 1c raw response:', rereadRaw.slice(0, 400));

          // Parse the JSON array
          const cleaned = rereadRaw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
          const arrMatch = cleaned.match(/\[[\s\S]*\]/);
          if (arrMatch) {
            let reItems: any[] = JSON.parse(arrMatch[0]);
            reItems = reItems.filter((i: any) => i.name || i.line_total);
            const reItemsSum = Math.round(reItems.reduce((s: number, i: any) => s + (parseNumber(i.line_total) ?? 0), 0) * 100) / 100;
            console.log(`[Invoice] Pass 1c parsed: ${reItems.length} items, sum=${reItemsSum}`);

            const oldGap = Math.abs(statedRef - aiItemsSum);
            const newGap = Math.abs(statedRef - reItemsSum);
            // Accept if: new gap is smaller AND we have at least as many items
            if (newGap < oldGap && reItems.length >= aiItems.length) {
              ai = { ...ai, items: reItems };
              math = runMathEngine(ai, mathCheck);
              hallucinationReport = runHallucinationGuard(ai, math);
              missingItemsRereadApplied = true;
              console.log(`[Invoice] Pass 1c accepted: gap ${oldGap.toFixed(2)} -> ${newGap.toFixed(2)}, items ${aiItems.length} -> ${reItems.length}`);
            } else {
              console.log(`[Invoice] Pass 1c rejected: newGap=${newGap.toFixed(2)} oldGap=${oldGap.toFixed(2)} newCount=${reItems.length} oldCount=${aiItems.length}`);
            }
          }
        } catch (e) { console.warn('[Invoice] Pass 1c failed (non-fatal):', e); }
      }
    }

    // Protocol 8: Reconciliation re-query
    let reconciliationApplied = false;
    const hasItems = (ai.items ?? []).length > 0;
    if (hallucinationReport.totalUncertain && hasItems && !regionRereadApplied) {
      console.log('[Invoice] Protocol 8: reconciliation re-query...');
      try {
        const reconText = await getVisionCaller(imageUrl, RECONCILIATION_PROMPT);
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
            console.log(`[Invoice] Reconciliation: total -> ${reconTotal} (${reconConf})`);
          }
        }
      } catch (e) { console.warn('[Invoice] Protocol 8 failed (non-fatal):', e); }
    }

    // Build validated data
    const validatedData: ValidatedData = {
      invoice_number: ai.invoice_number || undefined,
      date:           ai.date || undefined,
      customer_name:  ai.customer_name || undefined,
      category:       ai.category || undefined,
      subtotal:       math.correctedSubtotal,
      // TAX BULLETPROOF: only include tax if vatIncluded=false AND correctedTax is a real positive number
      tax: (!math.vatIncluded && math.correctedTax !== undefined && math.correctedTax > 0) ? math.correctedTax : undefined,
      total:          math.correctedTotal ?? parseNumber(ai.total),
      items: (ai.items ?? []).map((item: any) => ({
        name:       item.name || undefined,
        quantity:   parseNumber(item.quantity) ?? item.quantity,
        unit_price: parseNumber(item.unit_price),
        line_total: parseNumber(item.line_total),
      })),
    };

    // Validation errors
    const errors: ValidationError[] = [];

    if (!validatedData.invoice_number)
      errors.push({ field: 'invoice_number', message: 'Invoice number missing. -> Add an invoice number before submitting.' });
    if (!validatedData.customer_name)
      errors.push({ field: 'customer_name', message: 'Customer name missing. -> Write the customer name on the invoice before submitting.' });
    if (validatedData.total === undefined)
      errors.push({ field: 'total', message: 'Grand total missing — cannot verify the amount to collect. -> Check the bottom of the physical invoice and enter the total manually.' });
    if (!validatedData.items || validatedData.items.length === 0)
      errors.push({ field: 'items', message: 'No line items found. -> Retake the photo ensuring the items table is fully visible, or request an itemised invoice from the vendor.' });
    if (ai.total_confidence === 'low' && !reconciliationApplied && !regionRereadApplied)
      errors.push({ field: 'total', message: `Grand total was difficult to read (low confidence: ${validatedData.total?.toFixed(2) ?? 'unknown'}). -> Manually confirm this amount on the physical invoice before collecting.` });
    if (ai.customer_name_confidence === 'low')
      errors.push({ field: 'customer_name', message: `Vendor name was partially readable: "${validatedData.customer_name}". -> Confirm with the vendor and correct in the edit panel if wrong.` });

    for (let i = 0; i < hallucinationReport.flags.length; i++) {
      const suggestion = hallucinationReport.suggestions[i] ? ` -> ${hallucinationReport.suggestions[i]}` : '';
      errors.push({ field: 'hallucination', message: `${hallucinationReport.flags[i]}${suggestion}` });
    }
    for (let i = 0; i < math.mathErrors.length; i++) {
      const suggestion = math.mathSuggestions[i] ? ` -> ${math.mathSuggestions[i]}` : '';
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
            // Skip if the gap exactly equals the unit price — likely a qty misread (1 vs 2)
            // In this case the line total is probably correct and the qty is wrong
            const gapEqualsUnitPrice = Math.abs(Math.abs(expected - lineTotal) - unitPrice) < 0.11;
            if (!gapEqualsUnitPrice) {
              errors.push({
                field: `items[${i}].line_total`,
                message: `"${item.name || 'Item'}" row error: ${qty} x ${unitPrice.toFixed(2)} = ${expected.toFixed(2)}, but invoice shows ${lineTotal.toFixed(2)} (gap: ${Math.abs(lineTotal - expected).toFixed(2)}). -> Ask vendor to correct this line or reissue the invoice.`
              });
            }
          }
        }
      }
    }
    itemsSum = Math.round(itemsSum * 100) / 100;

    if (validatedData.subtotal !== undefined && itemsSum > 0 && Math.abs(itemsSum - validatedData.subtotal) > 0.10) {
      errors.push({
        field: 'subtotal',
        message: `Items sum to ${itemsSum.toFixed(2)} but subtotal shows ${validatedData.subtotal.toFixed(2)}. -> Return invoice to vendor for correction before collecting money.`
      });
    }

    if (!math.vatIncluded && validatedData.subtotal !== undefined && validatedData.tax !== undefined && validatedData.total !== undefined) {
      const expectedTotal = safeSum(validatedData.subtotal, validatedData.tax);
      if (Math.abs(expectedTotal - validatedData.total) / Math.max(validatedData.total, 1) * 100 > 1) {
        errors.push({
          field: 'total',
          message: `Total mismatch: ${validatedData.subtotal.toFixed(2)} + tax ${validatedData.tax.toFixed(2)} = ${expectedTotal.toFixed(2)}, but invoice shows ${validatedData.total.toFixed(2)}. -> Do not collect until vendor corrects and reissues.`
        });
      }
    }

    // Tax rate sanity — ONLY fires when: not VAT-inclusive, not GRA, tax explicitly present and positive
    if (
      !math.vatIncluded &&
      ai.is_gra_invoice !== true &&
      validatedData.subtotal !== undefined && validatedData.subtotal > 0 &&
      validatedData.tax !== undefined && validatedData.tax > 0
    ) {
      const impliedRate = Math.round((validatedData.tax / validatedData.subtotal) * 10000) / 100;
      // Only flag if rate is wildly wrong (>15% off expected) AND rate is not trivially small
      if (impliedRate > 1 && Math.abs(impliedRate - taxRatePct) > 15) {
        errors.push({
          field: 'tax',
          message: `Unusual tax rate: ${impliedRate}% (expected ~${taxRatePct}%). -> Check the tax amount on the physical invoice before submitting.`
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

    // Protocol 6: Price memory
    let priceWarnings: string[] = [];
    const priceWarningsAt = new Date().toISOString();
    if (invoiceHistory.length > 0) {
      const vendorProfiles = buildVendorProfiles(invoiceHistory as InvoiceProcessingResult[]);
      const vendorKey = normaliseVendorKey(validatedData.customer_name);
      const tempResult = { id: '__temp__', validatedData, errors: [], isValid: true, ocrText: '', status: 'verified' as const, createdAt: new Date().toISOString() } as InvoiceProcessingResult;
      priceWarnings = checkPriceMemory(tempResult, vendorProfiles[vendorKey]);
      for (const w of priceWarnings) errors.push({ field: 'price_memory', message: w });
    }

    // #11 Vendor total range check
    let vendorRangeWarning: string | undefined;
    let vendorHistory: InvoiceProcessingResult[] = [];
    if (invoiceHistory.length > 0 && validatedData.total !== undefined) {
      vendorHistory = (invoiceHistory as InvoiceProcessingResult[]).filter(
        h => normaliseVendorKey(h.validatedData.customer_name) === normaliseVendorKey(validatedData.customer_name)
      );
      vendorRangeWarning = checkVendorTotalRange(validatedData.total, vendorHistory, validatedData.customer_name) ?? undefined;
      if (vendorRangeWarning) errors.push({ field: 'vendor_range', message: vendorRangeWarning });
    }

    // #I04 Vendor fuzzy name match
    if (invoiceHistory.length > 0) {
      const fuzzyWarning = checkVendorNameFuzzyMatch(validatedData.customer_name, invoiceHistory as InvoiceProcessingResult[]);
      if (fuzzyWarning) errors.push({ field: 'vendor_fuzzy', message: fuzzyWarning });
    }

    // #I11 Cumulative vendor spend
    if (vendorHistory.length > 0) {
      const cumulativeWarning = checkCumulativeVendorSpend(vendorHistory, validatedData.total, validatedData.customer_name);
      if (cumulativeWarning) errors.push({ field: 'cumulative_spend', message: cumulativeWarning });
    }

    // Protocol 7: Duplicate + partial payment
    let isDuplicate = false, duplicateOfId: string | undefined;
    let crossCustomerDuplicate = false;
    let isPartialPayment = false, partialPaymentOriginalTotal: number | undefined, partialPaymentOriginalId: string | undefined;
    let isRecurring = false, recurringDelta: number | undefined;
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
      crossCustomerDuplicate = dupResult.crossCustomer ?? false;

      if (isDuplicate) {
        errors.push({ field: 'duplicate', message: `DUPLICATE INVOICE: Already recorded${duplicateOfId ? ` (ID: ${duplicateOfId})` : ''}. -> Do NOT collect again. Inform vendor this invoice was already processed.` });
      } else {
        const partialResult = detectPartialPayment(tempForDetection, invoiceHistory as InvoiceProcessingResult[]);
        isPartialPayment = partialResult.isPartial;
        partialPaymentOriginalTotal = partialResult.originalTotal;
        partialPaymentOriginalId = partialResult.originalId;
        if (isPartialPayment && partialPaymentOriginalTotal !== undefined) {
          errors.push({ field: 'partial_payment', message: `PARTIAL PAYMENT: Original total was ${partialPaymentOriginalTotal.toFixed(2)}, this shows ${validatedData.total?.toFixed(2) ?? '?'}. -> Go confirm figures are Correct before Giving invoice Out.` });
        }

        const vendorProfiles = buildVendorProfiles(invoiceHistory as InvoiceProcessingResult[]);
        const recurringResult = detectRecurring(tempForDetection, vendorProfiles[normaliseVendorKey(validatedData.customer_name)]);
        isRecurring = recurringResult.isRecurring;
        recurringDelta = recurringResult.recurringDelta;

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

    // Risk verdict
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

    // Build final result
    const isValid = errors.length === 0;
    const ocrText =
      `[InvoiceGuard v7.6 | ${ai.currency ?? 'GHS'} | ${ai.document_type_observed ?? (ai.is_gra_invoice ? 'GRA Invoice' : 'Invoice')} | ${ai.writing_type ?? 'unknown'} | ${math.vatIncluded ? 'VAT-inclusive pricing' : 'Tax rows present'}]\n\n` +
      `PASS 1 OCR:\n${transcription}\n\n` +
      (mathCheck ? `Math Pre-Check: items_sum=${mathCheck.items_sum ?? 'N/A'} subtotal=${mathCheck.subtotal_from_transcription ?? 'N/A'} tax=${mathCheck.tax_sum_from_transcription ?? 'N/A'} total=${mathCheck.grand_total_from_transcription}\n` : '') +
      (math.runningTotalChain.length ? `Running Total: ${math.runningTotalChain.join(' -> ')}\n\n` : '') +
      (math.mathNotes.length ? `Math Notes: ${math.mathNotes.join(' | ')}\n\n` : '') +
      (hallucinationReport.flags.length ? `Hallucination Guard:\n  ${hallucinationReport.flags.join('\n  ')}\n\n` : '') +
      `Confidence: #=${ai.invoice_number_confidence} Date=${ai.date_confidence} Vendor=${ai.customer_name_confidence} Total=${ai.total_confidence}` +
      (regionRereadApplied ? ' | Region re-read applied' : '') +
      (missingItemsRereadApplied ? ' | Missing items re-read applied' : '') +
      (math.mathOverride ? ' | Math override applied' : '') +
      (reconciliationApplied ? ' | Reconciliation applied' : '') + '\n\n' +
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
      ...(crossCustomerDuplicate ? { crossCustomerDuplicate: true } : {}),
      isPartialPayment, partialPaymentOriginalTotal, partialPaymentOriginalId,
      isRecurring, recurringDelta,
      priceWarnings,
      priceWarningsAt,
      reconciliationApplied,
      riskVerdict,
    };
    result.healthScore = calcHealthScore(result);
    result.salesmanSummary = buildSalesmanSummary(result);

    // v7.5 — Credit sale detection
    // Detect from AI payment_status field OR by scanning the raw OCR text
    const creditKeywords = /not\s*paid|on\s*credit|credit\s*sale|balance\s*due|owing|not\s*collected|balance/i;
    const paymentStatus = String(ai.payment_status ?? '').toUpperCase();
    const isCreditSale =
      paymentStatus === 'NOT_PAID' ||
      paymentStatus === 'CREDIT' ||
      paymentStatus === 'PARTIAL' ||
      creditKeywords.test(ai.credit_note ?? '') ||
      creditKeywords.test(transcription);

    if (isCreditSale) {
      result.isCreditSale = true;
      result.creditSaleNote = ai.credit_note || 'Not Paid / Credit Sale detected on invoice';
      // Check if customer already has outstanding credit
      const creditHistory = checkCustomerCreditHistory(validatedData.customer_name, invoiceHistory as InvoiceProcessingResult[]);
      if (creditHistory.hasOutstandingCredit) {
        (result as any).hasOutstandingCredit = true;
        (result as any).outstandingCreditTotal = creditHistory.totalOwed;
      }
      // Override verdict to CAUTION if currently ACCEPT — money hasn't been collected yet
      if (result.riskVerdict?.verdict === 'ACCEPT') {
        result.riskVerdict = {
          ...result.riskVerdict,
          verdict: 'CAUTION',
          reason: `CREDIT SALE — goods given but money NOT yet collected. Total: ${result.validatedData.total?.toFixed(2) ?? '?'}. Record this and follow up for payment.`,
          details: [
            `Credit note on invoice: "${result.creditSaleNote}"`,
            `→ This invoice is for goods given on credit. Do NOT mark as collected until payment is received.`,
            `→ Record the customer name, date and amount. Follow up on the due date.`,
            ...(result.riskVerdict?.details ?? []),
          ],
        };
      }
    }

    return result;

  } catch (error: any) {
    const msg = typeof error?.message === 'string' && error.message.length < 800 ? error.message : 'Unknown server error';
    console.error('--- processInvoice error ---', error);
    throw new Error(`Invoice processing failed: ${msg}`);
  }
}

// -----------------------------------------------------------------
// VOICE INVOICE — server-side Groq parse
// -----------------------------------------------------------------

export async function parseVoiceTranscript(transcript: string): Promise<string> {
  const prompt = `You are an invoice parser. The user verbally described items for an invoice.
Extract all line items, the customer/vendor name (if mentioned), and compute totals.
Do NOT apply tax unless the user explicitly mentions it.

Respond ONLY with a valid JSON object — no markdown, no preamble, no explanation:
{
  "customer_name": "string or null",
  "invoice_number": "string or null",
  "items": [
    {"name": "string", "quantity": number, "unit_price": number, "line_total": number}
  ],
  "subtotal": number,
  "tax": number,
  "total": number,
  "notes": "string or null"
}

User said: "${transcript}"`;
  return callText(prompt, 1500);
}
