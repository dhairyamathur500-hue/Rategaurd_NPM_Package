'use strict';

/**
 * MemoryStore manages in-memory rate-limit tracking using a native JavaScript Map.
 * Provides automatic periodic cleanup and passive eviction of expired entries.
 */
class MemoryStore {
  /**
   * @param {Object} [options]
   * @param {number} [options.windowMs=60000] - Window size in milliseconds.
   * @param {number} [options.cleanupIntervalMs] - Interval to sweep expired keys.
   */
  constructor(options = {}) {
    this.windowMs = typeof options.windowMs === 'number' && options.windowMs > 0
      ? options.windowMs
      : 60 * 1000;

    const cleanupInterval = options.cleanupIntervalMs !== undefined
      ? options.cleanupIntervalMs
      : Math.min(this.windowMs, 60 * 1000);

    this.cleanupIntervalMs = typeof cleanupInterval === 'number' && cleanupInterval > 0
      ? cleanupInterval
      : 0;

    /** @type {Map<string, { count: number, resetTime: number }>} */
    this.hits = new Map();

    this.intervalId = null;
    if (this.cleanupIntervalMs > 0) {
      this.intervalId = setInterval(() => {
        this.cleanup();
      }, this.cleanupIntervalMs);

      // Do not keep the Node.js event loop alive solely for cleanup
      if (this.intervalId && typeof this.intervalId.unref === 'function') {
        this.intervalId.unref();
      }
    }
  }

  /**
   * Increments the hit count for a given key.
   * Resets if the window has expired.
   *
   * @param {string} key
   * @param {number} [windowMs=this.windowMs]
   * @returns {{ count: number, resetTime: number }}
   */
  increment(key, windowMs = this.windowMs) {
    const now = Date.now();
    let record = this.hits.get(key);

    if (!record || now >= record.resetTime) {
      record = {
        count: 1,
        resetTime: now + windowMs,
      };
      this.hits.set(key, record);
    } else {
      record.count += 1;
    }

    return {
      count: record.count,
      resetTime: record.resetTime,
    };
  }

  /**
   * Gets the current record for a key, deleting it if expired.
   *
   * @param {string} key
   * @returns {{ count: number, resetTime: number } | null}
   */
  get(key) {
    const record = this.hits.get(key);
    if (!record) {
      return null;
    }

    if (Date.now() >= record.resetTime) {
      this.hits.delete(key);
      return null;
    }

    return {
      count: record.count,
      resetTime: record.resetTime,
    };
  }

  /**
   * Resets (deletes) the hit count for a specific key.
   *
   * @param {string} key
   * @returns {boolean} true if an element existed and was removed.
   */
  resetKey(key) {
    return this.hits.delete(key);
  }

  /**
   * Resets all stored keys.
   */
  resetAll() {
    this.hits.clear();
  }

  /**
   * Sweeps and removes all expired records from memory.
   *
   * @returns {number} The count of deleted expired entries.
   */
  cleanup() {
    const now = Date.now();
    let deletedCount = 0;

    for (const [key, record] of this.hits.entries()) {
      if (now >= record.resetTime) {
        this.hits.delete(key);
        deletedCount += 1;
      }
    }

    return deletedCount;
  }

  /**
   * Stops the cleanup timer and clears all stored data.
   */
  destroy() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.resetAll();
  }

  /**
   * Returns current count of tracked keys in memory.
   *
   * @returns {number}
   */
  size() {
    return this.hits.size;
  }
}

module.exports = MemoryStore;
