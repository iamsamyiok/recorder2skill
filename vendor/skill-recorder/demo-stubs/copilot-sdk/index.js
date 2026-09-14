// [RECORDER-DEMO] stub — see demo-stubs/README.md and PATCHES.md.
// CJS with shorthand exports so Node's cjs-module-lexer detects every named
// export (the vendored bundle is ESM and imports these by name at startup).
class CopilotClient {
  constructor() {
    refuse("CopilotClient")();
  }
}

function approveAll() {
  refuse("approveAll")();
}

const RuntimeConnection = {
  forStdio: refuse("RuntimeConnection.forStdio"),
};

module.exports = { CopilotClient, approveAll, RuntimeConnection };

function refuse(what) {
  return () => {
    throw new Error(
      `[recorder2skill] ${what} is stubbed out in this demo (Copilot features are not part of the demo flow).`,
    );
  };
}
