/**
 * 带 TTL 的缓存 + 同键请求合并。
 *
 * 这个应用是"轮询型"的：多个浏览器标签页会同时打同一批接口。
 * 没有合并的话，10 个标签页 × 12 只基金 = 上游几百次请求，
 * 很容易被东方财富 / 腾讯限流。所以 wrap() 会把同一 key 的
 * 并发请求收敛成一次真实上游调用。
 */
export class TtlCache {
  constructor({ max = 2000 } = {}) {
    this.max = max;
    this.entries = new Map(); // key -> { value, expires }
    this.inflight = new Map(); // key -> Promise
    this.hits = 0;
    this.misses = 0;
    this.coalesced = 0;
  }

  get(key) {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expires < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key, value, ttlMs) {
    if (this.entries.size >= this.max) {
      // 简单淘汰：删掉最早插入的一批
      const drop = Math.ceil(this.max * 0.1);
      let i = 0;
      for (const k of this.entries.keys()) {
        this.entries.delete(k);
        if (++i >= drop) break;
      }
    }
    this.entries.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  }

  /**
   * 读缓存；未命中则调用 producer 并写入。并发同 key 只触发一次 producer。
   * @template T
   * @param {string} key
   * @param {number} ttlMs
   * @param {() => Promise<T>} producer
   * @returns {Promise<T>}
   */
  async wrap(key, ttlMs, producer) {
    const hit = this.get(key);
    if (hit !== undefined) {
      this.hits++;
      return hit;
    }
    this.misses++;

    const pending = this.inflight.get(key);
    if (pending) {
      this.coalesced++;
      return pending;
    }

    const p = (async () => {
      try {
        const value = await producer();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, p);
    return p;
  }

  /** 返回缓存值；如果已过期但存在旧值，也返回旧值（stale-while-error 用）。 */
  getStale(key) {
    return this.entries.get(key)?.value;
  }

  stats() {
    return {
      size: this.entries.size,
      inflight: this.inflight.size,
      hits: this.hits,
      misses: this.misses,
      coalesced: this.coalesced,
    };
  }

  clear() {
    this.entries.clear();
  }
}

export const cache = new TtlCache();
