/**
 * Server-side PDF generation bridge.
 * Note: Native Puppeteer browser rendering is disabled in this environment.
 * The client automatically falls back to high-fidelity vector PDF generation via jsPDF.
 */

export async function generatePdf(_html: string): Promise<Buffer> {
  throw new Error('Server-side Puppeteer PDF generation is disabled. Using client-side PDF export fallback.');
}
