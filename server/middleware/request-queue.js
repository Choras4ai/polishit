'use strict';

/**
 * Request queue — smooths traffic bursts by queuing requests
 * and processing them at a controlled concurrency.
 *
 * When the queue is full, requests are rejected immediately.
 */

class RequestQueue {
  constructor(options = {}) {
    this.maxConcurrent = options.maxConcurrent || 50;  // Max simultaneous upstream calls
    this.maxQueued = options.maxQueued || 200;          // Max waiting in queue
    this.queueTimeoutMs = options.queueTimeoutMs || 30000; // Max wait time in queue

    this.running = 0;
    this.queue = []; // { resolve, reject, enqueuedAt }
  }

  /**
   * Acquire a slot to make an upstream call.
   * Resolves when a slot is available, rejects if queue is full or timeout.
   * @returns {Promise<Function>} Release function to call when done
   */
  acquire() {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return Promise.resolve(() => this._release());
    }

    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(
        Object.assign(new Error('服务器繁忙，请求队列已满，请稍后重试。'), { status: 503 }),
      );
    }

    return new Promise((resolve, reject) => {
      const entry = {
        resolve: (release) => resolve(release),
        reject,
        enqueuedAt: Date.now(),
        timer: setTimeout(() => {
          // Remove from queue on timeout
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) this.queue.splice(idx, 1);
          reject(
            Object.assign(new Error('排队超时，请稍后重试。'), { status: 503 }),
          );
        }, this.queueTimeoutMs),
      };
      this.queue.push(entry);
    });
  }

  _release() {
    this.running--;

    if (this.queue.length > 0) {
      const next = this.queue.shift();
      clearTimeout(next.timer);
      this.running++;
      next.resolve(() => this._release());
    }
  }

  getStatus() {
    return {
      running: this.running,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueued: this.maxQueued,
    };
  }
}

const requestQueue = new RequestQueue();

module.exports = { RequestQueue, requestQueue };
