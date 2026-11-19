'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const rateGuard = require('../src/index');
const MemoryStore = require('../src/store');

/**
 * Creates mock req, res, next objects simulating Express / Node HTTP.
 */
function createMockHttp({ ip = '127.0.0.1', headers = {}, path = '/' } = {}) {
  const req = {
    ip,
    headers: { ...headers },
    path,
    socket: { remoteAddress: ip },
  };

  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    headersSent: false,
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = String(value);
    },
    getHeader(key) {
      return this.headers[key.toLowerCase()];
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(data) {
      this.body = data;
      this.headersSent = true;
      return this;
    },
    json(data) {
      this.body = data;
      this.headersSent = true;
      return this;
    },
    writeHead(code, headers = {}) {
      this.statusCode = code;
      for (const [k, v] of Object.entries(headers)) {
        this.setHeader(k, v);
      }
      return this;
    },
    end(data) {
      this.body = data;
      this.headersSent = true;
      return this;
    },
  };

  let nextCalled = false;
  let nextError = null;
  const next = (err) => {
    nextCalled = true;
    if (err) nextError = err;
  };

  return {
    req,
    res,
    next,
    wasNextCalled: () => nextCalled,
    getNextError: () => nextError,
  };
}

describe('RateGuard Middleware', () => {
  let middleware;

  afterEach(() => {
    if (middleware && typeof middleware.destroy === 'function') {
      middleware.destroy();
    }
  });

  describe('Normal Requests (Under Limit)', () => {
    it('should call next() and attach rateLimit information to req', async () => {
      middleware = rateGuard({ windowMs: 10000, max: 5 });
      const { req, res, next, wasNextCalled } = createMockHttp({ ip: '10.0.0.1' });

      await middleware(req, res, next);

      assert.strictEqual(wasNextCalled(), true);
      assert.ok(req.rateLimit);
      assert.strictEqual(req.rateLimit.limit, 5);
      assert.strictEqual(req.rateLimit.current, 1);
      assert.strictEqual(req.rateLimit.remaining, 4);
      assert.ok(req.rateLimit.resetTime instanceof Date);
    });

    it('should set standard RateLimit-* headers on response', async () => {
      middleware = rateGuard({ windowMs: 10000, max: 10 });
      const { req, res, next } = createMockHttp({ ip: '10.0.0.1' });

      await middleware(req, res, next);

      assert.strictEqual(res.getHeader('ratelimit-limit'), '10');
      assert.strictEqual(res.getHeader('ratelimit-remaining'), '9');
      assert.ok(res.getHeader('ratelimit-reset'));
      assert.strictEqual(res.getHeader('retry-after'), undefined);
    });

    it('should decrement remaining hits on subsequent calls within window', async () => {
      middleware = rateGuard({ windowMs: 10000, max: 3 });
      const ip = '10.0.0.2';

      for (let i = 1; i <= 3; i++) {
        const { req, res, next, wasNextCalled } = createMockHttp({ ip });
        await middleware(req, res, next);

        assert.strictEqual(wasNextCalled(), true);
        assert.strictEqual(req.rateLimit.current, i);
        assert.strictEqual(req.rateLimit.remaining, 3 - i);
        assert.strictEqual(res.getHeader('ratelimit-remaining'), String(3 - i));
      }
    });
  });

  describe('Exceeded Limits (HTTP 429)', () => {
    it('should respond with HTTP 429 and default message when limit exceeded', async () => {
      middleware = rateGuard({ windowMs: 10000, max: 2 });
      const ip = '10.0.0.3';

      // 1st request
      const h1 = createMockHttp({ ip });
      await middleware(h1.req, h1.res, h1.next);
      assert.strictEqual(h1.wasNextCalled(), true);

      // 2nd request (reaches limit)
      const h2 = createMockHttp({ ip });
      await middleware(h2.req, h2.res, h2.next);
      assert.strictEqual(h2.wasNextCalled(), true);

      // 3rd request (exceeds limit)
      const h3 = createMockHttp({ ip });
      await middleware(h3.req, h3.res, h3.next);

      assert.strictEqual(h3.wasNextCalled(), false, 'next() should not be called when limit exceeded');
      assert.strictEqual(h3.res.statusCode, 429);
      assert.strictEqual(h3.res.body, 'Too many requests, please try again later.');
      assert.strictEqual(h3.res.getHeader('ratelimit-remaining'), '0');
      assert.ok(Number(h3.res.getHeader('retry-after')) >= 1);
    });

    it('should continue to reject subsequent requests within the active window', async () => {
      middleware = rateGuard({ windowMs: 10000, max: 1 });
      const ip = '10.0.0.4';

      const h1 = createMockHttp({ ip });
      await middleware(h1.req, h1.res, h1.next);
      assert.strictEqual(h1.wasNextCalled(), true);

      // Exceeded calls
      for (let i = 0; i < 3; i++) {
        const h = createMockHttp({ ip });
        await middleware(h.req, h.res, h.next);
        assert.strictEqual(h.wasNextCalled(), false);
        assert.strictEqual(h.res.statusCode, 429);
      }
    });
  });

  describe('Separate IPs & Key Generation', () => {
    it('should track different IP addresses independently', async () => {
      middleware = rateGuard({ windowMs: 10000, max: 1 });

      const h1 = createMockHttp({ ip: '1.1.1.1' });
      await middleware(h1.req, h1.res, h1.next);
      assert.strictEqual(h1.wasNextCalled(), true);

      // 1.1.1.1 exceeds limit
      const h1Exceeded = createMockHttp({ ip: '1.1.1.1' });
      await middleware(h1Exceeded.req, h1Exceeded.res, h1Exceeded.next);
      assert.strictEqual(h1Exceeded.res.statusCode, 429);

      // 2.2.2.2 should still succeed
      const h2 = createMockHttp({ ip: '2.2.2.2' });
      await middleware(h2.req, h2.res, h2.next);
      assert.strictEqual(h2.wasNextCalled(), true);
      assert.strictEqual(h2.res.statusCode, 200);
    });

    it('should extract client IP from X-Forwarded-For header', async () => {
      middleware = rateGuard({ windowMs: 10000, max: 1 });
      const h1 = createMockHttp({
        ip: null,
        headers: { 'x-forwarded-for': '203.0.113.195, 70.41.3.18, 150.172.238.178' },
      });

      await middleware(h1.req, h1.res, h1.next);
      assert.strictEqual(h1.wasNextCalled(), true);

      // Verify key stored in store
      assert.ok(middleware.store.get('203.0.113.195'));
    });

    it('should extract client IP from X-Real-IP header', async () => {
      middleware = rateGuard({ windowMs: 10000, max: 1 });
      const h1 = createMockHttp({
        ip: null,
        headers: { 'x-real-ip': '198.51.100.42' },
      });

      await middleware(h1.req, h1.res, h1.next);
      assert.ok(middleware.store.get('198.51.100.42'));
    });

    it('should support custom synchronous and asynchronous keyGenerator', async () => {
      middleware = rateGuard({
        windowMs: 10000,
        max: 1,
        keyGenerator: async (req) => req.headers['x-api-key'] || 'anonymous',
      });

      const h1 = createMockHttp({ headers: { 'x-api-key': 'key_abc' } });
      await middleware(h1.req, h1.res, h1.next);
      assert.strictEqual(h1.wasNextCalled(), true);

      // Second request with same API key fails
      const h2 = createMockHttp({ headers: { 'x-api-key': 'key_abc' } });
      await middleware(h2.req, h2.res, h2.next);
      assert.strictEqual(h2.res.statusCode, 429);

      // Request with different API key succeeds
      const h3 = createMockHttp({ headers: { 'x-api-key': 'key_xyz' } });
      await middleware(h3.req, h3.res, h3.next);
      assert.strictEqual(h3.wasNextCalled(), true);
    });
  });

  describe('Expiration & Memory Store', () => {
    it('should reset count after windowMs expires', async () => {
      middleware = rateGuard({ windowMs: 50, max: 1 });
      const ip = '10.0.0.5';

      const h1 = createMockHttp({ ip });
      await middleware(h1.req, h1.res, h1.next);
      assert.strictEqual(h1.wasNextCalled(), true);

      // Immediately blocked
      const h2 = createMockHttp({ ip });
      await middleware(h2.req, h2.res, h2.next);
      assert.strictEqual(h2.res.statusCode, 429);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 60));

      // Should succeed again
      const h3 = createMockHttp({ ip });
      await middleware(h3.req, h3.res, h3.next);
      assert.strictEqual(h3.wasNextCalled(), true);
      assert.strictEqual(h3.req.rateLimit.current, 1);
    });

    it('should reset specific keys using resetKey()', async () => {
      middleware = rateGuard({ windowMs: 10000, max: 1 });
      const ip = '10.0.0.6';

      const h1 = createMockHttp({ ip });
      await middleware(h1.req, h1.res, h1.next);

      // Blocked
      const h2 = createMockHttp({ ip });
      await middleware(h2.req, h2.res, h2.next);
      assert.strictEqual(h2.res.statusCode, 429);

      // Reset key
      const resetResult = middleware.resetKey(ip);
      assert.strictEqual(resetResult, true);

      // Allowed again
      const h3 = createMockHttp({ ip });
      await middleware(h3.req, h3.res, h3.next);
      assert.strictEqual(h3.wasNextCalled(), true);
    });

    it('should reset all keys using resetAll()', async () => {
      middleware = rateGuard({ windowMs: 10000, max: 1 });

      await middleware(createMockHttp({ ip: '1.1.1.1' }).req, createMockHttp().res, () => {});
      await middleware(createMockHttp({ ip: '2.2.2.2' }).req, createMockHttp().res, () => {});
      assert.strictEqual(middleware.store.size(), 2);

      middleware.resetAll();
      assert.strictEqual(middleware.store.size(), 0);
    });

    it('should manually clean up expired records using cleanup()', async () => {
      const store = new MemoryStore({ windowMs: 40, cleanupIntervalMs: 0 });
      store.increment('key1', 40);
      store.increment('key2', 40);
      assert.strictEqual(store.size(), 2);

      await new Promise((resolve) => setTimeout(resolve, 60));
      const deleted = store.cleanup();
      assert.strictEqual(deleted, 2);
      assert.strictEqual(store.size(), 0);
      store.destroy();
    });

    it('should automatically sweep expired records via interval', async () => {
      const store = new MemoryStore({ windowMs: 30, cleanupIntervalMs: 40 });
      store.increment('auto1', 30);
      assert.strictEqual(store.size(), 1);

      // Wait for interval to fire and sweep
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.strictEqual(store.size(), 0);
      store.destroy();
    });
  });

  describe('Invalid Options Handling', () => {
    it('should throw TypeError when options is not an object', () => {
      assert.throws(() => rateGuard(123), TypeError);
      assert.throws(() => rateGuard('invalid'), TypeError);
      assert.throws(() => rateGuard(null), TypeError);
      assert.throws(() => rateGuard([]), TypeError);
    });

    it('should throw RangeError for invalid windowMs', () => {
      assert.throws(() => rateGuard({ windowMs: 0 }), RangeError);
      assert.throws(() => rateGuard({ windowMs: -500 }), RangeError);
      assert.throws(() => rateGuard({ windowMs: '1000' }), RangeError);
      assert.throws(() => rateGuard({ windowMs: NaN }), RangeError);
    });

    it('should throw TypeError for invalid max', () => {
      assert.throws(() => rateGuard({ max: -1 }), TypeError);
      assert.throws(() => rateGuard({ max: 'ten' }), TypeError);
      assert.throws(() => rateGuard({ max: NaN }), TypeError);
    });

    it('should throw RangeError for invalid statusCode', () => {
      assert.throws(() => rateGuard({ statusCode: 99 }), RangeError);
      assert.throws(() => rateGuard({ statusCode: 600 }), RangeError);
      assert.throws(() => rateGuard({ statusCode: '429' }), RangeError);
    });

    it('should throw TypeError for non-function keyGenerator', () => {
      assert.throws(() => rateGuard({ keyGenerator: 'invalid' }), TypeError);
    });

    it('should throw TypeError for non-function skip', () => {
      assert.throws(() => rateGuard({ skip: true }), TypeError);
    });

    it('should throw TypeError for non-function handler', () => {
      assert.throws(() => rateGuard({ handler: 'custom' }), TypeError);
    });

    it('should throw TypeError for invalid cleanupIntervalMs', () => {
      assert.throws(() => rateGuard({ cleanupIntervalMs: -10 }), RangeError);
      assert.throws(() => rateGuard({ cleanupIntervalMs: '500' }), RangeError);
    });

    it('should throw TypeError for invalid whitelist', () => {
      assert.throws(() => rateGuard({ whitelist: 123 }), TypeError);
      assert.throws(() => rateGuard({ whitelist: '127.0.0.1' }), TypeError);
    });

    it('should throw TypeError for invalid routeBased', () => {
      assert.throws(() => rateGuard({ routeBased: 'yes' }), TypeError);
    });

    it('should throw TypeError for non-boolean standardHeaders or legacyHeaders', () => {
      assert.throws(() => rateGuard({ standardHeaders: 'yes' }), TypeError);
      assert.throws(() => rateGuard({ legacyHeaders: 1 }), TypeError);
      assert.throws(() => rateGuard({ headers: 'true' }), TypeError);
    });
  });

  describe('Custom Configurations', () => {
    it('should support custom JSON object error message', async () => {
      const customPayload = {
        success: false,
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Daily request quota reached.',
      };

      middleware = rateGuard({
        windowMs: 10000,
        max: 1,
        message: customPayload,
      });

      const ip = '10.0.0.7';
      await middleware(createMockHttp({ ip }).req, createMockHttp({ ip }).res, () => {});

      const h2 = createMockHttp({ ip });
      await middleware(h2.req, h2.res, h2.next);

      assert.strictEqual(h2.res.statusCode, 429);
      assert.deepStrictEqual(h2.res.body, customPayload);
    });

    it('should support dynamic message function', async () => {
      middleware = rateGuard({
        windowMs: 10000,
        max: 1,
        message: (req) => ({ error: `IP ${req.ip} has exceeded quota.` }),
      });

      const ip = '192.168.1.99';
      await middleware(createMockHttp({ ip }).req, createMockHttp({ ip }).res, () => {});

      const h2 = createMockHttp({ ip });
      await middleware(h2.req, h2.res, h2.next);

      assert.deepStrictEqual(h2.res.body, { error: 'IP 192.168.1.99 has exceeded quota.' });
    });

    it('should support custom status code', async () => {
      middleware = rateGuard({
        windowMs: 10000,
        max: 1,
        statusCode: 420,
      });

      const ip = '10.0.0.8';
      await middleware(createMockHttp({ ip }).req, createMockHttp({ ip }).res, () => {});

      const h2 = createMockHttp({ ip });
      await middleware(h2.req, h2.res, h2.next);

      assert.strictEqual(h2.res.statusCode, 420);
    });

    it('should invoke custom handler when limit is exceeded', async () => {
      let customHandlerInvoked = false;
      let passedOptions = null;

      middleware = rateGuard({
        windowMs: 10000,
        max: 1,
        handler: (req, res, next, opts) => {
          customHandlerInvoked = true;
          passedOptions = opts;
          res.status(429).send('Custom rate limit handler response');
        },
      });

      const ip = '10.0.0.9';
      await middleware(createMockHttp({ ip }).req, createMockHttp({ ip }).res, () => {});

      const h2 = createMockHttp({ ip });
      await middleware(h2.req, h2.res, h2.next);

      assert.strictEqual(customHandlerInvoked, true);
      assert.ok(passedOptions);
      assert.strictEqual(h2.res.body, 'Custom rate limit handler response');
    });

    it('should bypass rate limiting when skip function returns true', async () => {
      middleware = rateGuard({
        windowMs: 10000,
        max: 1,
        skip: (req) => req.headers['x-bypass-token'] === 'secret-admin-token',
      });

      const ip = '10.0.0.10';

      // First call (consumes token)
      const h1 = createMockHttp({ ip });
      await middleware(h1.req, h1.res, h1.next);
      assert.strictEqual(h1.wasNextCalled(), true);

      // Normal second call fails
      const h2 = createMockHttp({ ip });
      await middleware(h2.req, h2.res, h2.next);
      assert.strictEqual(h2.res.statusCode, 429);

      // Bypassed request succeeds even though quota was exceeded
      const h3 = createMockHttp({
        ip,
        headers: { 'x-bypass-token': 'secret-admin-token' },
      });
      await middleware(h3.req, h3.res, h3.next);
      assert.strictEqual(h3.wasNextCalled(), true);
      assert.strictEqual(h3.res.statusCode, 200);
    });

    it('should support dynamic max as a function', async () => {
      middleware = rateGuard({
        windowMs: 10000,
        max: (req) => (req.headers['x-tier'] === 'premium' ? 3 : 1),
      });

      // Free tier gets 1
      const free1 = createMockHttp({ ip: 'free-user' });
      await middleware(free1.req, free1.res, free1.next);
      assert.strictEqual(free1.wasNextCalled(), true);

      const free2 = createMockHttp({ ip: 'free-user' });
      await middleware(free2.req, free2.res, free2.next);
      assert.strictEqual(free2.res.statusCode, 429);

      // Premium tier gets 3
      const premIp = 'premium-user';
      for (let i = 0; i < 3; i++) {
        const h = createMockHttp({ ip: premIp, headers: { 'x-tier': 'premium' } });
        await middleware(h.req, h.res, h.next);
        assert.strictEqual(h.wasNextCalled(), true);
      }

      const premBlocked = createMockHttp({ ip: premIp, headers: { 'x-tier': 'premium' } });
      await middleware(premBlocked.req, premBlocked.res, premBlocked.next);
      assert.strictEqual(premBlocked.res.statusCode, 429);
    });

    it('should set legacy X-RateLimit-* headers when legacyHeaders is true', async () => {
      middleware = rateGuard({
        windowMs: 10000,
        max: 5,
        legacyHeaders: true,
      });

      const { req, res, next } = createMockHttp({ ip: '10.0.0.11' });
      await middleware(req, res, next);

      assert.strictEqual(res.getHeader('x-ratelimit-limit'), '5');
      assert.strictEqual(res.getHeader('x-ratelimit-remaining'), '4');
      assert.ok(res.getHeader('x-ratelimit-reset'));
    });

    it('should omit standard headers when standardHeaders is false', async () => {
      middleware = rateGuard({
        windowMs: 10000,
        max: 5,
        standardHeaders: false,
      });

      const { req, res, next } = createMockHttp({ ip: '10.0.0.12' });
      await middleware(req, res, next);

      assert.strictEqual(res.getHeader('ratelimit-limit'), undefined);
      assert.strictEqual(res.getHeader('ratelimit-remaining'), undefined);
      assert.strictEqual(res.getHeader('ratelimit-reset'), undefined);
    });

    it('should isolate limits between different route middleware instances', async () => {
      const publicLimiter = rateGuard({ windowMs: 10000, max: 10 });
      const sensitiveLimiter = rateGuard({ windowMs: 10000, max: 1 });

      const ip = '10.0.0.13';

      // Hit sensitive limiter once (consumes limit)
      const s1 = createMockHttp({ ip });
      await sensitiveLimiter(s1.req, s1.res, s1.next);
      assert.strictEqual(s1.wasNextCalled(), true);

      // Sensitive limiter blocks second hit
      const s2 = createMockHttp({ ip });
      await sensitiveLimiter(s2.req, s2.res, s2.next);
      assert.strictEqual(s2.res.statusCode, 429);

      // Public limiter is unaffected and allows request
      const p1 = createMockHttp({ ip });
      await publicLimiter(p1.req, p1.res, p1.next);
      assert.strictEqual(p1.wasNextCalled(), true);

      publicLimiter.destroy();
      sensitiveLimiter.destroy();
    });

    it('should forward errors to next(err) if keyGenerator fails', async () => {
      middleware = rateGuard({
        keyGenerator: () => {
          throw new Error('Key generator failure');
        },
      });

      const { req, res, next, getNextError } = createMockHttp();
      await middleware(req, res, next);

      assert.ok(getNextError());
      assert.strictEqual(getNextError().message, 'Key generator failure');
    });
  });

  describe('Feature 1: Custom Rate-Limit Messages & Status Codes', () => {
    it('should return custom status code 403 with JSON payload', async () => {
      middleware = rateGuard({
        windowMs: 10000,
        max: 1,
        statusCode: 403,
        message: { error: 'Forbidden', reason: 'Rate limit exceeded' },
      });

      const ip = '10.10.10.1';
      await middleware(createMockHttp({ ip }).req, createMockHttp({ ip }).res, () => {});

      const h2 = createMockHttp({ ip });
      await middleware(h2.req, h2.res, h2.next);

      assert.strictEqual(h2.res.statusCode, 403);
      assert.deepStrictEqual(h2.res.body, { error: 'Forbidden', reason: 'Rate limit exceeded' });
    });

    it('should support async message function returning custom text', async () => {
      middleware = rateGuard({
        windowMs: 10000,
        max: 1,
        statusCode: 429,
        message: async (req) => `IP ${req.ip} exceeded quota. Try later.`,
      });

      const ip = '10.10.10.2';
      await middleware(createMockHttp({ ip }).req, createMockHttp({ ip }).res, () => {});

      const h2 = createMockHttp({ ip });
      await middleware(h2.req, h2.res, h2.next);

      assert.strictEqual(h2.res.statusCode, 429);
      assert.strictEqual(h2.res.body, 'IP 10.10.10.2 exceeded quota. Try later.');
    });
  });

  describe('Feature 2: Whitelist IPs (Never Rate-Limited)', () => {
    it('should never rate-limit IPs specified in an array whitelist', async () => {
      middleware = rateGuard({
        windowMs: 10000,
        max: 2,
        whitelist: ['192.168.1.50', '10.0.0.99'],
      });

      // Whitelisted IP makes 5 requests without getting blocked
      for (let i = 0; i < 5; i++) {
        const h = createMockHttp({ ip: '192.168.1.50' });
        await middleware(h.req, h.res, h.next);
        assert.strictEqual(h.wasNextCalled(), true);
        assert.strictEqual(h.res.statusCode, 200);
      }

      // Non-whitelisted IP is blocked on 3rd request
      const nonWhiteIp = '192.168.1.60';
      const n1 = createMockHttp({ ip: nonWhiteIp });
      await middleware(n1.req, n1.res, n1.next);
      assert.strictEqual(n1.wasNextCalled(), true);

      const n2 = createMockHttp({ ip: nonWhiteIp });
      await middleware(n2.req, n2.res, n2.next);
      assert.strictEqual(n2.wasNextCalled(), true);

      const n3 = createMockHttp({ ip: nonWhiteIp });
      await middleware(n3.req, n3.res, n3.next);
      assert.strictEqual(n3.wasNextCalled(), false);
      assert.strictEqual(n3.res.statusCode, 429);
    });

    it('should support Set-based whitelist', async () => {
      middleware = rateGuard({
        windowMs: 10000,
        max: 1,
        whitelist: new Set(['127.0.0.1']),
      });

      for (let i = 0; i < 3; i++) {
        const h = createMockHttp({ ip: '127.0.0.1' });
        await middleware(h.req, h.res, h.next);
        assert.strictEqual(h.wasNextCalled(), true);
      }
    });

    it('should support function-based whitelist predicate', async () => {
      middleware = rateGuard({
        windowMs: 10000,
        max: 1,
        whitelist: (ip) => ip.startsWith('172.16.'),
      });

      const h1 = createMockHttp({ ip: '172.16.0.4' });
      await middleware(h1.req, h1.res, h1.next);
      assert.strictEqual(h1.wasNextCalled(), true);

      const h2 = createMockHttp({ ip: '172.16.0.4' });
      await middleware(h2.req, h2.res, h2.next);
      assert.strictEqual(h2.wasNextCalled(), true);

      // Other IP blocked on second request
      const other1 = createMockHttp({ ip: '8.8.8.8' });
      await middleware(other1.req, other1.res, other1.next);
      assert.strictEqual(other1.wasNextCalled(), true);

      const other2 = createMockHttp({ ip: '8.8.8.8' });
      await middleware(other2.req, other2.res, other2.next);
      assert.strictEqual(other2.res.statusCode, 429);
    });
  });

  describe('Feature 3: Different Rate Limits for Different Express Routes', () => {
    it('should support routeBased option to isolate limits per endpoint for the same IP', async () => {
      middleware = rateGuard({
        windowMs: 10000,
        max: 1,
        routeBased: true,
      });

      const ip = '10.20.30.40';

      // Hit /api/search once (consumes limit for this route)
      const h1 = createMockHttp({ ip, path: '/api/search' });
      await middleware(h1.req, h1.res, h1.next);
      assert.strictEqual(h1.wasNextCalled(), true);

      // Second hit to /api/search is blocked
      const h2 = createMockHttp({ ip, path: '/api/search' });
      await middleware(h2.req, h2.res, h2.next);
      assert.strictEqual(h2.res.statusCode, 429);

      // Same IP hitting /api/users is NOT blocked because it is a different route
      const h3 = createMockHttp({ ip, path: '/api/users' });
      await middleware(h3.req, h3.res, h3.next);
      assert.strictEqual(h3.wasNextCalled(), true);
      assert.strictEqual(h3.res.statusCode, 200);
    });

    it('should support rateGuard.routes() multi-route router helper', async () => {
      const routerLimiter = rateGuard.routes(
        {
          '/api/auth/login': { max: 2, windowMs: 10000 },
          '/api/public': { max: 5, windowMs: 10000 },
        },
        { max: 10, windowMs: 10000 }
      );

      const ip = '192.168.1.88';

      // Login route hits limit after 2
      const l1 = createMockHttp({ ip, path: '/api/auth/login' });
      await routerLimiter(l1.req, l1.res, l1.next);
      assert.strictEqual(l1.wasNextCalled(), true);

      const l2 = createMockHttp({ ip, path: '/api/auth/login' });
      await routerLimiter(l2.req, l2.res, l2.next);
      assert.strictEqual(l2.wasNextCalled(), true);

      const l3 = createMockHttp({ ip, path: '/api/auth/login' });
      await routerLimiter(l3.req, l3.res, l3.next);
      assert.strictEqual(l3.wasNextCalled(), false);
      assert.strictEqual(l3.res.statusCode, 429);

      // Public route is still allowed under its own limit (max 5)
      const p1 = createMockHttp({ ip, path: '/api/public' });
      await routerLimiter(p1.req, p1.res, p1.next);
      assert.strictEqual(p1.wasNextCalled(), true);
    });

    it('should throw TypeError if rateGuard.routes() receives invalid argument', () => {
      assert.throws(() => rateGuard.routes(null), TypeError);
      assert.throws(() => rateGuard.routes('invalid'), TypeError);
    });
  });

  describe('Feature 4: Rate-Limit Headers (Limit, Remaining, Reset Time)', () => {
    it('should set headers: limit, remaining, reset time, and retry-after', async () => {
      middleware = rateGuard({
        windowMs: 10000,
        max: 2,
        headers: true,
      });

      const ip = '10.0.0.80';
      const h1 = createMockHttp({ ip });
      await middleware(h1.req, h1.res, h1.next);

      assert.strictEqual(h1.res.getHeader('ratelimit-limit'), '2');
      assert.strictEqual(h1.res.getHeader('ratelimit-remaining'), '1');
      assert.ok(Number(h1.res.getHeader('ratelimit-reset')) >= 0);
      assert.strictEqual(h1.res.getHeader('retry-after'), undefined);

      // Request 2
      const h2 = createMockHttp({ ip });
      await middleware(h2.req, h2.res, h2.next);
      assert.strictEqual(h2.res.getHeader('ratelimit-remaining'), '0');

      // Request 3 (exceeded)
      const h3 = createMockHttp({ ip });
      await middleware(h3.req, h3.res, h3.next);
      assert.strictEqual(h3.res.statusCode, 429);
      assert.strictEqual(h3.res.getHeader('ratelimit-remaining'), '0');
      assert.ok(Number(h3.res.getHeader('retry-after')) >= 1);
    });

    it('should respect headers: false alias to disable headers', async () => {
      middleware = rateGuard({
        windowMs: 10000,
        max: 5,
        headers: false,
      });

      const h = createMockHttp({ ip: '10.0.0.81' });
      await middleware(h.req, h.res, h.next);

      assert.strictEqual(h.res.getHeader('ratelimit-limit'), undefined);
      assert.strictEqual(h.res.getHeader('ratelimit-remaining'), undefined);
      assert.strictEqual(h.res.getHeader('ratelimit-reset'), undefined);
    });
  });

  describe('Feature 5: Skip Option to Exclude Selected Requests or Routes', () => {
    it('should skip rate limiting when skip is an array of path prefixes', async () => {
      middleware = rateGuard({
        windowMs: 10000,
        max: 1,
        skip: ['/health', '/metrics'],
      });

      const ip = '10.0.0.90';

      // Health endpoint is skipped
      for (let i = 0; i < 4; i++) {
        const h = createMockHttp({ ip, path: '/health' });
        await middleware(h.req, h.res, h.next);
        assert.strictEqual(h.wasNextCalled(), true);
      }

      // Non-skipped endpoint is tracked and throttled
      const api1 = createMockHttp({ ip, path: '/api/data' });
      await middleware(api1.req, api1.res, api1.next);
      assert.strictEqual(api1.wasNextCalled(), true);

      const api2 = createMockHttp({ ip, path: '/api/data' });
      await middleware(api2.req, api2.res, api2.next);
      assert.strictEqual(api2.res.statusCode, 429);
    });

    it('should skip rate limiting when skip is a RegExp', async () => {
      middleware = rateGuard({
        windowMs: 10000,
        max: 1,
        skip: /^\/(health|status)/,
      });

      const ip = '10.0.0.91';

      const h = createMockHttp({ ip, path: '/status' });
      await middleware(h.req, h.res, h.next);
      assert.strictEqual(h.wasNextCalled(), true);
    });

    it('should skip rate limiting when skip function returns true', async () => {
      middleware = rateGuard({
        windowMs: 10000,
        max: 1,
        skip: (req) => req.headers['x-skip'] === 'true',
      });

      const ip = '10.0.0.92';

      for (let i = 0; i < 3; i++) {
        const h = createMockHttp({ ip, headers: { 'x-skip': 'true' } });
        await middleware(h.req, h.res, h.next);
        assert.strictEqual(h.wasNextCalled(), true);
      }
    });
  });

  describe('Native Node.js HTTP ServerResponse Integration', () => {
    const { Duplex } = require('node:stream');

    function createRealNodeHttp({ ip = '127.0.0.1', headers = {} } = {}) {
      const socket = new Duplex({
        read() {},
        write(chunk, encoding, callback) {
          this.output = (this.output || '') + chunk.toString();
          callback();
        },
      });
      socket.remoteAddress = ip;

      const req = new http.IncomingMessage(socket);
      req.headers = { ...headers };
      req.socket = socket;

      const res = new http.ServerResponse(req);
      res.assignSocket(socket);

      return { req, res, socket };
    }

    it('should operate correctly with real Node.js IncomingMessage and ServerResponse', async () => {
      middleware = rateGuard({
        windowMs: 5000,
        max: 2,
        message: { error: 'Rate limit exceeded on test server' },
      });

      // Request 1: allowed
      const h1 = createRealNodeHttp({ ip: '192.168.1.100' });
      let next1Called = false;
      await middleware(h1.req, h1.res, () => {
        next1Called = true;
      });
      assert.strictEqual(next1Called, true);
      assert.strictEqual(h1.res.getHeader('ratelimit-limit'), '2');
      assert.strictEqual(h1.res.getHeader('ratelimit-remaining'), '1');

      // Request 2: allowed
      const h2 = createRealNodeHttp({ ip: '192.168.1.100' });
      let next2Called = false;
      await middleware(h2.req, h2.res, () => {
        next2Called = true;
      });
      assert.strictEqual(next2Called, true);
      assert.strictEqual(h2.res.getHeader('ratelimit-remaining'), '0');

      // Request 3: blocked with HTTP 429 and JSON body
      const h3 = createRealNodeHttp({ ip: '192.168.1.100' });
      let next3Called = false;
      await middleware(h3.req, h3.res, () => {
        next3Called = true;
      });
      assert.strictEqual(next3Called, false);
      assert.strictEqual(h3.res.statusCode, 429);
      assert.strictEqual(h3.res.getHeader('content-type'), 'application/json');
      assert.ok(h3.res.getHeader('retry-after'));
      assert.strictEqual(h3.res.headersSent, true);
    });
  });

  describe('CommonJS & Module Export Compatibility', () => {
    it('should support default export and named destructuring', () => {
      const defaultExport = require('../src/index');
      const { rateGuard: namedRateGuard, MemoryStore: namedMemoryStore, RateGuard: namedClassGuard } = require('../src/index');

      assert.strictEqual(typeof defaultExport, 'function');
      assert.strictEqual(typeof namedRateGuard, 'function');
      assert.strictEqual(typeof namedMemoryStore, 'function');
      assert.strictEqual(typeof namedClassGuard, 'function');
      assert.strictEqual(defaultExport, namedRateGuard);
      assert.strictEqual(namedRateGuard, namedClassGuard);
    });
  });

  describe('Edge Cases & Advanced Configurations', () => {
    it('should immediately block requests when max is 0', async () => {
      middleware = rateGuard({ windowMs: 10000, max: 0 });
      const { req, res, next, wasNextCalled } = createMockHttp({ ip: '10.0.0.99' });

      await middleware(req, res, next);

      assert.strictEqual(wasNextCalled(), false);
      assert.strictEqual(res.statusCode, 429);
      assert.strictEqual(res.getHeader('ratelimit-limit'), '0');
      assert.strictEqual(res.getHeader('ratelimit-remaining'), '0');
    });

    it('should fall back to 127.0.0.1 when req has no ip, headers, socket or connection', async () => {
      middleware = rateGuard({ windowMs: 10000, max: 1 });
      const req = { headers: {} };
      const res = {
        statusCode: 200,
        headers: {},
        setHeader(k, v) { this.headers[k.toLowerCase()] = String(v); },
        getHeader(k) { return this.headers[k.toLowerCase()]; },
      };
      let called = false;

      await middleware(req, res, () => { called = true; });

      assert.strictEqual(called, true);
      assert.ok(middleware.store.get('127.0.0.1'));
    });

    it('should combine baseUrl and path when routeBased is enabled', async () => {
      middleware = rateGuard({ windowMs: 10000, max: 1, routeBased: true });

      const req1 = { ip: '1.2.3.4', baseUrl: '/api/v1', path: '/users', headers: {} };
      const res1 = { statusCode: 200, headers: {}, setHeader() {} };
      let called1 = false;
      await middleware(req1, res1, () => { called1 = true; });
      assert.strictEqual(called1, true);

      // Verify key was formed as 1.2.3.4:/api/v1/users
      assert.ok(middleware.store.get('1.2.3.4:/api/v1/users'));

      // Different subpath for same IP is allowed
      const req2 = { ip: '1.2.3.4', baseUrl: '/api/v1', path: '/posts', headers: {} };
      const res2 = { statusCode: 200, headers: {}, setHeader() {} };
      let called2 = false;
      await middleware(req2, res2, () => { called2 = true; });
      assert.strictEqual(called2, true);
    });

    it('should match routes in rateGuard.routes() when baseUrl is present', async () => {
      const routerLimiter = rateGuard.routes({
        '/api/v1/items': { max: 1, windowMs: 10000 },
      });

      const req1 = { ip: '5.5.5.5', baseUrl: '/api/v1', path: '/items', headers: {} };
      const res1 = { statusCode: 200, headers: {}, setHeader() {} };
      let called1 = false;
      await routerLimiter(req1, res1, () => { called1 = true; });
      assert.strictEqual(called1, true);

      const req2 = { ip: '5.5.5.5', baseUrl: '/api/v1', path: '/items', headers: {} };
      const res2 = {
        statusCode: 200,
        headers: {},
        setHeader(k, v) { this.headers[k.toLowerCase()] = String(v); },
        status(c) { this.statusCode = c; return this; },
        send(b) { this.body = b; },
      };
      let called2 = false;
      await routerLimiter(req2, res2, () => { called2 = true; });
      assert.strictEqual(called2, false);
      assert.strictEqual(res2.statusCode, 429);
    });

    it('should skip routes in shouldSkip when baseUrl is present', async () => {
      middleware = rateGuard({
        windowMs: 10000,
        max: 1,
        skip: ['/api/v1/health'],
      });

      const req = { ip: '6.6.6.6', baseUrl: '/api/v1', path: '/health', headers: {} };
      const res = { statusCode: 200, headers: {}, setHeader() {} };
      let called = false;
      await middleware(req, res, () => { called = true; });
      assert.strictEqual(called, true);
      assert.strictEqual(middleware.store.size(), 0);
    });

    it('should correctly handle store.get() for non-existent and expired keys', async () => {
      const store = new MemoryStore({ windowMs: 40 });
      assert.strictEqual(store.get('unknown-key'), null);

      store.increment('temp-key', 30);
      assert.strictEqual(store.get('temp-key').count, 1);

      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.strictEqual(store.get('temp-key'), null);
      store.destroy();
    });

    it('should return false for store.resetKey() when key does not exist', () => {
      const store = new MemoryStore();
      assert.strictEqual(store.resetKey('non-existent'), false);
      store.destroy();
    });

    it('should support dynamic async max returning Promise<number>', async () => {
      middleware = rateGuard({
        windowMs: 10000,
        max: async () => 2,
      });

      const { req: r1, res: s1, next: n1, wasNextCalled: w1 } = createMockHttp({ ip: '7.7.7.7' });
      await middleware(r1, s1, n1);
      assert.strictEqual(w1(), true);

      const { req: r2, res: s2, next: n2, wasNextCalled: w2 } = createMockHttp({ ip: '7.7.7.7' });
      await middleware(r2, s2, n2);
      assert.strictEqual(w2(), true);

      const { req: r3, res: s3, next: n3, wasNextCalled: w3 } = createMockHttp({ ip: '7.7.7.7' });
      await middleware(r3, s3, n3);
      assert.strictEqual(w3(), false);
      assert.strictEqual(s3.statusCode, 429);
    });

    it('should emit both standard and legacy headers simultaneously when requested', async () => {
      middleware = rateGuard({
        windowMs: 10000,
        max: 5,
        standardHeaders: true,
        legacyHeaders: true,
      });

      const { req, res, next } = createMockHttp({ ip: '8.8.8.8' });
      await middleware(req, res, next);

      assert.strictEqual(res.getHeader('ratelimit-limit'), '5');
      assert.strictEqual(res.getHeader('x-ratelimit-limit'), '5');
      assert.strictEqual(res.getHeader('ratelimit-remaining'), '4');
      assert.strictEqual(res.getHeader('x-ratelimit-remaining'), '4');
    });

    it('should forward errors to next(err) if custom message function throws', async () => {
      middleware = rateGuard({
        windowMs: 10000,
        max: 0,
        message: () => {
          throw new Error('Message evaluation failed');
        },
      });

      const { req, res, next, getNextError } = createMockHttp({ ip: '9.9.9.9' });
      await middleware(req, res, next);

      assert.ok(getNextError());
      assert.strictEqual(getNextError().message, 'Message evaluation failed');
    });

    it('should not write headers or body if res.headersSent is already true', async () => {
      middleware = rateGuard({ windowMs: 10000, max: 0 });
      const { req, res, next } = createMockHttp({ ip: '11.11.11.11' });
      res.headersSent = true;

      await middleware(req, res, next);

      assert.strictEqual(res.body, null);
    });
  });
});
