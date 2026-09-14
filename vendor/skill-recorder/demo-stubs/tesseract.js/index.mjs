// [RECORDER-DEMO] stub — see demo-stubs/README.md and PATCHES.md.
// ESM with the named exports the vendored code touches (sensitive/ocr.ts uses
// `tesseract.createWorker(...)` on the import namespace), so a misroute fails
// loudly instead of with a confusing TypeError.
const msg = (what) => () => {
  throw new Error(
    `[recorder2skill] ${what} is stubbed out in this demo (Advanced-protection OCR is not part of the demo flow).`,
  );
};

export const createWorker = msg("createWorker");

export const recognize = msg("recognize");

export default new Proxy({}, { get: msg("tesseract.js") });
