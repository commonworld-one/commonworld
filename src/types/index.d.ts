// TypeScript type definitions for commonworld
// Resolves: Outbound link report

export interface CommonworldConfig {
  /** API key for authentication (required) */
  apiKey: string;
  /** Request timeout in milliseconds (default: 5000) */
  timeout?: number;
  /** Number of automatic retries on failure (default: 3) */
  retries?: number;
  /** Base URL for API requests */
  baseUrl?: string;
}

export interface CommonworldResult<T = unknown> {
  data: T;
  error: null;
  metadata: { timestamp: string; requestId: string };
}

export interface CommonworldError {
  data: null;
  error: { code: string; message: string; details?: unknown };
  metadata: { timestamp: string; requestId: string };
}

export type ApiResponse<T = unknown> = CommonworldResult<T> | CommonworldError;
