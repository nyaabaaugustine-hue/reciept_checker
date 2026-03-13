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

// Protocol 9 — salesman risk verdict
export type RiskVerdict = 'ACCEPT' | 'CAUTION' | 'REJECT' | 'ESCALATE';

export interface RiskVerdictResult {
  verdict: RiskVerdict;
  // One plain-English sentence the salesman can act on immediately
  reason: string;
  // Secondary detail lines (shown collapsed, for supervisor review)
  details: string[];
  // Estimated money at risk from this single invoice (0 if ACCEPT)
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
  // #30 partial payment detection
  isPartialPayment?: boolean;
  partialPaymentOriginalTotal?: number;
  partialPaymentOriginalId?: string;
  // currency extracted by AI
  currency?: string;
  // Protocol 6 — price spike warnings from vendor memory
  priceWarnings?: string[];
  // Protocol 8 — reconciliation re-read applied
  reconciliationApplied?: boolean;
  // Protocol 9 — salesman risk verdict
  riskVerdict?: RiskVerdictResult;
};

export interface VendorProfile {
  vendorKey: string;
  vendorName: string;
  invoiceCount: number;
  averageTotal: number;
  lastTotal: number;
  lastSeen: string;
  categories: string[];
  itemNames: string[];
  itemPrices: Record<string, number>;
  errorCount: number;
  taxRates: number[];
}

// #44 / #45 / #46 / #47 / #50 — user settings
export interface AppSettings {
  salesmanName: string;
  currency: string;           // e.g. 'GHS', 'USD', 'NGN'
  taxRatePct: number;         // e.g. 15
  riskThreshold: string;      // money-at-risk alert threshold
  customCategories: string[]; // extra categories beyond AI defaults
  pinEnabled: boolean;
  pinHash: string;            // SHA-256 of PIN (hex string)
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
