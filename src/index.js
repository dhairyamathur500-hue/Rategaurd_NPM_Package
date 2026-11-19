'use strict';

const MemoryStore = require('./store');

/**
 * Safely extracts client IP address from various request properties and proxy headers.
 *
 * @param {import('http').IncomingMessage | Object} req
 * @returns {string}
 */
function defaultKeyGenerator(req) {
  if (req.ip && typeof req.ip === 'string') {
    return req.ip;
  }

  const headers = req.headers || {};

  // X-Forwarded-For can contain comma-separated client and proxy IPs
  const xForwardedFor = headers['x-forwarded-for'];
  if (typeof xForwardedFor === 'string' && xForwardedFor.length > 0) {
    const firstIp = xForwardedFor.split(',')[0].trim();
    if (firstIp) return firstIp;
  }

  const xRealIp = headers['x-real-ip'];
  if (typeof xRealIp === 'string' && xRealIp.trim().length > 0) {
    return xRealIp.trim();
  }

  if (req.socket && typeof req.socket.remoteAddress === 'string') {
    return req.socket.remoteAddress;
  }

  if (req.connection && typeof req.connection.remoteAddress === 'string') {
    return req.connection.remoteAddress;
  }

  return '127.0.0.1';
}

/**
 * Sets a header on an Express or native Node response object.
 *
 * @param {import('http').ServerResponse | Object} res
 * @param {string} name
 * @param {string | number} value
 */
function setResponseHeader(res, name, value) {
  if (typeof res.setHeader === 'function') {
    res.setHeader(name, String(value));
  } else if (res.headers && typeof res.headers === 'object') {
    res.headers[name] = String(value);
  }
}

/**
 * Default response handler when rate limit is exceeded.
 * Supports both Express.js and native Node.js HTTP response objects.
 *
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 * @param {Object} options
 */
async function defaultLimitHandler(req, res, next, options) {
  if (res.headersSent) {
    return;
  }

  const statusCode = options.statusCode || 429;
  const message = typeof options.message === 'function'
    ? await options.message(req, res)
    : options.message;

  // Express.js response support
  if (typeof res.status === 'function') {
    if (typeof message === 'object' && message !== null) {
      if (typeof res.json === 'function') {
        return res.status(statusCode).json(message);
      }
      return res.status(statusCode).send(JSON.stringify(message));
    }
    return res.status(statusCode).send(message);
  }

  // Native Node.js HTTP ServerResponse support
  if (typeof res.writeHead === 'function' && !res.headersSent) {
    if (typeof message === 'object' && message !== null) {
      const jsonBody = JSON.stringify(message);
      setResponseHeader(res, 'Content-Type', 'application/json');
      res.writeHead(statusCode);
      return res.end(jsonBody);
    }

    setResponseHeader(res, 'Content-Type', 'text/plain; charset=utf-8');
    res.writeHead(statusCode);
    return res.end(String(message));
  }

  if (typeof res.end === 'function' && !res.headersSent) {
    return res.end(typeof message === 'object' ? JSON.stringify(message) : String(message));
  }
}

/**
 * Helper to determine if a request should be skipped based on skip option.
 * Supports predicate function, RegExp, or array of path strings/patterns.
 *
 * @param {Function | RegExp | Array<string | RegExp>} skipOption
 * @param {Object} req
 * @param {Object} res
 * @returns {Promise<boolean>}
 */
async function shouldSkip(skipOption, req, res) {
  if (!skipOption) {
    return false;
  }

  if (typeof skipOption === 'function') {
    return Boolean(await skipOption(req, res));
  }

  const fullPath = (req.baseUrl || '') + (req.path || req.url || '');
  const pathOnly = req.path || req.url || '';

  if (Array.isArray(skipOption)) {
    return skipOption.some((pattern) => {
      if (typeof pattern === 'string') {
        return (
          fullPath === pattern ||
          fullPath.startsWith(pattern) ||
          pathOnly === pattern ||
          pathOnly.startsWith(pattern)
        );
      }
      if (pattern instanceof RegExp) {
        return pattern.test(fullPath) || pattern.test(pathOnly);
      }
      return false;
    });
  }

  if (skipOption instanceof RegExp) {
    return skipOption.test(fullPath) || skipOption.test(pathOnly);
  }

  return false;
}

