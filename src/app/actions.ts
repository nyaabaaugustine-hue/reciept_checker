'use server';

import type { InvoiceProcessingResult, ValidatedData, ValidationError } from '@/lib/types';
import {
  normaliseVendorKey,
  validateTaxRate,
  checkDateAnomaly,
  buildSmartName,
  calcHealthScore,
} from '@/lib/invoice-intelligence';

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function parseNumber(value: any): number | undefined {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return undefined;
  const cleaned = String(value).replace(/[^0-9.-]/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? undefined : parsed;
}

function getGroqApiKey(): string {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY is not configured. Add it to your .env.local file and redeploy.');
  return key;
}

// Exponential backoff — retries on 429 / 5xx only
async function fetchWithRetry(url: string, options: RequestInit, retries = 3): Promise<Response> {
  let lastError: Error = new Error('Network error');
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status} on attempt ${attempt + 1}`);
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
        continue;
      }
      return res;
    } catch (err: any) {
      lastError = err;
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
    }
  }
  throw lastError;
}

// ─────────────────────────────────────────────────────────────
// GROQ VISION  — tries each model in order
// ─────────────────────────────────────────────────────────────

const GROQ_MODELS = [
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'llama-3.2-90b-vision-preview',
  'llama-3.2-11b-vision-preview',
];

async function callGroqVision(imageUrl: string, prompt: string, apiKey: string): Promise<string> {
  let lastError: Error = new Error('All Groq vision models failed');

  for (const model of GROQ_MODELS) {
    try {
      console.log(`[Groq] Trying model: ${model}`);
      const response = await fetchWithRetry(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            max_tokens: 2000,
            temperature: 0.1,
            messages: [{
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: imageUrl } },
                { type: 'text', text: prompt },
              ],
            }],
          }),
        },
        3
      );

      if (!response.ok) {
        const body = await response.text();
        if (response.status === 400 || response.status === 404) {
          lastError = new Error(`Groq model ${model} unavailable (${response.status})`);
          console.warn(`[Groq] ${lastError.message} — trying next model`);
          continue;
        }
        throw new Error(`Groq API error ${response.status}: ${body.slice(0, 300)}`);
      }

      const completion = await response.json();
      const content: string | undefined = completion.choices?.[0]?.message?.content;
      if (!content) throw new Error('Groq returned an empty response.');

      console.log(`[Groq] Success with model: ${model}`);
      return content;

    } catch (err: any) {
      if (
        err.message?.includes('unavailable') ||
        err.message?.includes('404') ||
        err.message?.includes('400')
      ) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}

// ─────────────────────────────────────────────────────────────
// MAIN SERVER ACTION
// ─────────────────────────────────────────────────────────────

export async function processInvoice(
  imageBase64: string,
  taxRatePct: number = 15
): Promise<InvoiceProcessingResult> {
  let aiExtractedData: any;

  try {
    const groqApiKey = getGroqApiKey();

    const matches = imageBase64.match(/^data:(.+);base64,(.+)$/);
    if (!matches) throw new Error('Invalid image format. Expected a base64 data URI.');
    const mediaType = matches[1];
    const rawBase64 = matches[2];

    if (rawBase64.length > 11_000_000) {
      throw new Error('Image is too large (max ~8MB). Please use a lower resolution and try again.');
    }

    const imageUrl = `data:${mediaType};base64,${rawBase64}`;

    const prompt = `You are an expert accountant and data entry specialist with exceptional OCR ability.
Carefully examine this invoice/receipt image and extract ALL data with maximum accuracy.

Respond ONLY with a single valid JSON object — no markdown, no preamble, no extra text.

{
  "invoice_number": "invoice/receipt number or null",
  "date": "invoice date as shown or null",
  "customer_name": "customer or vendor/store name or null",
  "category": "best-fit: Groceries | Office Supplies | Utilities | Transport | Dining | Electronics | Healthcare | Other",
  "due_date": "payment due date if shown or null",
  "items": [
    {
      "name": "item description",
      "quantity": "quantity as string number",
      "unit_price": "unit price as string number, no currency",
      "line_total": "line total as string number, no currency"
    }
  ],
  "subtotal": "subtotal as string number or null",
  "tax": "tax/VAT as string number or null",
  "total": "grand total as string number",
  "currency": "currency code e.g. GHS, USD, NGN or null",
  "ocr_notes": "any image quality issues or assumptions made"
}

Extract every visible line item. Numbers like 1,234.56 become 1234.56.`;

    const rawJson = await callGroqVision(imageUrl, prompt, groqApiKey);
    const cleaned = rawJson
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    try {
      aiExtractedData = JSON.parse(cleaned);
    } catch {
      throw new Error(`AI returned invalid JSON. Raw: ${cleaned.slice(0, 300)}`);
    }

    const validatedData: ValidatedData = {
      invoice_number: aiExtractedData.invoice_number || undefined,
      date: aiExtractedData.date || undefined,
      customer_name: aiExtractedData.customer_name || undefined,
      category: aiExtractedData.category || undefined,
      subtotal: parseNumber(aiExtractedData.subtotal),
      tax: parseNumber(aiExtractedData.tax),
      total: parseNumber(aiExtractedData.total),
      items: aiExtractedData.items?.map((item: any) => ({
        name: item.name || undefined,
        quantity: parseNumber(item.quantity),
        unit_price: parseNumber(item.unit_price),
        line_total: parseNumber(item.line_total),
      })) || [],
    };

    const errors: ValidationError[] = [];

    if (!validatedData.invoice_number) errors.push({ field: 'invoice_number', message: 'Invoice number is missing or unreadable.' });
    if (!validatedData.customer_name) errors.push({ field: 'customer_name', message: 'Customer name is missing or unreadable.' });
    if (validatedData.total === undefined) errors.push({ field: 'total', message: 'Grand total is missing or unreadable.' });
    if (!validatedData.items || validatedData.items.length === 0) errors.push({ field: 'items', message: 'No line items were found on the invoice.' });

    let calculatedSubtotal = 0;
    for (const [i, item] of (validatedData.items || []).entries()) {
      const qty = item.quantity ?? 0;
      const unitPrice = item.unit_price ?? 0;
      const lineTotal = item.line_total;
      if (lineTotal !== undefined) {
        calculatedSubtotal += lineTotal;
        const expected = qty * unitPrice;
        if (qty > 0 && unitPrice > 0 && Math.abs(expected - lineTotal) > 0.01) {
          errors.push({
            field: `items[${i}].line_total`,
            message: `"${item.name || 'Item'}" calc error: ${qty} × ${unitPrice.toFixed(2)} = ${expected.toFixed(2)}, but invoice shows ${lineTotal.toFixed(2)}. Discrepancy: ${(lineTotal - expected).toFixed(2)}.`,
          });
        }
      }
    }

    if (validatedData.subtotal !== undefined && Math.abs(calculatedSubtotal - validatedData.subtotal) > 0.01) {
      errors.push({
        field: 'subtotal',
        message: `Subtotal mismatch: items sum to ${calculatedSubtotal.toFixed(2)} but invoice states ${validatedData.subtotal.toFixed(2)}. Discrepancy: ${(validatedData.subtotal - calculatedSubtotal).toFixed(2)}.`,
      });
    }

    if (
      validatedData.subtotal !== undefined &&
      validatedData.tax !== undefined &&
      validatedData.total !== undefined
    ) {
      const expected = validatedData.subtotal + validatedData.tax;
      if (Math.abs(expected - validatedData.total) > 0.01) {
        errors.push({
          field: 'total',
          message: `Grand total mismatch: ${validatedData.subtotal.toFixed(2)} + ${validatedData.tax.toFixed(2)} = ${expected.toFixed(2)}, but invoice states ${validatedData.total.toFixed(2)}. Discrepancy: ${(validatedData.total - expected).toFixed(2)}.`,
        });
      }
    }

    const taxCheck = validateTaxRate(validatedData.subtotal, validatedData.tax, taxRatePct);
    if (!taxCheck.ok && taxCheck.message) {
      errors.push({ field: 'tax', message: taxCheck.message });
    }

    const dateWarning = checkDateAnomaly(validatedData.date);
    if (dateWarning) {
      errors.push({ field: 'date', message: dateWarning });
    }

    const isValid = errors.length === 0;
    const status = isValid ? 'verified' : 'error';

    const partialResult: InvoiceProcessingResult = {
      id: crypto.randomUUID(),
      isValid,
      errors,
      validatedData,
      ocrText: `[Groq Vision AI${aiExtractedData.currency ? ` | ${aiExtractedData.currency}` : ''}]${aiExtractedData.ocr_notes ? `\nNotes: ${aiExtractedData.ocr_notes}` : ''}\n\n${JSON.stringify(aiExtractedData, null, 2)}`,
      status,
      createdAt: new Date().toISOString(),
      dueDate: aiExtractedData.due_date || undefined,
      vendorKey: normaliseVendorKey(validatedData.customer_name),
      smartName: buildSmartName(validatedData),
      currency: aiExtractedData.currency || undefined,
    };

    partialResult.healthScore = calcHealthScore(partialResult);
    return partialResult;

  } catch (error: any) {
    const msg: string =
      typeof error?.message === 'string' && error.message.length < 500
        ? error.message
        : 'Unknown server error';
    console.error('--- processInvoice error ---', error);
    throw new Error(`Invoice processing failed: ${msg}`);
  }
}
