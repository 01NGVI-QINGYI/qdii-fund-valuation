/**
 * 本地 UI 验证：用系统自带的 Chrome（headless + CDP）打开页面，
 * 收集控制台报错、DOM 状态和截图。
 * ego-browser 的运行时装的是 Linux 版，在 macOS 上要 Xvfb，所以这里自己驱动。
 *
 * 注意：直接连 page target 的 WebSocket，不走 browser 级 socket + session，
 * 后者在 macOS headless 下 Chrome 会在 attach 后退出。
 */
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT || (9300 + Math.floor(Math.random() * 500)));
const URL_TO_OPEN = process.argv[2] || 'http://127.0.0.1:5178/';
const OUT_PNG = process.argv[3] || '/tmp/qdii-shot.png';
const WAIT_MS = Number(process.argv[4] || 9000);
const VIEWPORT = process.argv[5] || '1580,1080';
const EVAL_FILE = process.argv[6] || null;
const SEED_FILE = process.argv[7] || null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const base = mkdtempSync(path.join(tmpdir(), 'qdii-chrome-'));
const home = path.join(base, 'home');
mkdirSync(home, { recursive: true });

/**
 * 清掉上一次跑剩的 Chrome。
 * SIGKILL 只杀父进程，渲染/网络等子进程会变孤儿；攒多了会让新起的
 * Chrome 网络服务起不来（表现为 http(s) 全部变成 about:blank）。
 */
function killStaleChrome() {
  try {
    execSync(
      "pkill -f 'user-data-dir=.*qdii-chrome-' 2>/dev/null; " +
      "pkill -f 'user-data-dir=.*qdii-flow-' 2>/dev/null; true",
      { stdio: 'ignore', shell: '/bin/bash' },
    );
  } catch { /* 没有可杀的进程 */ }
}
killStaleChrome();

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(base, 'profile')}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  // DSH 的文件沙箱会拦住 Chrome 往 ~/Library 写崩溃转储，
  // 叠加 Chrome 自身的 seatbelt 会直接 SIGTRAP，所以这里把 HOME 挪到临时目录
  // 并关掉它自己的沙箱与崩溃上报。
  '--no-sandbox',
  '--disable-breakpad',
  '--disable-crash-reporter',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--hide-scrollbars',
  '--window-size=' + VIEWPORT,
  URL_TO_OPEN,
], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HOME: home, TMPDIR: base },
});

let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });
chrome.on('exit', (code) => { if (code !== 0 && code !== null) chromeErr += `\n[chrome exited ${code}]`; });

/**
 * 拿到"确实打开了目标 URL"的那个 page target。
 * headless 下 Chrome 常会自带一个 about:blank，直接取第一个 page 有可能
 * attach 到空白页；所以优先按 URL 匹配，匹配不到就用 /json/new 显式开一个。
 */
async function findPageTarget() {
  const want = URL_TO_OPEN;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (r.ok) {
        const list = await r.json();
        const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        const hit = pages.find((t) => t.url === want || t.url.startsWith(want));
        if (hit) return hit;
        if (pages.length) {
          // 已有 page 但不在目标地址：显式开一个
          try {
            const mk = await fetch(
              `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(want)}`,
              { method: 'PUT' },
            );
            if (mk.ok) {
              const t = await mk.json();
              if (t.webSocketDebuggerUrl) return t;
            }
          } catch { /* 退回到复用已有 page */ }
          return pages[0];
        }
      }
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error(`未能连接 Chrome。stderr:\n${chromeErr.slice(-1500)}`);
}

const page = await findPageTarget();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true });
});

let msgId = 0;
const pending = new Map();
const logs = [];
const errors = [];
const failedRequests = [];

ws.addEventListener('message', (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }

  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args || [])
      .map((a) => a.value ?? a.description ?? a.unserializableValue ?? '')
      .join(' ');
    logs.push(`${msg.params.type}: ${text}`);
    if (msg.params.type === 'error') errors.push(text);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    errors.push(`${d.text} ${d.exception?.description || ''}`.trim());
  } else if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry;
    logs.push(`${e.level}: ${e.source}: ${e.text}`);
    if (e.level === 'error') errors.push(`${e.source}: ${e.text}`);
  } else if (msg.method === 'Network.loadingFailed') {
    failedRequests.push(msg.params.errorText);
  } else if (msg.method === 'Network.responseReceived') {
    const r = msg.params.response;
    if (r.status >= 400) failedRequests.push(`${r.status} ${r.url}`);
  }
});