/**
 * Helper to determine if an IP address is in the whitelist.
 * Supports Array of IP strings, Set of IP strings, or a custom check function.
 *
 * @param {Array<string> | Set<string> | Function} whitelist
 * @param {string} ip
 * @param {Object} req
 * @returns {Promise<boolean>}
 */
async function isIpWhitelisted(whitelist, ip, req) {
  if (!whitelist) {
    return false;
  }

  if (typeof whitelist === 'function') {
    return Boolean(await whitelist(ip, req));
  }

  if (whitelist instanceof Set) {
    return whitelist.has(ip);
  }

  if (Array.isArray(whitelist)) {
    return whitelist.includes(ip);
  }

  return false;
}

/**
 * Validates options passed to the rateGuard factory.
 *
 * @param {Object} options
 */
function validateOptions(options) {
  if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options))) {
    throw new TypeError('RateGuard: Options must be an object.');
  }

  if (options.windowMs !== undefined) {
    if (typeof options.windowMs !== 'number' || Number.isNaN(options.windowMs) || options.windowMs <= 0) {
      throw new RangeError('RateGuard: "windowMs" must be a positive number greater than 0.');
    }
  }

  if (options.max !== undefined) {
    const isNum = typeof options.max === 'number' && !Number.isNaN(options.max) && options.max >= 0;
    const isFn = typeof options.max === 'function';
    if (!isNum && !isFn) {
      throw new TypeError('RateGuard: "max" must be a non-negative number or a function returning a number.');
    }
  }

  if (options.statusCode !== undefined) {
    if (!Number.isInteger(options.statusCode) || options.statusCode < 100 || options.statusCode > 599) {
      throw new RangeError('RateGuard: "statusCode" must be a valid HTTP status code integer (100 - 599).');
    }
  }

  if (options.keyGenerator !== undefined && typeof options.keyGenerator !== 'function') {
    throw new TypeError('RateGuard: "keyGenerator" must be a function.');
  }

  if (options.skip !== undefined) {
    const isFn = typeof options.skip === 'function';
    const isRegExp = options.skip instanceof RegExp;
    const isArr = Array.isArray(options.skip);
    if (!isFn && !isRegExp && !isArr) {
      throw new TypeError('RateGuard: "skip" must be a function, RegExp, or an array of path strings.');
    }
  }

  if (options.whitelist !== undefined) {
    const isArr = Array.isArray(options.whitelist);
    const isSet = options.whitelist instanceof Set;
    const isFn = typeof options.whitelist === 'function';
    if (!isArr && !isSet && !isFn) {
      throw new TypeError('RateGuard: "whitelist" must be an array of IP strings, a Set, or a function.');
    }
  }

  if (options.handler !== undefined && typeof options.handler !== 'function') {
    throw new TypeError('RateGuard: "handler" must be a function.');
  }

  if (options.cleanupIntervalMs !== undefined) {
    if (typeof options.cleanupIntervalMs !== 'number' || Number.isNaN(options.cleanupIntervalMs) || options.cleanupIntervalMs < 0) {
      throw new RangeError('RateGuard: "cleanupIntervalMs" must be a non-negative number.');
    }
  }

  if (options.standardHeaders !== undefined && typeof options.standardHeaders !== 'boolean') {
    throw new TypeError('RateGuard: "standardHeaders" must be a boolean.');
  }

  if (options.headers !== undefined && typeof options.headers !== 'boolean') {
    throw new TypeError('RateGuard: "headers" must be a boolean.');
  }

  if (options.legacyHeaders !== undefined && typeof options.legacyHeaders !== 'boolean') {
    throw new TypeError('RateGuard: "legacyHeaders" must be a boolean.');
  }

  if (options.routeBased !== undefined && typeof options.routeBased !== 'boolean') {
    throw new TypeError('RateGuard: "routeBased" must be a boolean.');
  }
}

