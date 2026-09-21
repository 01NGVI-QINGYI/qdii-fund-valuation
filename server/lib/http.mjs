/**
 * 轻量 HTTP 客户端。
 *
 * 参考项目里 Python 用 requests、JS 用 axios；这里直接用 Node 内建 fetch，
 * 做到零依赖。三个参考项目的接口大多要求特定 Referer 与 UA，且部分返回
 * GBK 编码（腾讯 / 新浪），所以统一在这里处理。
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export class HttpError extends Error {
  constructor(message, { status, url } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 发起请求并把响应体解码成字符串。
 * @param {string} url
 * @param {{encoding?: string, referer?: string, headers?: Record<string,string>,
 *          timeout?: number, retries?: number, method?: string, body?: string}} opts
 */
export async function fetchText(url, opts = {}) {
  const {
    encoding = 'utf-8',
    referer,
    headers = {},
    timeout = 12000,
    retries = 2,
    method = 'GET',
    body,
  } = opts;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        body,
        redirect: 'follow',
        headers: {
          'User-Agent': UA,
          Accept: '*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          ...(referer ? { Referer: referer } : {}),
          ...headers,
        },
        signal: AbortSignal.timeout(timeout),
      });

      const buf = Buffer.from(await res.arrayBuffer());

      if (!res.ok) {
        // 部分接口用 4xx 返回一段说明性 HTML，交给调用方判断更合适，
        // 但 5xx 基本是上游抖动，值得重试。
        if (res.status >= 500 && attempt < retries) {
          lastErr = new HttpError(`HTTP ${res.status}`, { status: res.status, url });
          await sleep(220 * (attempt + 1));
          continue;
        }
        throw new HttpError(`HTTP ${res.status}`, { status: res.status, url });
      }

      const text =
        encoding === 'gbk' || encoding === 'gb2312'
          ? new TextDecoder('gbk').decode(buf)
          : buf.toString('utf8');
      return { text, status: res.status, url };
    } catch (err) {
      lastErr = err;
      const retriable =
        err?.name === 'TimeoutError' ||
        err?.name === 'AbortError' ||
        err?.cause?.code === 'ECONNRESET' ||
        err?.code === 'ECONNRESET' ||
        /fetch failed/i.test(err?.message || '');
      if (attempt < retries && retriable) {
        await sleep(220 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export async function fetchJson(url, opts = {}) {
  const { text } = await fetchText(url, opts);
  return parseJsonLoose(text, url);
}

/**
 * 有些接口会返回 JSONP / 前置空白 / BOM，这里做一次宽松解析。
 */
export function parseJsonLoose(text, url = '') {
  let s = text.replace(/^\uFEFF/, '').trim();
  if (!s) throw new HttpError('空响应', { url });

  // JSONP: cb({...}) 或 cb && cb({...})
  const jsonp = s.match(/^[A-Za-z_$][\w$.]*\s*&&\s*[A-Za-z_$][\w$.]*\((.*)\);?$/s);
  if (jsonp) s = jsonp[1];
  else if (/^[A-Za-z_$][\w$.]*\s*\(/.test(s) && s.endsWith(')')) {
    s = s.slice(s.indexOf('(') + 1, -1);
  }

  try {
    return JSON.parse(s);
  } catch {
    // 兜底：截取最外层 JSON 片段
    const start = s.search(/[[{]/);
    const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
    if (start >= 0 && end > start) {
      return JSON.parse(s.slice(start, end + 1));
    }
    throw new HttpError('JSON 解析失败', { url });
  }
}

/** 并发执行并把结果按输入顺序返回，失败的项为 null。 */
export async function mapSettled(items, fn, concurrency = 6) {
  const out = new Array(items.length).fill(null);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        out[i] = await fn(items[i], i);
      } catch {
        out[i] = null;
      }
    }
  });
  await Promise.all(workers);
  return out;
}
