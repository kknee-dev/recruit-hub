# recruit-hub 文档

校招宝开源版 —— 零依赖校园招聘信息聚合站。

## 快速开始
- [README（仓库首页）](../README.md)：一键体验、特性、环境变量
- 要求：Node.js ≥ 22.5
- 启动：`./start.sh`（或 `start.bat`），访问 http://localhost:3600

## 数据接入
- 岗位表：`jobs`，关键字段 `company / position / batch / city / education / deadline / apply_url`
- 去重：`fingerprint` = MD5(company|position|batch|education|city)
- 示例：[examples/gen_seed.js](../examples/gen_seed.js)

## API（只读）
- `GET /api/jobs?q=&city=&batch=&page=&size=`：岗位检索
- `GET /api/companies?q=`：企业列表
- `GET /api/meta`：站点统计
- `GET /sitemap.xml`、`/llms.txt`、`/llms-full.txt`：SEO/GEO 输出

## 贡献
提交 Issue / PR，保持零依赖原则。
