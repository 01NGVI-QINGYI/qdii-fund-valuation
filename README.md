# 美股基金估值宝

一个面向 QDII / 海外基金的持仓穿透估值网站。项目根据基金最新披露的重仓股、实时行情与汇率，自行估算盘前、盘中和盘后净值变化。

- 在线网站：https://01ngvi-qingyi.github.io/qdii-fund-valuation/
- API 状态：https://qdii-fund-valuation.onrender.com/api/health

## 功能

- QDII 基金搜索与自选管理
- 持仓穿透估值及覆盖度提示
- 美股、港股、日股与 A 股行情匹配
- 人民币汇率影响估算
- 基金收益、净值曲线和持仓明细
- 深色主题、响应式布局与 CSV 导出

## 技术架构

- 前端：原生 HTML、CSS、JavaScript，由 GitHub Pages 托管
- 后端：Node.js 20+，由 Render 托管
- 数据：天天基金、腾讯财经、新浪财经与东方财富备用行情
- 部署：推送 `main` 后由 GitHub Actions 自动更新 Pages，Render 自动更新 API

## 本地运行

```bash
git clone https://github.com/01NGVI-QINGYI/qdii-fund-valuation.git
cd qdii-fund-valuation
npm start
```

打开 http://127.0.0.1:5178 。项目无第三方运行时依赖。

```bash
npm run selftest  # 数据源自检
npm run uitest    # 浏览器交互测试
```

## 说明

基金持仓来自定期报告，可能存在披露延迟、调仓误差和未覆盖资产。所有估值仅供学习与研究，不构成投资建议。

## 开源许可

本项目由 **01NGVI-QINGYI** 开发，采用 [Apache License 2.0](LICENSE) 开源。

使用、修改或再发布本项目及其衍生作品时，请遵守许可证并保留 `LICENSE`、版权声明及 [NOTICE](NOTICE) 中的作者来源信息。