/**
 * Creates an Express rate-limiting middleware instance.
 *
 * @param {Object} [rawOptions={}] - Configuration options.
 * @param {number} [rawOptions.windowMs=60000] - Window duration in milliseconds.
 * @param {number|Function} [rawOptions.max=100] - Maximum requests allowed per window.
 * @param {string|Object|Function} [rawOptions.message='Too many requests, please try again later.'] - Custom response message.
 * @param {number} [rawOptions.statusCode=429] - HTTP status code on limit exceed.
 * @param {Array<string>|Set<string>|Function} [rawOptions.whitelist] - Whitelist of IPs that are never rate-limited.
 * @param {Function|RegExp|Array<string>} [rawOptions.skip] - Function, RegExp, or path list to exclude from rate limiting.
 * @param {Function} [rawOptions.keyGenerator] - Custom key generation function.
 * @param {boolean} [rawOptions.routeBased=false] - Scopes tracking keys to specific routes.
 * @param {Function} [rawOptions.handler] - Custom callback when limit is exceeded.
 * @param {boolean} [rawOptions.standardHeaders=true] - Send RateLimit-* headers.
 * @param {boolean} [rawOptions.headers=true] - Alias for standardHeaders.
 * @param {boolean} [rawOptions.legacyHeaders=false] - Send X-RateLimit-* headers.
 * @param {number} [rawOptions.cleanupIntervalMs] - Interval to sweep expired keys.
 * @param {Object} [rawOptions.store] - Custom store implementation.
 * @returns {import('express').RequestHandler & { resetKey: Function, resetAll: Function, destroy: Function, store: MemoryStore }}
 */
