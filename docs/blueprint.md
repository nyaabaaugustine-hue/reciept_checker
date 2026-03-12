# **App Name**: InvoiceGuard AI

## Core Features:

- Mobile-First Invoice Capture & Upload: Provide a responsive interface for users to easily take photos of invoices via their mobile camera or upload image files (JPG, PNG, PDF) from their device, with immediate image preview.
- AI-Powered Image Optimization & OCR Tool: Utilize AI and computer vision (e.g., OpenCV techniques) to automatically preprocess invoice images (grayscale, contrast, noise reduction, edge detection, smart cropping) and then use Tesseract OCR to intelligently extract raw text from all relevant fields, acting as a tool to improve OCR accuracy.
- Intelligent Data Parsing Tool: An AI-driven parsing tool that transforms raw OCR text into a structured JSON format, accurately mapping extracted details such as invoice number, date, customer name, line items (quantity, unit price, line total), subtotal, tax, and grand total.
- Automated Error Detection Tool: Implement an AI tool to automatically validate invoice data, performing calculation checks (line totals, subtotal, grand total), identifying missing required fields (e.g., invoice number, date), and detecting issues like blurry or dark images.
- Interactive Results Display: Present a clear, mobile-friendly results screen showing all extracted invoice data and a distinct 'verified' or 'errors detected' status, with detailed highlights of any identified issues or discrepancies.
- Supabase Storage & Management: Integrate with Supabase to securely store original invoice images in a dedicated bucket and persist structured invoice data, raw OCR text, and processing status in a 'invoices' database table.
- Robust Backend API Endpoints: Develop a set of essential backend API endpoints to handle image uploads, orchestrate OCR and validation processes, save results to Supabase, and enable future retrieval of stored invoice records.

## Style Guidelines:

- Primary color: A confident and professional blue (#226BDC), chosen to evoke trust, clarity, and precision, without being overly formal.
- Background color: A very light, subtle cool-greyish blue (#EEF3F9), providing a clean, uncluttered canvas that enhances readability.
- Accent color: A vibrant, analogous aqua (#1FBED9) used sparingly for key interactive elements like buttons and highlights, ensuring clear calls to action and visual distinction.
- All text (headlines and body): 'Inter' (sans-serif), selected for its modern, neutral, and highly readable qualities, ideal for data-intensive and mobile-first applications.
- Utilize clear and functional icons for navigation, actions (like camera capture/upload), and to convey status (e.g., checkmarks for verified, 'x' for errors), ensuring high visibility on mobile screens.
- Implement a minimalist, mobile-first layout with generous whitespace, large touch targets for buttons, and a sequential user flow to simplify the invoice processing experience.
- Incorporate subtle and swift animations for screen transitions and during the invoice processing step to provide clear visual feedback without hindering the user experience.