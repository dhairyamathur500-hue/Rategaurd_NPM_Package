'use strict';

/**
 * Example Express.js server using RateGuard.
 * Demonstrates all 5 key features:
 *   1. Custom rate-limit messages with configurable HTTP status codes.
 *   2. Whitelist IPs that should never be rate-limited.
 *   3. Different rate limits for different Express routes.
 *   4. Rate-limit headers showing limit, remaining requests and reset time.
 *   5. A `skip` option to exclude selected requests or routes.
 */

let express;
try {
  express = require('express');
} catch (e) {
  console.log('To run this live Express example, install Express: npm install --no-save express');
}

if (express) {
  const rateGuard = require('../src/index');

  const app = express();
  app.use(express.json());
  app.set('trust proxy', 1);

  // Feature 1, 2, 4, 5: Global API limiter with whitelist, custom message/code, headers & skip
  const apiLimiter = rateGuard({
    windowMs: 15 * 60 * 1000, // 15-minute window
    max: 100,
    statusCode: 429, // Feature 1: Configurable status code
    message: { // Feature 1: Custom JSON message
      success: false,
      error: 'Too many requests. Please try again after 15 minutes.',
    },
    whitelist: ['127.0.0.1', '10.0.0.1'], // Feature 2: Whitelisted IPs never blocked
    headers: true, // Feature 4: Emits RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset
    skip: ['/api/health', '/api/ping'], // Feature 5: Exclude selected routes/requests
  });

  app.use('/api', apiLimiter);

  // Feature 3: Different rate limits for different routes

  // Route A: Strict authentication limit (e.g. 5 attempts / 15 mins with custom 403 Forbidden status)
  const loginLimiter = rateGuard({
    windowMs: 15 * 60 * 1000,
    max: 5,
    statusCode: 403,
    message: {
      success: false,
      error: 'Too many login attempts. Access temporarily locked for 15 minutes.',
    },
  });

  app.post('/api/auth/login', loginLimiter, (req, res) => {
    res.json({
      success: true,
      message: 'Login endpoint reached.',
      rateLimitInfo: req.rateLimit,
    });
  });

  // Route B: High-volume public search limit (e.g. 30 requests / 1 min)
  const searchLimiter = rateGuard({
    windowMs: 60 * 1000,
    max: 30,
    message: 'Search query rate limit exceeded. Please slow down.',
  });

  app.get('/api/search', searchLimiter, (req, res) => {
    res.json({
      success: true,
      query: req.query.q || '',
      remaining: req.rateLimit.remaining,
    });
  });

  // Feature 5 demonstration: Excluded health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // Root route
  app.get('/', (req, res) => {
    res.send('RateGuard Express Server is running! Check /api/health, /api/search, or POST /api/auth/login');
  });

  const PORT = process.env.PORT || 3000;
  if (require.main === module) {
    app.listen(PORT, () => {
      console.log(`RateGuard demo server listening on http://localhost:${PORT}`);
    });
  }

  module.exports = app;
}
