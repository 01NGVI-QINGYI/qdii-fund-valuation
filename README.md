# 美股基金估值宝 · QDII 持仓穿透估值

基于**定期报告持仓穿透**的 QDII / 海外基金实时估值工作台。

天天基金在 2023 年前后下线了 `fundgz.1234567.com.cn` 的官方盘中估值接口
（实测现在对任意基金代码都返回"页面未找到"），所以本项目的估值**完全自算**：
取基金最新披露的重仓股，逐个匹配各市场实时行情，再按权重还原成基金净值的估算涨跌。

零依赖：后端只用 Node 内建模块，前端是手写的 HTML / CSS / 原生 ES 模块，没有构建步骤。

---

## 快速开始

```bash
node server/index.mjs
# 打开 http://127.0.0.1:5178
```

要求 Node 20+（用到内建 `fetch` 与 `TextDecoder('gbk')`）。无需 `npm install`。

```bash
PORT=8080 node server/index.mjs   # 换端口
npm run selftest                  # 数据源连通性自检（23 项）
npm run uitest                    # 用系统 Chrome 跑一遍交互并截图
```

## GitHub Pages 与线上部署

本项目采用 **GitHub Pages 前端 + Render API** 的非 Vercel 部署方式。用户访问的是
`github.io` 页面；Node.js API、跨域数据代理和盘中采样由 Render 执行。GitHub Pages
本身只能托管静态文件，无法单独运行 `server/`。

1. 将源码推送到 GitHub 的 `main` 分支。
2. 在 Render 选择 **New → Blueprint**，连接仓库；`render.yaml` 会创建 Node Web Service。
3. 在 GitHub 仓库的 **Settings → Secrets and variables → Actions → Variables** 新建
   `QDII_API_BASE`，值为 Render 地址，例如 `https://qdii-fund-valuation.onrender.com`。
4. 在 **Settings → Pages → Build and deployment** 选择 **GitHub Actions**。
5. 重新运行 `Deploy frontend to GitHub Pages` 工作流。以后推送 `main` 会自动更新页面。

Pages 工作流只发布 `web/`，并在部署时生成 API 配置；本地运行仍使用同源 `/api/*`。

免费 Render 实例适合演示，但闲置后会休眠，且重启或重新部署会清空本地盘中采样文件。
核心实时估值不受影响；如需长期保留 `data/intraday`，应升级到带持久化磁盘的实例，
挂载目录后设置环境变量 `DATA_DIR` 指向该目录（例如 `/var/data`）。

---

## 估值算法

```
估算涨跌% = Σ(已交易持仓 wᵢ·pᵢ) × 股票占净比 / (Σw × 100)
```

三个关键口径：

**1. 「已交易」的判定 —— 用交易所本地日期，而不是固定钟点**

每只标的的行情都带一个"所属交易日的交易所本地日期"（美股给美东日期，港股给香港日期，
A 股给北京日期）。当它**晚于**基金最新净值日期时，才算"已交易"：

```
新鲜(fresh) ⟺ quote.localDate > fund.navDate
```

含义很直白：这只标的在基金上次公布净值之后又交易过，它的涨跌才会体现在下一次净值里。
美股尚未开盘时贡献为 0，所以盘中早期不会被高估。

（对照：`xiaopc/qdii-value` 用固定的"北京时间 08:00"切分交易日，跨周末、长假、
美股冬夏令时切换时会错位。）

**2. 部分已交易时按参与度稀释**

只有一部分持仓交易过时，直接把这部分的平均涨跌放大到全部股票仓位会严重高估。
这里按实际参与比例缩放，全部持仓都已交易时公式自然退化为 `Σ(w·p)/Σw × 仓位`。

**3. 汇率**

QDII 净值以人民币计价，美元 / 港币资产要叠加汇率变动：

```
p_CNY = (1 + p_股价)(1 + p_汇率) − 1
```

汇率贡献在界面上单独列出，也可以一键关闭。
（对照：`qdii-value` 的 README 第一条注意事项即"未考虑汇率"。）

