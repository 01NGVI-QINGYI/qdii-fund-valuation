/** 后端接口封装。 */

const JSON_HEADERS = { Accept: 'application/json' };
const API_BASE = String(globalThis.QDII_API_BASE || '').replace(/\/$/, '');

async function get(path, params, signal) {
  const qs = params ? `?${new URLSearchParams(params)}` : '';
  const res = await fetch(API_BASE + path + qs, { headers: JSON_HEADERS, signal });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

export const api = {
  overview: (signal) => get('/api/overview', null, signal),
  search: (q, signal) => get('/api/search', { q }, signal),
  watch: (codes, { top = 10, fx = true } = {}, signal) =>
    get('/api/watch', { codes: codes.join(','), top, fx: fx ? 1 : 0 }, signal),
  fund: (code, { top = 10, fx = true } = {}, signal) =>
    get(`/api/fund/${encodeURIComponent(code)}`, { top, fx: fx ? 1 : 0 }, signal),
  refresh: () => get('/api/refresh'),
  health: () => get('/api/health'),
};

/** 带超时的请求包装。 */
export function withTimeout(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}
