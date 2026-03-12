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

export type InvoiceProcessingResult = {
  id: string;
  isValid: boolean;
  errors: ValidationError[];
  validatedData: ValidatedData;
  ocrText: string;
  status: InvoiceStatus;
  createdAt: string;
  // #27 quick notes
  notes?: string;
  // #25 payment due date
  dueDate?: string;
  // approval / rejection
  approvedAt?: string;
  rejectedAt?: string;
  rejectionReason?: string;
  // #1 duplicate detection
  isDuplicate?: boolean;
  duplicateOfId?: string;
  // #4 vendor consistency
  vendorKey?: string;
  // #39 smart name
  smartName?: string;
  // #40 recurring flag
  isRecurring?: boolean;
  recurringDelta?: number; // % change vs last seen from same vendor
  // #43 health score
  healthScore?: number;
};

// #40 recurring pattern tracker
export interface VendorProfile {
  vendorKey: string;
  vendorName: string;
  invoiceCount: number;
  averageTotal: number;
  lastTotal: number;
  lastSeen: string;
  categories: string[];
  itemNames: string[];           // price memory: known items
  itemPrices: Record<string, number>; // item name -> last unit_price
  errorCount: number;
  taxRates: number[];            // #5 tax rate history
}
