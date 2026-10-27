const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const PDFLib = require('../lib/pdf-lib.min.js');
const source = fs.readFileSync(path.resolve(__dirname, '../js/receipt.js'), 'utf8');

function environment(extra = {}) {
  const ctx = vm.createContext({ document: { addEventListener() {} }, PDFLib, Array, ...extra });
  vm.runInContext(source + '\nthis.receipt = Receipt;', ctx);
  return ctx.receipt;
}
async function collect(stream) { const parts = []; for await (const part of stream) parts.push(part); return parts; }

test('PDF real de cinco páginas é repartido em 2+2+1 sem omitir nem reordenar páginas', async () => {
  const pdf = await PDFLib.PDFDocument.create();
  for (let i = 0; i < 5; i++) pdf.addPage([200 + i, 300 + i]);
  const bytes = await pdf.save();
  const parts = await collect(environment().prepareParts({ type: 'application/pdf', name: 'sintetico.pdf', size: bytes.length, arrayBuffer: async () => bytes }));
  assert.deepEqual(parts.map((p) => ({ ...p.documentContext })), [
    { pageStart: 1, pageEnd: 2, totalPages: 5 }, { pageStart: 3, pageEnd: 4, totalPages: 5 }, { pageStart: 5, pageEnd: 5, totalPages: 5 }
  ]);
  const widths = [];
  for (const part of parts) {
    assert.ok(Buffer.byteLength(part.data, 'base64') <= 3 * 1024 * 1024);
    const recovered = await PDFLib.PDFDocument.load(part.data);
    widths.push(...recovered.getPages().map((page) => page.getWidth()));
  }
  assert.deepEqual(widths, [200,201,202,203,204]);
});

test('chunk PDF acima de 3 MiB recua para uma página sem pular a seguinte', async () => {
  const copies = [];
  const fake = { PDFDocument: {
    load: async () => ({ getPageCount: () => 3 }),
    create: async () => {
      let count;
      return { copyPages: async (_, indices) => { copies.push(Array.from(indices)); count = indices.length; return indices; }, addPage() {},
        saveAsBase64: async () => count === 2 ? 'A'.repeat(3 * 1024 * 1024 / 3 * 4 + 4) : 'YWJjZA==' };
    }
  } };
  const parts = await collect(environment({ PDFLib: fake }).prepareParts({ name: 'denso.pdf', size: 10, arrayBuffer: async () => new ArrayBuffer(0) }));
  assert.deepEqual(parts.map((p) => p.documentContext.pageStart), [1,2,3]);
  assert.deepEqual(copies, [[0,1],[0],[1,2],[1],[2]]);
});

test('limites, PDF inválido e página indivisível são falhas explícitas', async () => {
  const receipt = environment();
  await assert.rejects(collect(receipt.prepareParts({ name: 'large.pdf', size: 51 * 1024 * 1024 })), /pdf_entrada_grande/);
  await assert.rejects(collect(receipt.prepareParts({ name: 'invalid.pdf', size: 3, arrayBuffer: async () => Buffer.from('bad') })), /pdf_protegido/);
  const fake = { PDFDocument: { load: async () => ({ getPageCount: () => 1 }), create: async () => ({ copyPages: async () => [0], addPage() {}, saveAsBase64: async () => 'A'.repeat(5 * 1024 * 1024) }) } };
  await assert.rejects(collect(environment({ PDFLib: fake }).prepareParts({ name: 'scan.pdf', size: 10, arrayBuffer: async () => new ArrayBuffer(0) })), /pdf_pagina_grande:1/);
});

test('captura alta preserva largura e cobre a imagem inteira com sobreposição de 120 pixels', async () => {
  const canvases = [], draws = [];
  class FileReader { readAsDataURL() { this.result = 'data:image/png;base64,YQ=='; this.onload(); } }
  class Image { constructor() { this.width = 1080; this.height = 12000; } set src(_) { this.onload(); } }
  const receipt = environment({ FileReader, Image, document: { addEventListener() {}, createElement() {
    const canvas = { width: 0, height: 0, getContext: () => ({ fillRect() {}, drawImage(...args) { draws.push(args); } }), toDataURL: () => 'data:image/jpeg;base64,YQ==' };
    canvases.push(canvas); return canvas;
  } } });
  const parts = await collect(receipt.prepareParts({ name: 'tall.png', size: 1000 }));
  assert.equal(parts.length, 6);
  assert.ok(canvases.every((c) => c.width === 1080 && c.height <= 2200));
  assert.equal(draws[0][2], 0);
  for (let i = 1; i < draws.length; i++) assert.equal(draws[i - 1][2] + draws[i - 1][4] - draws[i][2], 120);
  assert.equal(draws.at(-1)[2] + draws.at(-1)[4], 12000);
  assert.deepEqual(parts.map((p) => p.documentContext.pageStart), [1,2,3,4,5,6]);
});

test('imagem muito grande em pixels falha antes de criar canvases', async () => {
  let canvases = 0;
  class FileReader { readAsDataURL() { this.result = 'data:image/png;base64,YQ=='; this.onload(); } }
  class Image { constructor() { this.width = 1080; this.height = 100000; } set src(_) { this.onload(); } }
  const receipt = environment({ FileReader, Image, document: { addEventListener() {}, createElement() { canvases++; throw new Error('should not render'); } } });
  await assert.rejects(collect(receipt.prepareParts({ name: 'large.png', size: 1000 })), /imagem_pixels/);
  assert.equal(canvases, 0);
});