function rateGuard(rawOptions = {}) {
  validateOptions(rawOptions);

  const sendHeaders = rawOptions.headers !== undefined
    ? rawOptions.headers
    : (rawOptions.standardHeaders !== undefined ? rawOptions.standardHeaders : true);

  const options = {
    windowMs: rawOptions.windowMs || 60 * 1000,
    max: rawOptions.max !== undefined ? rawOptions.max : 100,
    message: rawOptions.message !== undefined ? rawOptions.message : 'Too many requests, please try again later.',
    statusCode: rawOptions.statusCode || 429,
    whitelist: rawOptions.whitelist || null,
    skip: rawOptions.skip || null,
    keyGenerator: rawOptions.keyGenerator || null,
    routeBased: Boolean(rawOptions.routeBased),
    handler: rawOptions.handler || defaultLimitHandler,
    standardHeaders: sendHeaders,
    legacyHeaders: rawOptions.legacyHeaders !== undefined ? rawOptions.legacyHeaders : false,
    cleanupIntervalMs: rawOptions.cleanupIntervalMs,
  };

  const store = rawOptions.store || new MemoryStore({
    windowMs: options.windowMs,
    cleanupIntervalMs: options.cleanupIntervalMs,
  });

  const middleware = async function rateGuardMiddleware(req, res, next) {
    try {
      // 1. Check IP Whitelist (IPs that should never be rate-limited)
      const clientIp = defaultKeyGenerator(req);
      if (options.whitelist) {
        const whitelisted = await isIpWhitelisted(options.whitelist, clientIp, req);
        if (whitelisted) {
          return next();
        }
      }

      // 2. Check skip option (to exclude selected requests or routes)
      if (options.skip) {
        const skipped = await shouldSkip(options.skip, req, res);
        if (skipped) {
          return next();
        }
      }

      // 3. Resolve tracking key (with optional route scoping)
      let key;
      if (options.keyGenerator) {
        key = String(await options.keyGenerator(req));
      } else if (options.routeBased) {
        const routePath = (req.baseUrl || '') + (req.path || req.url || '');
        key = `${clientIp}:${routePath}`;
      } else {
        key = clientIp;
      }

      // 4. Resolve maximum request threshold
      const maxLimit = typeof options.max === 'function'
        ? await options.max(req, res)
        : options.max;

      // 5. Track hit in storage
      const record = store.increment(key, options.windowMs);
      const now = Date.now();
      const resetSeconds = Math.max(0, Math.ceil((record.resetTime - now) / 1000));
      const remaining = Math.max(0, maxLimit - record.count);

      // 6. Attach rateLimit info to request object
      req.rateLimit = {
        limit: maxLimit,
        current: record.count,
        remaining,
        resetTime: new Date(record.resetTime),
      };

      // 7. Standard Rate-Limit Response Headers
      if (options.standardHeaders) {
        setResponseHeader(res, 'RateLimit-Limit', maxLimit);
        setResponseHeader(res, 'RateLimit-Remaining', remaining);
        setResponseHeader(res, 'RateLimit-Reset', resetSeconds);
      }

      // 8. Legacy X-RateLimit Response Headers
      if (options.legacyHeaders) {
        setResponseHeader(res, 'X-RateLimit-Limit', maxLimit);
        setResponseHeader(res, 'X-RateLimit-Remaining', remaining);
        setResponseHeader(res, 'X-RateLimit-Reset', Math.ceil(record.resetTime / 1000));
      }

      // 9. Handle exceeded limits
      if (record.count > maxLimit) {
        setResponseHeader(res, 'Retry-After', Math.max(1, resetSeconds));
        return await options.handler(req, res, next, options);
      }

      return next();
    } catch (err) {
      return next(err);
    }
  };

  // Expose programmatic helper methods on the middleware instance
  middleware.resetKey = (key) => store.resetKey(key);
  middleware.resetAll = () => store.resetAll();
  middleware.destroy = () => store.destroy();
  middleware.store = store;

  return middleware;
}

/**
 * Creates route-aware rate-limiting middleware supporting different
 * rate limits for different Express routes.
 *
 * @param {Record<string, Object>} routeMap - Map of route prefixes to RateGuard options.
 * @param {Object} [defaultOptions={}] - Optional default options for unmapped routes.
 * @returns {import('express').RequestHandler}
 */
function routes(routeMap, defaultOptions = {}) {
  if (typeof routeMap !== 'object' || routeMap === null || Array.isArray(routeMap)) {
    throw new TypeError('RateGuard: routes() requires a route map object.');
  }

  const routeLimiters = Object.entries(routeMap).map(([route, opts]) => {
    return {
      route,
      limiter: rateGuard({ ...defaultOptions, ...opts }),
    };
  });

  const fallbackLimiter = Object.keys(defaultOptions).length > 0
    ? rateGuard(defaultOptions)
    : null;

  return async function routeRateGuardMiddleware(req, res, next) {
    const fullPath = (req.baseUrl || '') + (req.path || req.url || '');
    const pathOnly = req.path || req.url || '';
    const match = routeLimiters.find(({ route }) => {
      return (
        fullPath === route ||
        fullPath.startsWith(route) ||
        pathOnly === route ||
        pathOnly.startsWith(route)
      );
    });

    if (match) {
      return match.limiter(req, res, next);
    }

    if (fallbackLimiter) {
      return fallbackLimiter(req, res, next);
    }

    return next();
  };
}

// Module exports for CommonJS, named imports, and default interop
module.exports = rateGuard;
module.exports.rateGuard = rateGuard;
module.exports.RateGuard = rateGuard;
module.exports.MemoryStore = MemoryStore;
module.exports.routes = routes;
module.exports.default = rateGuard;
