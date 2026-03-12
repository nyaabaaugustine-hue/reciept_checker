# InvoiceGuard AI

A Next.js application that uses **Claude Vision AI** to scan and validate sales invoices and receipts with exceptional accuracy — no separate OCR engine required.

## How it works

1. Upload an invoice image (JPG, PNG, WebP) or take a photo with your camera
2. The image is sent directly to **Claude claude-sonnet-4-20250514** which reads it with near-human accuracy
3. Claude extracts all structured data (line items, totals, dates, etc.) in one step
4. The app validates the numbers — checking line item maths, subtotals, and grand totals
5. Errors are highlighted and you can manually correct any field

## Getting Started

### 1. Add your API key

Create a `.env.local` file in the project root (already created for you) and add your Anthropic API key:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Get your key at [https://console.anthropic.com/](https://console.anthropic.com/)

### 2. Install dependencies

```bash
npm install
```

### 3. Run the development server

```bash
npm run dev
```

Open [http://localhost:9002](http://localhost:9002) in your browser.

## Deploy on Vercel

1. Push the project to GitHub
2. Import it on [Vercel](https://vercel.com)
3. In your project's **Settings → Environment Variables**, add:
   - `ANTHROPIC_API_KEY` = your key from [console.anthropic.com](https://console.anthropic.com)
4. Deploy — Vercel will pick up the env var automatically

## Tech Stack

- **Next.js 15** with App Router & Server Actions
- **Claude claude-sonnet-4-20250514** — vision OCR + structured data extraction
- **shadcn/ui** + **Tailwind CSS**
- **Recharts** for the spending dashboard
