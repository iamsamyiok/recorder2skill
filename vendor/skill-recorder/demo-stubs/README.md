# demo-stubs

[RECORDER-DEMO] Tiny local packages that replace three heavy optional-feature
dependencies at install time (see PATCHES.md):

| Stub | Replaces | Saves | Real feature (unused by the demo) |
| --- | --- | --- | --- |
| `copilot-sdk` | `@github/copilot-sdk` | ~587 MB | Copilot-powered describer / skill builder |
| `huggingface-transformers` | `@huggingface/transformers` | ~340 MB (incl. onnxruntime) | Narration transcription |
| `tesseract.js` + `tesseract.js-core` | `tesseract.js`, `tesseract.js-core` | ~44 MB | Advanced-protection OCR (opt-in) |

Each stub throws a clear error if its feature is ever actually invoked, so a
misconfiguration fails loudly instead of silently misbehaving. The recording,
frame-extraction, dHash-dedupe, event-collection and bundling pipeline —
everything the demo uses — never touches these packages.
