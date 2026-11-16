export const PROXY_VERSION: string;
export type ProxyStore = { load(name: string): any; save(name: string, value: unknown): void };
export type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
export function createProxy(options: { fetch?: typeof fetch; base?: string; token?: string | null; clickId?: string | null; store: ProxyStore }): {
  handle(message: { jsonrpc: "2.0"; id?: number | string; method: string; params?: any }): Promise<any>;
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
};
