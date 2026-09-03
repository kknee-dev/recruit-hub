# 贡献指南（CONTRIBUTING）

感谢你考虑为 **recruit-hub（校招宝开源版）** 做贡献！本仓库坚持**零依赖**原则，所有改动请以此为前提。

## 🧭 我能贡献什么

- 🐛 **Bug 报告**：在 [Issues](https://github.com/kknee-dev/recruit-hub/issues) 描述复现步骤、环境（Node 版本）、预期与实际行为。
- 💡 **功能 / 数据源建议**：开 Issue 用 `enhancement` 标签，说明场景与价值。
- 📝 **文档 / 数据集改进**：修正 README、补充 `data/` 脱敏样本、优化周报聚合逻辑。
- 💻 **代码贡献**：Fork + PR，保持零依赖、不引入构建步骤。

## 🛠 本地开发

```bash
git clone https://github.com/kknee-dev/recruit-hub.git
cd recruit-hub
node examples/gen_seed.js   # 可选：生成演示数据
node app/server.js          # 启动，默认 http://localhost:3600
```

要求：**Node.js ≥ 22.5**（自带 `node:sqlite`）。

## 📐 代码规范

1. **零依赖**：禁止新增 `dependencies` / `devDependencies`。如需能力，优先用 Node 内置 API 或原生实现。
2. **无构建**：不引入 TypeScript / 打包器 / 转译步骤。源码即运行。
3. **风格**：2 空格缩进，单引号，与现有 `app/` 代码保持一致；提交前 `node --check` 通过。
4. **数据合规**：
   - 演示数据必须**完全脱敏**（虚构公司名，参考 `examples/gen_seed.js`）。
   - 真实数据集（`scripts/export_real_dataset.js` 产出）仅含**公开聚合字段**，**严禁包含任何个人信息**（邮箱 / 手机号 / 简历 / 投递记录）。
   - 每条真实数据须保留 `source` + `source_url` 来源标注。

## 🔀 PR 流程

1. Fork 到你的账号，`git checkout -b feat/your-topic`。
2. 本地验证（启动站点、跑相关脚本）。
3. 提交信息清晰（中文英文皆可，建议 `feat:` / `fix:` / `docs:` 前缀）。
4. 开 PR 到 `main`，描述：改动目的、测试方式、是否影响数据合规。
5. 维护者 review 后合并；CI（demo-data / content-engine）会自动刷新演示数据。

## 📊 关于真实数据集

`data/` 与 `digest/` 由维护者定期用 `scripts/export_real_dataset.js`（读取真实聚合库，需 `XZB_DB_PATH`）重新导出并提交。普通贡献者无需运行它；如需更新样本，请在 Issue 中提出。

## ❓ 联系方式

- 交流反馈：[GitHub Discussions](https://github.com/kknee-dev/recruit-hub/discussions)
- 托管 / 合作：见仓库 README「在线体验与托管服务」

再次感谢你的参与 🎉
