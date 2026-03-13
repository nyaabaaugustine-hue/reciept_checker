export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidatedData {
  invoice_number?: string;
  date?: string;
  customer_name?: string;
  category?: string;
  items?: {
    name?: string;
    quantity?: number;
    unit_price?: number;
    line_total?: number;
  }[];
  subtotal?: number;
  tax?: number;
  total?: number;
}

export type InvoiceStatus = 'verified' | 'error' | 'corrected' | 'approved' | 'rejected';

export type RiskVerdict = 'ACCEPT' | 'CAUTION' | 'REJECT' | 'ESCALATE';

export interface RiskVerdictResult {
  verdict: RiskVerdict;
  reason: string;
  details: string[];
  moneyAtRisk: number;
}

export type InvoiceProcessingResult = {
  id: string;
  isValid: boolean;
  errors: ValidationError[];
  validatedData: ValidatedData;
  ocrText: string;
  status: InvoiceStatus;
  createdAt: string;
  notes?: string;
  dueDate?: string;
  approvedAt?: string;
  rejectedAt?: string;
  rejectionReason?: string;
  isDuplicate?: boolean;
  duplicateOfId?: string;
  vendorKey?: string;
  smartName?: string;
  isRecurring?: boolean;
  recurringDelta?: number;
  healthScore?: number;
  isPartialPayment?: boolean;
  partialPaymentOriginalTotal?: number;
  partialPaymentOriginalId?: string;
  currency?: string;
  priceWarnings?: string[];
  reconciliationApplied?: boolean;
  riskVerdict?: RiskVerdictResult;
  // #fix11 — timestamp for price warning staleness display
  priceWarningsAt?: string;
  // #fix3 — first-seen price per item for cumulative drift tracking (stored on vendor profile via buildVendorProfiles)
  /** v7.0 — plain-English one-line summary for salesman (built by buildSalesmanSummary) */
  salesmanSummary?: string;
};

/** Slim version of InvoiceProcessingResult passed to the server action.
 *  ocrText is stripped to keep the payload small (fix #2). */
export type SlimInvoiceResult = Omit<InvoiceProcessingResult, 'ocrText'>;

export interface VendorProfile {
  vendorKey: string;
  vendorName: string;
  invoiceCount: number;
  averageTotal: number;
  lastTotal: number;
  lastSeen: string;
  categories: string[];
  itemNames: string[];
  /** last-seen price per item (lower-cased name) */
  itemPrices: Record<string, number>;
  /** first-seen price per item — used for cumulative drift (fix #3) */
  itemFirstPrices: Record<string, number>;
  errorCount: number;
  taxRates: number[];
}

export interface AppSettings {
  salesmanName: string;
  currency: string;
  taxRatePct: number;
  riskThreshold: string;
  customCategories: string[];
  pinEnabled: boolean;
  pinHash: string;
}

/** Recurring invoice pattern — used by detectRecurringPatterns in intelligence.ts */
export interface RecurringPattern {
  vendorKey: string;
  vendorName: string;
  averageTotal: number;
  frequency: 'weekly' | 'monthly' | 'irregular';
  lastSeen: string;
  count: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  salesmanName: '',
  currency: 'GHS',
  taxRatePct: 15,
  riskThreshold: '',
  customCategories: [],
  pinEnabled: false,
  pinHash: '',
};
