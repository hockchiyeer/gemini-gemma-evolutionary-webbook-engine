import { generatePdf } from '../../server/pdfBridge.ts';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
async function test() {
  try {
    const pdf = await generatePdf('<h1>Test</h1>');
    fs.writeFileSync(path.join(__dirname, 'test.pdf'), pdf);
    console.log('PDF generated, size:', pdf.length);
  } catch (err) {
    console.error('Error generating PDF:', err);
  }
}
test();