### 其它处理

| 情况 | 处理 |
| --- | --- |
| 联接基金（ETF 联接） | 直接持股为 0，按「100 − 债券 − 现金」还原股票敞口，并标注口径 |
| 上游未披露穿透持仓 | 明确说明「无法做持仓穿透估值」，不硬凑数字 |
| 持仓报告过期 | 超过 120 天即标红告警并把置信度降为「低」 |
| 停牌 / 无行情 | 该只记 0 贡献，并在面板中单独提示 |
| 净值已更新到当日 | 状态标记为「已结算」，不做无意义的估算 |

### 覆盖的市场

美股（含 NYSE / NASDAQ / AMEX）、港股、**日股（东京证交所，含 2024 年起的
`285A` 这类新代码）**、沪 / 深 / 北交所，以及各市场主要指数。
非人民币资产按对应汇率折算：美元、港币、日元（新浪财经）。

**顶部指数条**只放海外指数（纳斯达克 / 纳斯达克100 / 标普 500 / 道琼斯 /
恒生指数 / 恒生科技）——本工具主打美股方向的 QDII，A 股指数放在那里是噪音。
想加回来改一处即可：`server/quotes.mjs` 里的 `MARKET_INDICES` 数组，
按 `{ key, symbol, name }` 追加，symbol 用腾讯格式（如 `sh000001`、`sz399006`）。

**顶栏的市场时钟**是自适应的：只显示你自选里真正持有到的市场。
纯海外基金的自选不会出现 A 股；哪天加了境内基金，A 股那一栏会自动出现。

---

## 数据来源

| 用途 | 来源 | 接口 |
| --- | --- | --- |
| 基金搜索 | 天天基金 | `fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx` |
| 全量基金列表 | 天天基金 | `fund.eastmoney.com/js/fundcode_search.js` |
| 基金档案 / 净值历史 / 股票仓位 | 天天基金 | `fund.eastmoney.com/pingzhongdata/{code}.js` |
| 前 N 大重仓股 | 天天基金 | `fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc` |
| 美股 / 港股 / 日股 / A 股 / 指数实时行情 | 腾讯财经 | `qt.gtimg.cn/q=` |
| 行情备用源 | 新浪财经 | `hq.sinajs.cn` |
| 汇率（USD / HKD / JPY） | 新浪财经 | `hq.sinajs.cn/?list=fx_susdcny,fx_shkdcny,fx_sjpycny` |
| 净值备用源 | 新浪财经 | `stock.finance.sina.com.cn/.../CaihuiFundInfoService.getNav` |
| 行情第三备用源 | 东方财富 | `push2delay.eastmoney.com/api/qt/ulist.np/get` |

行情按「腾讯 → 新浪 → 东方财富延迟」自动降级，最终采用的源会透出到界面上。
一次请求多只基金时，所有持仓会**合并成一次批量行情请求**，并限制对上游的并发，
避免被限流。

### 关于参考项目里其它源的取舍

三个参考项目用到的源都实测过一遍，结果如下（实测时间 2026-09）：

| 源 | 参考项目 | 实测 | 是否采用 |
| --- | --- | --- | --- |
| 天天基金 / 东方财富 | 全部三个 | 正常 | ✅ 基金档案、持仓、搜索 |
| 腾讯财经 | fund-baby | 正常，覆盖美/港/日/A/指数 | ✅ 主力行情 |
| 新浪财经 | qdii-value | 正常 | ✅ 备用行情 + 汇率 + 净值 |
| 东方财富 `push2delay` | qdii-value | 正常（`push2` 已 502） | ✅ 第三备用 |
| `fundgz` 官方估值 | fund-baby | **已下线**，任意代码均返回"页面未找到" | ❌ 这正是本项目自算估值的原因 |
| investing.com | qdii-value | HTTP 500（项目 README 亦注明屏蔽非大陆 IP） | ❌ |
| Bloomberg | qdii-value | HTTP 403（项目 README 亦注明极易反爬） | ❌ |
| Google Finance | qdii-value | batchexecute 返回 400，RPC 签名已变 | ❌ |
| MSN 财经 | qdii-value | 需要有效的 instrumentId 映射，无法直接查 | ❌ |
| 雅虎奇摩 | qdii-value | 正常（台股 / 美股） | 备用，暂无 QDII 需要台股 |
| 星展银行 DBS 基金页 | qdii-value | 正常 | 未用（境内 QDII 用不到） |
| 汇丰 HSBC 基金页 | qdii-value | 返回空壳页 | ❌ |
| `wx.569555.xyz` 聚合接口 | 海外估值系统 | 返回空 JSON，已失效 | ❌ |
| 小贝养基 API | 海外估值系统 | 可用，但需私有 token（仓库里是占位符），且返回的是第三方算好的估值 | 未采用 |

