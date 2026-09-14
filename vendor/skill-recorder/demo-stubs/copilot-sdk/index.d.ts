// [RECORDER-DEMO] Type surface for the demo stub — mirrors only the names the
// vendored code imports; everything is permissive on purpose. See demo-stubs/README.md.
export declare class CopilotClient {
  constructor(...args: unknown[]);
  listModels(): Promise<Array<Record<string, any>>>;
  [key: string]: any;
}
export declare function approveAll(...args: unknown[]): unknown;
export declare const RuntimeConnection: {
  forStdio: (...args: unknown[]) => unknown;
};
export interface Tool {
  handler?: (raw: Record<string, unknown>) => unknown;
  [key: string]: any;
}
export interface CopilotSession {
  [key: string]: any;
}
