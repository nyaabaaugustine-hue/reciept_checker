'use client';

import { useState } from 'react';
import { X, Plus, Trash2, FileText, ChevronDown } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import type { InvoiceProcessingResult, ValidatedData } from '@/lib/types';

const CATEGORIES = [
  'Groceries', 'Electronics', 'Clothing', 'Furniture', 'Pharmaceuticals',
  'Beverages', 'Construction', 'Automotive', 'Stationery', 'Food & Catering',
  'Cleaning Supplies', 'Agricultural', 'Medical', 'Telecoms', 'Other',
];

const PAYMENT_TERMS = ['Due on Receipt', 'Net 7', 'Net 14', 'Net 30', 'Net 60', 'Net 90'];

interface LineItem {
  id: string;
  name: string;
  quantity: string;
  unit_price: string;
}

interface ManualInvoiceModalProps {
  onClose: () => void;
  onSubmit: (result: InvoiceProcessingResult) => void;
  currency: string;
}

function generateId() {
  return `manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function Select({ value, onChange, options, placeholder }: {
  value: string; onChange: (v: string) => void; options: string[]; placeholder: string;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full h-12 pl-4 pr-10 rounded-xl border bg-background text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-primary/50 cursor-pointer"
      >
        <option value="">{placeholder}</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
      <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
    </div>
  );
}

export function ManualInvoiceModal({ onClose, onSubmit, currency }: ManualInvoiceModalProps) {
  const [customerName, setCustomerName] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [dueDate, setDueDate] = useState('');
  const [category, setCategory] = useState('');
  const [paymentTerm, setPaymentTerm] = useState('');
  const [items, setItems] = useState<LineItem[]>([
    { id: generateId(), name: '', quantity: '', unit_price: '' },
  ]);
  const [taxPct, setTaxPct] = useState('15');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const addItem = () => setItems(prev => [...prev, { id: generateId(), name: '', quantity: '', unit_price: '' }]);
  const removeItem = (id: string) => setItems(prev => prev.filter(i => i.id !== id));
  const updateItem = (id: string, field: keyof LineItem, value: string) =>
    setItems(prev => prev.map(i => i.id === id ? { ...i, [field]: value } : i));

  const computedItems = items.map(i => ({
    name: i.name,
    quantity: parseFloat(i.quantity) || 0,
    unit_price: parseFloat(i.unit_price) || 0,
    line_total: (parseFloat(i.quantity) || 0) * (parseFloat(i.unit_price) || 0),
  }));

  const subtotal = computedItems.reduce((s, i) => s + i.line_total, 0);
  const taxRate = parseFloat(taxPct) || 0;
  const tax = subtotal * (taxRate / 100);
  const total = subtotal + tax;
  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const validate = () => {
    const e: Record<string, string> = {};
    if (!customerName.trim()) e.customerName = 'Customer name is required';
    if (!invoiceNumber.trim()) e.invoiceNumber = 'Invoice number is required';
    if (items.every(i => !i.name.trim())) e.items = 'Add at least one item';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = () => {
    if (!validate()) return;
    const validatedData: ValidatedData = {
      invoice_number: invoiceNumber,
      date,
      customer_name: customerName,
      category: category || 'Other',
      items: computedItems,
      subtotal,
      tax,
      total,
    };
    const result: InvoiceProcessingResult = {
      id: generateId(),
      isValid: true,
      errors: [],
      validatedData,
      ocrText: '',
      status: 'verified',
      createdAt: new Date().toISOString(),
      notes: notes || undefined,
      dueDate: dueDate || undefined,
      healthScore: 90,
      riskVerdict: { verdict: 'ACCEPT', reason: 'Manual entry — assumed valid', details: [], moneyAtRisk: 0 },
      salesmanSummary: `Manual invoice for ${customerName} — ${currency} ${fmt(total)}`,
    };
    onSubmit(result);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background animate-fade-in-up overflow-y-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background border-b flex items-center justify-between px-4 py-3 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
            <FileText className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h2 className="font-bold text-base leading-tight">New Invoice</h2>
            <p className="text-xs text-muted-foreground">Manual entry</p>
          </div>
        </div>
        <button onClick={onClose} className="tap-target rounded-full p-2 hover:bg-muted">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="flex-1 px-4 py-4 space-y-5 pb-36">
        {/* Customer & Invoice info */}
        <section className="space-y-3">
          <h3 className="text-sm font-bold text-muted-foreground uppercase tracking-wider">Invoice Info</h3>

          <div className="space-y-2">
            <label className="text-sm font-semibold">Customer Name *</label>
            <Input
              value={customerName}
              onChange={e => setCustomerName(e.target.value)}
              placeholder="e.g. Kwame Asante Ltd."
              className={`h-12 rounded-xl ${errors.customerName ? 'border-red-500' : ''}`}
            />
            {errors.customerName && <p className="text-xs text-red-500">{errors.customerName}</p>}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-semibold">Invoice Number *</label>
            <Input
              value={invoiceNumber}
              onChange={e => setInvoiceNumber(e.target.value)}
              placeholder="e.g. INV-2025-001"
              className={`h-12 rounded-xl ${errors.invoiceNumber ? 'border-red-500' : ''}`}
            />
            {errors.invoiceNumber && <p className="text-xs text-red-500">{errors.invoiceNumber}</p>}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-2">
              <label className="text-sm font-semibold">Invoice Date</label>
              <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="h-12 rounded-xl" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-semibold">Due Date</label>
              <Input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className="h-12 rounded-xl" />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-semibold">Category</label>
            <Select value={category} onChange={setCategory} options={CATEGORIES} placeholder="Select a category…" />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-semibold">Payment Terms</label>
            <Select value={paymentTerm} onChange={setPaymentTerm} options={PAYMENT_TERMS} placeholder="Select terms…" />
          </div>
        </section>

        {/* Line Items */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-muted-foreground uppercase tracking-wider">Line Items</h3>
            {errors.items && <p className="text-xs text-red-500">{errors.items}</p>}
          </div>

          <div className="space-y-3">
            {items.map((item, idx) => (
              <Card key={item.id} className="rounded-2xl p-3 space-y-2 border-2 border-dashed border-muted">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-muted-foreground">ITEM {idx + 1}</span>
                  {items.length > 1 && (
                    <button onClick={() => removeItem(item.id)} className="text-red-500 p-1 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/20">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <Input
                  value={item.name}
                  onChange={e => updateItem(item.id, 'name', e.target.value)}
                  placeholder="Item name / description"
                  className="h-11 rounded-xl text-sm"
                />
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Quantity</label>
                    <Input
                      type="number"
                      value={item.quantity}
                      onChange={e => updateItem(item.id, 'quantity', e.target.value)}
                      placeholder="0"
                      min="0"
                      className="h-11 rounded-xl text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Unit Price ({currency})</label>
                    <Input
                      type="number"
                      value={item.unit_price}
                      onChange={e => updateItem(item.id, 'unit_price', e.target.value)}
                      placeholder="0.00"
                      min="0"
                      step="0.01"
                      className="h-11 rounded-xl text-sm"
                    />
                  </div>
                </div>
                {item.quantity && item.unit_price && (
                  <div className="flex justify-end">
                    <span className="text-sm font-bold text-primary">
                      = {currency} {fmt((parseFloat(item.quantity) || 0) * (parseFloat(item.unit_price) || 0))}
                    </span>
                  </div>
                )}
              </Card>
            ))}
          </div>

          <button
            onClick={addItem}
            className="w-full h-12 rounded-2xl border-2 border-dashed border-primary/40 text-primary font-semibold text-sm flex items-center justify-center gap-2 hover:bg-primary/5 active:scale-95 transition-all"
          >
            <Plus className="h-4 w-4" /> Add Another Item
          </button>
        </section>

        {/* Tax & Totals */}
        <section className="space-y-3">
          <h3 className="text-sm font-bold text-muted-foreground uppercase tracking-wider">Totals</h3>
          <div className="space-y-2">
            <label className="text-sm font-semibold">Tax Rate (%)</label>
            <Input
              type="number"
              value={taxPct}
              onChange={e => setTaxPct(e.target.value)}
              placeholder="15"
              min="0"
              max="100"
              className="h-12 rounded-xl"
            />
          </div>

          <Card className="rounded-2xl p-4 bg-muted/30 space-y-2 border-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="font-semibold">{currency} {fmt(subtotal)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Tax ({taxRate}%)</span>
              <span className="font-semibold">{currency} {fmt(tax)}</span>
            </div>
            <div className="border-t pt-2 flex justify-between">
              <span className="font-bold text-base">Total</span>
              <span className="font-black text-xl text-primary">{currency} {fmt(total)}</span>
            </div>
          </Card>
        </section>

        {/* Notes */}
        <section className="space-y-2">
          <h3 className="text-sm font-bold text-muted-foreground uppercase tracking-wider">Notes</h3>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Any additional notes…"
            rows={3}
            className="w-full rounded-xl border bg-background px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
          />
        </section>
      </div>

      {/* Sticky footer */}
      <div className="fixed bottom-0 left-0 right-0 bg-background border-t px-4 py-3 flex gap-3">
        <button onClick={onClose} className="action-btn-secondary flex-1">
          Cancel
        </button>
        <button onClick={handleSubmit} className="action-btn-primary flex-1">
          <FileText className="h-4 w-4" />
          Save Invoice
        </button>
      </div>
    </div>
  );
}
