// [RECORDER-DEMO] stub — see demo-stubs/README.md and PATCHES.md.
// ESM with the named exports the vendored code touches (whisper.ts uses
// `tf.env` and `tf.pipeline(...)` on the import namespace), so a misroute
// fails loudly instead of with a confusing TypeError.
const msg = (what) => () => {
  throw new Error(
    `[recorder2skill] ${what} is stubbed out in this demo (narration transcription is not part of the demo flow).`,
  );
};

export const env = new Proxy(
  {},
  { get: msg("env"), set: msg("env") },
);

export const pipeline = msg("pipeline");

export default new Proxy({}, { get: msg("@huggingface/transformers") });
