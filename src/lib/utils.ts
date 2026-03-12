import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import Papa from "papaparse";
import type { ValidatedData } from "@/lib/types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

function download(filename: string, text: string, mimeType: string) {
  const element = document.createElement("a");
  element.setAttribute("href", `data:${mimeType};charset=utf-8,` + encodeURIComponent(text));
  element.setAttribute("download", filename);
  element.style.display = "none";
  document.body.appendChild(element);
  element.click();
  document.body.removeChild(element);
}

export function exportToJson(data: ValidatedData) {
  const jsonData = JSON.stringify(data, null, 2);
  download(`invoice-data-${data.invoice_number || 'N_A'}.json`, jsonData, 'application/json');
}

export function exportToCsv(data: ValidatedData) {
  const { items, ...mainData } = data;
  const mainDataSanitized = Object.fromEntries(
    Object.entries(mainData).map(([k,v]) => [k, String(v ?? '')])
  )
  
  if (!items || items.length === 0) {
    const csv = Papa.unparse([mainDataSanitized]);
    download(`invoice-summary-${data.invoice_number || 'N_A'}.csv`, csv, 'text/csv');
    return;
  }
  
  const itemsWithMainData = items.map(item => ({
    ...mainDataSanitized,
    item_name: item.name,
    item_quantity: item.quantity,
    item_unit_price: item.unit_price,
    item_line_total: item.line_total,
  }));
  
  const csv = Papa.unparse(itemsWithMainData);
  download(`invoice-details-${data.invoice_number || 'N_A'}.csv`, csv, 'text/csv');
}