第三个项目用「两路第三方估值按 0.6 / 0.4 加权」来提升准确度。本项目的做法不同：
不混合两个来源不明的数字，而是**把持仓穿透算到底**，再把汇率、交易日、覆盖度
这些影响因子显式暴露给用户，让结果可解释、可核对。

> 需要一个后端的原因：新浪 `hq.sinajs.cn` 必须带 `Referer`（浏览器发不了），
> 东方财富 F10 系列没有 CORS 头。纯前端方案只能覆盖 JSONP 那一小部分。

### 今日估值走势曲线

外部已经没有现成的"某基金今日估算走势"数据，所以这条曲线由本机在服务运行期间
逐分钟采样生成，落在 `data/intraday/<code>.json`。服务没开的时间段会自然留空，
界面会标注采样区间，不做插值伪装。

---

## 目录结构

```
server/
  index.mjs            HTTP 服务与路由（静态资源 + /api/*）
  service.mjs          业务编排：批量取持仓 → 合并行情请求 → 估值
  valuation.mjs        估值引擎（本项目核心）
  quotes.mjs           多源行情解析与降级
  intraday.mjs         盘中采样与持久化
  lib/
    http.mjs           fetch 封装（GBK 解码、重试、Referer）
    cache.mjs          TTL 缓存 + 同键请求合并
    time.mjs           北京时间与各市场交易时段
    symbols.mjs        裸代码 → 各行情源 symbol
    store.mjs          JSON 文件持久化
  sources/
    eastmoney.mjs      天天基金 / 东方财富
    tencent.mjs        腾讯财经
    sina.mjs           新浪财经
web/
  index.html
  css/base.css         设计变量与排版原语
  css/app.css          布局与组件
  js/                  api / store / dom / format / chart / views / app
tools/ui-check.mjs     给任意页面拍图 + 采集控制台报错
tools/ui-flow.mjs      完整交互流程验证（23 项断言）
test/selftest.mjs      数据源连通性自检（23 项）
data/                  盘中采样数据（运行时生成，已 gitignore）
```

---

## 交互

| 操作 | 快捷键 |
| --- | --- |
| 聚焦搜索 | `/` |
| 刷新 | `R` |
| 上下选择基金 | `K` / `J` 或 `↑` / `↓` |
| 打开详情 | `Enter` |
| 关闭详情 / 弹层 | `Esc` |

其它：`#161125` 形式的深链可直接打开某只基金；支持 CSV 导出、
汇率开关、自动刷新间隔（10 秒 ~ 5 分钟）、亮 / 暗主题；
自选列表保存在浏览器 `localStorage`。

---

## 已知局限

- 持仓来自季报，存在调仓滞后；报告期过旧的基金会在界面上明确标注。
- 未被重仓覆盖的股票按已交易部分的参与度外推，可能偏离实际。
- 不含衍生品、打新、融券等收益。
- 腾讯行情美股为实时，A 股 / 港股为对应交易所实时；东方财富兜底源存在延迟。

## 免责声明

本项目仅供学习与研究。所有数据与估算结果**不构成任何投资建议**。
估算基于公开的定期报告持仓，与基金实际持仓必然存在偏差。
投资有风险，决策需谨慎。

## 许可

MIT
