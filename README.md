# RateGuard

An in-memory rate-limiting middleware designed for Express.js applications. RateGuard protects HTTP endpoints against denial-of-service attempts, brute-force requests, and API abuse using standard JavaScript Map storage with automatic expiration and cleanup.

---

## Highlights

- **Zero External Dependencies**: Operates entirely with Node.js built-ins.
- **Configurable Messages & Status Codes**: Custom JSON or text responses with status code control (e.g. 429, 403).
- **IP Whitelisting**: Exclude trusted IP addresses from all rate-limiting constraints.
- **Route-Specific Limits**: Apply different limits to different Express endpoints or routers.
- **Standard Headers**: Sets `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and `Retry-After`.
- **Flexible Skip Option**: Bypass rate-limiting for specific routes, methods, or health checks.
- **In-Memory Map Storage**: Fast key-value tracking with periodic cleanup of stale records.
- **TypeScript Support**: Bundled type declarations (`src/index.d.ts`).

---

## Installation

```bash
npm install rateguard
```

*(RateGuard supports Express 4.x, Express 5.x, and native Node.js HTTP servers)*

---

## Quick Start

```javascript
const express = require('express');
const rateGuard = require('rateguard');

const app = express();

// Apply a global rate limit: 100 requests every 15 minutes
const apiLimiter = rateGuard({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});

app.use('/api', apiLimiter);

app.get('/api/data', (req, res) => {
  res.json({ message: 'Success', rateLimit: req.rateLimit });
});

app.listen(3000, () => console.log('Server running on port 3000'));
```

---

## The 5 Core Features & Examples

### 1. Custom Messages and Configurable Status Codes

Customize the error response and HTTP status code when a user exceeds their limit:

```javascript
const customLimiter = rateGuard({
  windowMs: 15 * 60 * 1000,
  max: 10,
  statusCode: 403, // Change default 429 to 403 (or any custom code)
  message: {
    success: false,
    code: 'QUOTA_EXCEEDED',
    message: 'You have reached your request limit. Please wait 15 minutes.'
  }
});
```

You can also use a dynamic message function:
```javascript
const dynamicLimiter = rateGuard({
  max: 20,
  message: (req) => `Client ${req.ip} has exceeded their allocated quota.`
});
```

---

### 2. Whitelist IPs (Never Rate-Limited)

Specify IP addresses that should completely bypass rate limiting:

```javascript
const limiterWithWhitelist = rateGuard({
  windowMs: 60 * 1000,
  max: 20,
  // Array of trusted IPs
  whitelist: ['127.0.0.1', '192.168.1.100', '10.0.0.1']
});
```

You can also pass a `Set` or a custom predicate function:
```javascript
// Whitelist entire internal subnet
const subnetLimiter = rateGuard({
  whitelist: (ip) => ip.startsWith('10.0.')
});
```

---

### 3. Different Rate Limits for Different Routes

#### Option A: Distinct middleware instances per route (Recommended)

```javascript
// Strict limit for login authentication (5 attempts / 15 mins)
const loginLimiter = rateGuard({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts. Please try again later.' }
});

// Relaxed limit for public search (60 requests / 1 min)
const searchLimiter = rateGuard({
  windowMs: 60 * 1000,
  max: 60
});

app.post('/api/auth/login', loginLimiter, handleLogin);
app.get('/api/search', searchLimiter, handleSearch);
```

#### Option B: Multi-route map helper

```javascript
app.use(rateGuard.routes({
  '/api/auth/login': { max: 5, windowMs: 15 * 60 * 1000 },
  '/api/search': { max: 60, windowMs: 60 * 1000 }
}, { max: 100 })); // Optional fallback limit for other routes
```

#### Option C: `routeBased: true`

Set `routeBased: true` on a single middleware to automatically scope hit counts to each individual endpoint per client IP:
```javascript
app.use(rateGuard({ max: 10, routeBased: true }));
```

---

### 4. Rate-Limit Headers (Limit, Remaining & Reset Time)

By default (`headers: true`), RateGuard attaches standard rate-limit headers to every response:

- `RateLimit-Limit`: Maximum requests permitted in the window (e.g. `100`).
- `RateLimit-Remaining`: Remaining request quota for the caller (e.g. `98`).
- `RateLimit-Reset`: Number of seconds until the current quota window resets (e.g. `45`).
- `Retry-After`: Automatically attached when HTTP 429 is returned indicating wait time in seconds.

To enable legacy headers (`X-RateLimit-*`):
```javascript
const limiter = rateGuard({
  headers: true,
  legacyHeaders: true // Emits X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
});
```

Downstream route handlers can also access current rate limit information on `req.rateLimit`:
```javascript
app.get('/api/me', (req, res) => {
  const { limit, current, remaining, resetTime } = req.rateLimit;
  res.json({ remaining, resetTime });
});
```

---

### 5. `skip` Option to Exclude Selected Requests or Routes

Exclude health checks, webhooks, or specific conditions from being counted against rate limits:

#### Using an array of path prefixes:
```javascript
const apiLimiter = rateGuard({
  max: 50,
  skip: ['/health', '/metrics', '/favicon.ico']
});
```

#### Using a RegExp pattern:
```javascript
const apiLimiter = rateGuard({
  max: 50,
  skip: /^\/(health|status)/
});
```

#### Using a custom predicate function:
```javascript
const apiLimiter = rateGuard({
  max: 50,
  skip: (req) => req.headers['x-admin-token'] === 'secret-key' || req.method === 'OPTIONS'
});
```

---

## Configuration Reference

| Option | Type | Default | Description |
|---|---|---|---|
| `windowMs` | `number` | `60000` (1 min) | Duration of the rate limit window in milliseconds. |
| `max` | `number \| Function` | `100` | Max requests per window. Can be a dynamic function `(req, res) => number`. |
| `message` | `string \| object \| Function` | `'Too many requests...'` | Response body on limit exceed. |
| `statusCode` | `number` | `429` | HTTP status code sent on exceeded limits. |
| `whitelist` | `string[] \| Set<string> \| Function` | `null` | IP addresses that are never rate-limited. |
| `skip` | `Function \| RegExp \| string[]` | `null` | Predicate, RegExp, or path list to bypass limiting. |
| `headers` | `boolean` | `true` | Send standard `RateLimit-*` response headers. |
| `legacyHeaders` | `boolean` | `false` | Send legacy `X-RateLimit-*` response headers. |
| `routeBased` | `boolean` | `false` | Automatically scope tracking keys to each route path. |
| `keyGenerator` | `Function` | IP extractor | Custom function returning client key string. |
| `handler` | `Function` | default handler | Custom callback invoked when rate limit is exceeded. |
| `cleanupIntervalMs`| `number` | `min(windowMs, 60000)`| Interval to sweep expired records from memory. |

---

## Programmatic Controls

```javascript
const limiter = rateGuard({ windowMs: 60000, max: 10 });

// Reset a specific key (e.g. on successful login)
limiter.resetKey('192.168.1.1');

// Reset all tracked keys
limiter.resetAll();

// Stop cleanup timer and clear memory
limiter.destroy();
```

---

## Running Tests

Automated tests run using Node.js built-in test runner without external dependencies:

```bash
npm test
```

---

## License

MIT © Dhairya Mathur
