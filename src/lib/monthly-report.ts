import type { InvoiceProcessingResult } from './types';

function fmt(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function exportMonthlyReport(
  history: InvoiceProcessingResult[],
  month: number,   // 0-indexed
  year: number,
  currency = 'GHS',
  salesmanName = ''
) {
  const monthInvoices = history.filter(inv => {
    const d = new Date(inv.createdAt);
    return d.getMonth() === month && d.getFullYear() === year;
  });

  const monthLabel = new Date(year, month, 1).toLocaleString('default', { month: 'long', year: 'numeric' });

  const totalValue    = monthInvoices.reduce((s, i) => s + (i.validatedData.total ?? 0), 0);
  const approved      = monthInvoices.filter(i => i.status === 'approved');
  const rejected      = monthInvoices.filter(i => i.status === 'rejected');
  const errors        = monthInvoices.filter(i => i.status === 'error');
  const creditSales   = monthInvoices.filter(i => i.isCreditSale);
  const duplicates    = monthInvoices.filter(i => i.isDuplicate);
  const highRisk      = monthInvoices.filter(i => i.riskVerdict?.verdict === 'REJECT' || i.riskVerdict?.verdict === 'ESCALATE');
  const creditTotal   = creditSales.reduce((s, i) => s + (i.validatedData.total ?? 0), 0);
  const approvedValue = approved.reduce((s, i) => s + (i.validatedData.total ?? 0), 0);

  // By-day totals
  const byDay: Record<string, number> = {};
  monthInvoices.forEach(inv => {
    const dayKey = new Date(inv.createdAt).toLocaleDateString(undefined, { day: 'numeric', weekday: 'short' });
    byDay[dayKey] = (byDay[dayKey] ?? 0) + (inv.validatedData.total ?? 0);
  });

  // Top customers
  const customerMap: Record<string, { count: number; total: number }> = {};
  monthInvoices.forEach(inv => {
    const name = inv.validatedData.customer_name?.trim() || 'Unknown';
    if (!customerMap[name]) customerMap[name] = { count: 0, total: 0 };
    customerMap[name].count++;
    customerMap[name].total += inv.validatedData.total ?? 0;
  });
  const topCustomers = Object.entries(customerMap)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 10);

  // Invoice rows
  const rows = monthInvoices.map(inv => {
    const verdict = inv.riskVerdict?.verdict ?? '';
    const verdictColor =
      verdict === 'REJECT' ? '#dc2626' :
      verdict === 'ESCALATE' ? '#d97706' :
      verdict === 'CAUTION' ? '#ca8a04' : '#16a34a';
    const statusColor =
      inv.status === 'approved' ? '#16a34a' :
      inv.status === 'rejected' ? '#6b7280' :
      inv.status === 'error' ? '#dc2626' : '#d97706';
    return `<tr style="border-bottom:1px solid #eee">
      <td style="padding:7px 8px;font-size:12px">${new Date(inv.createdAt).toLocaleDateString()}</td>
      <td style="padding:7px 8px;font-size:12px">${inv.validatedData.customer_name || '—'}</td>
      <td style="padding:7px 8px;font-size:12px">${inv.validatedData.invoice_number || '—'}</td>
      <td style="padding:7px 8px;font-size:12px">${inv.validatedData.category || '—'}</td>
      <td style="padding:7px 8px;font-size:12px;text-align:right;font-weight:bold">${currency} ${fmt(inv.validatedData.total ?? 0)}</td>
      <td style="padding:7px 8px;font-size:12px;text-align:center;color:${statusColor};font-weight:bold">${inv.status.toUpperCase()}</td>
      <td style="padding:7px 8px;font-size:12px;text-align:center;color:${verdictColor};font-weight:bold">${verdict || '—'}</td>
      <td style="padding:7px 8px;font-size:12px;text-align:center">${inv.healthScore ?? '—'}</td>
    </tr>`;
  }).join('');

  const customerRows = topCustomers.map(([name, data], i) =>
    `<tr style="border-bottom:1px solid #eee">
      <td style="padding:7px 8px;font-size:12px;font-weight:bold;color:#0d9488">${i + 1}</td>
      <td style="padding:7px 8px;font-size:12px">${name}</td>
      <td style="padding:7px 8px;font-size:12px;text-align:center">${data.count}</td>
      <td style="padding:7px 8px;font-size:12px;text-align:right;font-weight:bold">${currency} ${fmt(data.total)}</td>
    </tr>`
  ).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>InvoiceGuard Monthly Report — ${monthLabel}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: Arial, sans-serif; color: #111; background: #fff; padding: 24px; max-width: 960px; margin: 0 auto; }
h1 { color: #0d9488; font-size: 22px; margin-bottom: 4px; }
h2 { color: #0d9488; font-size: 15px; margin: 24px 0 10px; border-bottom: 2px solid #e5e7eb; padding-bottom: 4px; }
.meta { font-size: 13px; color: #666; margin-bottom: 20px; }
.kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 24px; }
.kpi { background: #f9fafb; border-radius: 10px; padding: 14px; text-align: center; border: 1px solid #e5e7eb; }
.kpi-value { font-size: 24px; font-weight: 900; color: #0d9488; }
.kpi-value.red { color: #dc2626; }
.kpi-value.green { color: #16a34a; }
.kpi-value.amber { color: #d97706; }
.kpi-label { font-size: 11px; color: #666; margin-top: 4px; }
table { width: 100%; border-collapse: collapse; margin-top: 8px; }
th { background: #f3f4f6; padding: 9px 8px; text-align: left; font-size: 11px; color: #555; border-bottom: 2px solid #e5e7eb; }
td { vertical-align: middle; }
.alert { padding: 12px 16px; border-radius: 8px; font-size: 13px; font-weight: bold; margin-bottom: 8px; }
.alert-red { background: #fef2f2; color: #dc2626; border: 1px solid #fca5a5; }
.alert-green { background: #f0fdf4; color: #16a34a; border: 1px solid #86efac; }
.alert-amber { background: #fffbeb; color: #d97706; border: 1px solid #fcd34d; }
.footer { margin-top: 32px; font-size: 11px; color: #999; border-top: 1px solid #e5e7eb; padding-top: 12px; }
@media print { body { padding: 12px; } }
</style>
</head>
<body>
<h1>🛡️ InvoiceGuard AI — Monthly Report</h1>
<div class="meta">
  ${monthLabel}${salesmanName ? ` · Prepared by: <strong>${salesmanName}</strong>` : ''}
  · Generated: ${new Date().toLocaleString()}
</div>

${highRisk.length > 0
  ? `<div class="alert alert-red">⚠️ ${highRisk.length} HIGH-RISK invoice${highRisk.length !== 1 ? 's' : ''} this month — ${currency} ${fmt(highRisk.reduce((s,i) => s+(i.validatedData.total??0),0))} at risk. Do NOT release payment without manager approval.</div>`
  : `<div class="alert alert-green">✅ No high-risk invoices this month. All collections verified.</div>`}

${creditSales.length > 0
  ? `<div class="alert alert-amber">📋 ${creditSales.length} credit sale${creditSales.length!==1?'s':''} — ${currency} ${fmt(creditTotal)} outstanding. Follow up for collection.</div>`
  : ''}

<h2>Key Performance Indicators</h2>
<div class="kpi-grid">
  <div class="kpi"><div class="kpi-value">${monthInvoices.length}</div><div class="kpi-label">Total Invoices</div></div>
  <div class="kpi"><div class="kpi-value">${currency} ${fmt(totalValue)}</div><div class="kpi-label">Total Value</div></div>
  <div class="kpi"><div class="kpi-value green">${currency} ${fmt(approvedValue)}</div><div class="kpi-label">Approved & Safe</div></div>
  <div class="kpi"><div class="kpi-value ${highRisk.length > 0 ? 'red' : 'green'}">${currency} ${fmt(highRisk.reduce((s,i) => s+(i.validatedData.total??0),0))}</div><div class="kpi-label">Money at Risk</div></div>
  <div class="kpi"><div class="kpi-value green">${approved.length}</div><div class="kpi-label">Approved</div></div>
  <div class="kpi"><div class="kpi-value ${errors.length > 0 ? 'red' : 'green'}">${errors.length}</div><div class="kpi-label">Error Invoices</div></div>
  <div class="kpi"><div class="kpi-value ${rejected.length > 0 ? 'amber' : 'green'}">${rejected.length}</div><div class="kpi-label">Rejected</div></div>
  <div class="kpi"><div class="kpi-value ${duplicates.length > 0 ? 'red' : 'green'}">${duplicates.length}</div><div class="kpi-label">Duplicates Found</div></div>
  <div class="kpi"><div class="kpi-value amber">${creditSales.length}</div><div class="kpi-label">Credit Sales</div></div>
  <div class="kpi"><div class="kpi-value amber">${currency} ${fmt(creditTotal)}</div><div class="kpi-label">Credit Outstanding</div></div>
</div>

${topCustomers.length > 0 ? `
<h2>Top Customers</h2>
<table>
<thead><tr><th>#</th><th>Customer</th><th>Invoices</th><th>Total Value</th></tr></thead>
<tbody>${customerRows}</tbody>
</table>` : ''}

<h2>All Invoices This Month</h2>
${monthInvoices.length === 0
  ? '<p style="color:#999;font-size:13px;margin-top:8px">No invoices recorded this month.</p>'
  : `<table>
<thead><tr><th>Date</th><th>Customer</th><th>Invoice #</th><th>Category</th><th>Total</th><th>Status</th><th>Verdict</th><th>Health</th></tr></thead>
<tbody>${rows}</tbody>
</table>`}

<div class="footer">
  InvoiceGuard AI · Report generated ${new Date().toLocaleString()} · ${monthInvoices.length} invoice${monthInvoices.length!==1?'s':''} in ${monthLabel}
  ${salesmanName ? ` · Salesman: ${salesmanName}` : ''}
</div>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `InvoiceGuard_${monthLabel.replace(/\s/g, '_')}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
