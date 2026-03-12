'use server';

import type { InvoiceProcessingResult, ValidatedData, ValidationError } from '@/lib/types';
import {
  normaliseVendorKey,
  validateTaxRate,
  checkDateAnomaly,
  buildSmartName,
  calcHealthScore,
} from '@/lib/invoice-intelligence';

function parseNumber(value: any): number | undefined {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return undefined;
  const cleaned = String(value).replace(/[^0-9.-]/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? undefined : parsed;
}

export async function processInvoice(imageBase64: string): Promise<InvoiceProcessingResult> {
  let aiExtractedData;

  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error('GROQ_API_KEY is not set in .env.local');

    const matches = imageBase64.match(/^data:(.+);base64,(.+)$/);
    if (!matches) throw new Error('Invalid image format. Expected a base64 data URI.');
    const mediaType = matches[1];
    const rawBase64 = matches[2];
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

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
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
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Groq API error (Status: ${response.status}). Body: ${errorBody}`);
    }

    const completion = await response.json();
    let rawJson = completion.choices?.[0]?.message?.content;
    if (!rawJson) throw new Error('Groq returned an empty response.');

    rawJson = rawJson.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    try {
      aiExtractedData = JSON.parse(rawJson);
    } catch {
      throw new Error(`Groq returned invalid JSON. Raw: ${rawJson}`);
    }

    // ── Build validated data ──────────────────────────────────────────────────
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

    // Core field checks
    if (!validatedData.invoice_number) errors.push({ field: 'invoice_number', message: 'Invoice number is missing or unreadable.' });
    if (!validatedData.customer_name) errors.push({ field: 'customer_name', message: 'Customer name is missing or unreadable.' });
    if (validatedData.total === undefined) errors.push({ field: 'total', message: 'Grand total is missing or unreadable.' });
    if (!validatedData.items || validatedData.items.length === 0) errors.push({ field: 'items', message: 'No line items were found on the invoice.' });

    // Line item maths
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

    // Subtotal check
    if (validatedData.subtotal !== undefined && Math.abs(calculatedSubtotal - validatedData.subtotal) > 0.01) {
      errors.push({
        field: 'subtotal',
        message: `Subtotal mismatch: items sum to ${calculatedSubtotal.toFixed(2)} but invoice states ${validatedData.subtotal.toFixed(2)}. Discrepancy: ${(validatedData.subtotal - calculatedSubtotal).toFixed(2)}.`,
      });
    }

    // Grand total check
    if (validatedData.subtotal !== undefined && validatedData.tax !== undefined && validatedData.total !== undefined) {
      const expected = validatedData.subtotal + validatedData.tax;
      if (Math.abs(expected - validatedData.total) > 0.01) {
        errors.push({
          field: 'total',
          message: `Grand total mismatch: ${validatedData.subtotal.toFixed(2)} + ${validatedData.tax.toFixed(2)} = ${expected.toFixed(2)}, but invoice states ${validatedData.total.toFixed(2)}. Discrepancy: ${(validatedData.total - expected).toFixed(2)}.`,
        });
      }
    }

    // #5 Tax rate check
    const taxCheck = validateTaxRate(validatedData.subtotal, validatedData.tax);
    if (!taxCheck.ok && taxCheck.message) {
      errors.push({ field: 'tax', message: taxCheck.message });
    }

    // #10 Date anomaly
    const dateWarning = checkDateAnomaly(validatedData.date);
    if (dateWarning) {
      errors.push({ field: 'date', message: dateWarning });
    }

    const isValid = errors.length === 0;
    const status = isValid ? 'verified' : 'error';

    // Build partial result (duplicate/recurring enrichment happens client-side with history context)
    const partialResult: InvoiceProcessingResult = {
      id: crypto.randomUUID(),
      isValid,
      errors,
      validatedData,
      ocrText: `[Groq Vision AI — Llama 4 Scout${aiExtractedData.currency ? ` | ${aiExtractedData.currency}` : ''}]${aiExtractedData.ocr_notes ? `\nNotes: ${aiExtractedData.ocr_notes}` : ''}\n\n${JSON.stringify(aiExtractedData, null, 2)}`,
      status,
      createdAt: new Date().toISOString(),
      dueDate: aiExtractedData.due_date || undefined,
      vendorKey: normaliseVendorKey(validatedData.customer_name),
      smartName: buildSmartName(validatedData),
    };

    // Health score (no duplicate info yet — will be recalculated client-side)
    partialResult.healthScore = calcHealthScore(partialResult);

    return partialResult;
  } catch (error: any) {
    console.error('--- processInvoice error ---', error);
    throw new Error(`Invoice processing failed: ${error.message || 'Unknown error'}`);
  }
}
