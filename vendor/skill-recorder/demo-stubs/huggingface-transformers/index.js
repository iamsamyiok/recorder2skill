// [RECORDER-DEMO] stub — see demo-stubs/README.md and PATCHES.md.
module.exports = new Proxy(
  {},
  {
    get() {
      throw new Error(
        "[recorder2skill] @huggingface/transformers is stubbed out in this demo (narration transcription is not part of the demo flow).",
      );
    },
  },
);