function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} 超时`)); }
    }, 30000);
  });
}

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Network.enable');

// 已经在对的地址就不再导航（重复导航会让后续 evaluate 撞上上下文切换）
{
  const cur = await send('Runtime.evaluate', {
    expression: 'location.href', returnByValue: true,
  }).catch(() => null);
  if (cur?.result?.value !== URL_TO_OPEN) {
    await send('Page.navigate', { url: URL_TO_OPEN }).catch(() => {});
  }
}

/**
 * 等到"目标页面"真正加载完成。
 * 只看 readyState 不够：初始的 about:blank 也是 complete，
 * 但那是 opaque origin，localStorage 会抛 SecurityError。
 */
async function waitForReady(timeout = 25000) {
  const want = new URL(URL_TO_OPEN).origin;
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await send('Runtime.evaluate', {
        expression: 'JSON.stringify({s:document.readyState, o:location.origin})',
        returnByValue: true,
      });
      const v = JSON.parse(r?.result?.value || '{}');
      if (v.s === 'complete' && v.o === want) return true;
    } catch { /* 上下文正在切换，重试 */ }
    await sleep(200);
  }
  return false;
}

// 可选：先注入 localStorage 之类的初始状态，再重新加载
if (SEED_FILE) {
  await waitForReady();
  const seedExpr = readFileSync(SEED_FILE, 'utf8');
  // 文档切换的瞬间 localStorage 会抛 SecurityError，重试几次
  let r = null;
  for (let i = 0; i < 12; i++) {
    r = await send('Runtime.evaluate', { expression: seedExpr, returnByValue: true });
    if (!r.exceptionDetails) break;
    if (!/SecurityError/.test(r.exceptionDetails.exception?.description || '')) break;
    await sleep(300);
    await waitForReady();
  }
  if (r?.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`seed 执行失败: ${d.text} ${d.exception?.description || ''} @${d.url || ''}:${d.lineNumber}`);
  }
  await send('Page.reload', { ignoreCache: true });
}

await waitForReady();
await sleep(WAIT_MS);

const probe = EVAL_FILE
  ? readFileSync(EVAL_FILE, "utf8")
  : `(() => {
  const q = (s) => document.querySelector(s);
  const rows = [...document.querySelectorAll('#grid-body tr')];
  const detail = q('#detail');
  const g = (el, s) => el?.querySelector(s)?.textContent?.trim() ?? null;
  return {
    title: document.title,
    theme: document.documentElement.dataset.theme,
    indices: [...document.querySelectorAll('#ribbon .idx')].map(x => x.textContent.trim().replace(/\\s+/g,' ')),
    clock: [...document.querySelectorAll('#market-clock .mk')].map(x => x.textContent.trim().replace(/\\s+/g,' ')),
    emptyVisible: !q('#empty')?.hidden,
    rowCount: rows.length,
    rows: rows.slice(0,10).map(tr => ({ code: tr.dataset.code, text: tr.textContent.trim().replace(/\\s+/g,' ').slice(0,130) })),
    foot: q('#foot-status')?.textContent,
    detailName: g(detail, '.dt-name'),
    heroVal: g(detail, '.hero-val'),
    heroSub: g(detail, '.hero-sub'),
    gauge: g(detail, '.gauge-txt'),
    facts: [...(detail?.querySelectorAll('.fact')||[])].map(f => f.textContent.trim().replace(/\\s+/g,' ')),
    holdCount: detail?.querySelectorAll('.hold-table tbody tr').length ?? 0,
    holdRows: [...(detail?.querySelectorAll('.hold-table tbody tr')||[])].slice(0,5).map(r=>r.textContent.trim().replace(/\\s+/g,' ')),
    chartSvgs: detail?.querySelectorAll('.chart-svg').length ?? 0,
    fxStrip: g(detail, '.fx-strip'),
    issues: [...(detail?.querySelectorAll('.issue')||[])].map(i=>i.textContent.trim()),
    searchResults: document.querySelectorAll('#search-results .sr-item').length,
    bodyScrollH: document.body.scrollHeight,
  };
})()`;

let dom = null;
try {
  const res = await send('Runtime.evaluate', { expression: probe, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) {
    // 探测脚本自己抛错了：必须显式暴露，否则只会看到一个空的 dom
    dom = {
      probeError: res.exceptionDetails.exception?.description
        || res.exceptionDetails.text
        || '探测脚本异常',
    };
  } else {
    dom = res.result?.value ?? null;
  }
} catch (e) {
  dom = { probeError: e.message };
}

try {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(OUT_PNG, Buffer.from(data, 'base64'));
} catch (e) {
  chromeErr += `\n[screenshot failed: ${e.message}]`;
}

console.log(JSON.stringify({
  url: URL_TO_OPEN,
  screenshot: OUT_PNG,
  errors: [...new Set(errors)],
  failedRequests: [...new Set(failedRequests)].slice(0, 12),
  consoleLogs: [...new Set(logs)].slice(0, 20),
  dom,
  chromeStderrTail: chromeErr.trim() ? chromeErr.trim().split('\n').slice(-6).join('\n') : undefined,
}, null, 2));

ws.close();
chrome.kill('SIGKILL');
process.exit(0);
