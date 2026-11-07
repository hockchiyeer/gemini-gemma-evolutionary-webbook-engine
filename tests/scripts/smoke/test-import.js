async function test() {
  try {
    const bridge = await import('../../server/pdfBridge.ts');
    console.log('Import successful');
  } catch (err) {
    console.error('Import failed:', err);
  }
}
test();
