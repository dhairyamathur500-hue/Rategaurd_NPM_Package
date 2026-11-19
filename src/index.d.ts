import type { IncomingMessage, ServerResponse } from 'http';

export interface RateLimitInfo {
  limit: number;
  current: number;
  remaining: number;
  resetTime: Date;
}

declare global {
  namespace Express {
    interface Request {
      rateLimit?: RateLimitInfo;
    }
  }
}

export interface RateGuardOptions {
  /**
   * Time frame for which requests are checked/remembered in milliseconds.
   * @default 60000 (1 minute)
   */
  windowMs?: number;

  /**
   * The maximum number of connections/requests to allow during the `windowMs`.
   * Can also be a synchronous or asynchronous function returning a number.
   * @default 100
   */
  max?: number | ((req: any, res: any) => number | Promise<number>);

  /**
   * Custom error response body when rate limit is exceeded.
   * Can be a string, an object (JSON), or a function returning string or object.
   * @default 'Too many requests, please try again later.'
   */
  message?: string | Record<string, any> | ((req: any, res: any) => string | Record<string, any> | Promise<string | Record<string, any>>);

  /**
   * The HTTP status code to return when maximum request threshold is reached.
   * @default 429
   */
  statusCode?: number;

  /**
   * Whitelist of IP addresses that should never be rate-limited.
   * Can be an array of IP strings, a Set of IP strings, or a predicate function.
   */
  whitelist?: string[] | Set<string> | ((ip: string, req: any) => boolean | Promise<boolean>);

  /**
   * Exclude selected requests or routes from rate limiting.
   * Can be a predicate function, a RegExp, or an array of route path strings/prefixes.
   */
  skip?: ((req: any, res: any) => boolean | Promise<boolean>) | RegExp | (string | RegExp)[];

  /**
   * Custom function used to identify each client or request.
   * Defaults to extracting the client IP address from Express or headers.
   */
  keyGenerator?: (req: any) => string | Promise<string>;

  /**
   * Automatically prefixes tracking keys with the route path for per-route limits.
   * @default false
   */
  routeBased?: boolean;

  /**
   * Custom handler invoked when a request exceeds the limit.
   */
  handler?: (req: any, res: any, next: (err?: any) => void, options: RateGuardOptions) => void | Promise<void>;

  /**
   * Whether to send standard rate limit headers (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`).
   * @default true
   */
  standardHeaders?: boolean;

  /**
   * Alias for `standardHeaders`.
   * @default true
   */
  headers?: boolean;

  /**
   * Whether to send legacy rate limit headers (`X-RateLimit-*`).
   * @default false
   */
  legacyHeaders?: boolean;

  /**
   * Periodic sweep interval in milliseconds for removing expired entries from memory.
   * @default Math.min(windowMs, 60000)
   */
  cleanupIntervalMs?: number;

  /**
   * Optional custom storage implementation.
   */
  store?: any;
}

export interface RateGuardMiddleware {
  (req: any, res: any, next: (err?: any) => void): Promise<void>;
  resetKey(key: string): boolean;
  resetAll(): void;
  destroy(): void;
  store: MemoryStore;
}

export declare class MemoryStore {
  constructor(options?: { windowMs?: number; cleanupIntervalMs?: number });
  increment(key: string, windowMs?: number): { count: number; resetTime: number };
  get(key: string): { count: number; resetTime: number } | null;
  resetKey(key: string): boolean;
  resetAll(): void;
  cleanup(): number;
  destroy(): void;
  size(): number;
}

export declare function rateGuard(options?: RateGuardOptions): RateGuardMiddleware;
export declare const RateGuard: typeof rateGuard;

export declare function routes(
  routeMap: Record<string, RateGuardOptions>,
  defaultOptions?: RateGuardOptions
): (req: any, res: any, next: (err?: any) => void) => Promise<void>;

export default rateGuard;
