// [RECORDER-DEMO] stub — see demo-stubs/README.md and PATCHES.md.
module.exports = new Proxy(
  {},
  {
    get() {
      throw new Error(
        "[recorder2skill] tesseract.js is stubbed out in this demo (Advanced-protection OCR is not part of the demo flow).",
      );
    },
  },
);
