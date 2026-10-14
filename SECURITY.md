# 安全政策 · Security Policy

本文件适用于 **recruit-hub（校招宝开源版）** 仓库，以及校招宝对外提供的 **MCP Server / 开放 API**（`https://xiaozhaobao.com.cn/mcp`、`https://xiaozhaobao.com.cn/api/open/v1/*`）。

## 支持范围

| 组件 | 是否在范围内 |
|---|---|
| recruit-hub 开源代码（本仓库） | ✅ |
| 线上 MCP Server 端点 `/mcp` | ✅ |
| 线上开放 API `/api/open/v1/*` | ✅ |
| 线上站点 `xiaozhaobao.com.cn` 的其他部分 | ✅（仅限只读测试） |
| 第三方依赖 | ❌（本项目零第三方运行时依赖） |

## 报告漏洞

请**不要**通过公开 Issue 披露安全问题。请发送邮件至：

**kknee@qq.com**

建议包含：受影响的端点或文件、复现步骤、影响评估、以及（如适用）最小可复现示例。

## 承诺

- **48 小时内**确认收到。
- 在修复发布前，不会公开漏洞细节；修复后可在双方同意下公开致谢。
- ⛔ 禁止行为：任何形式的**数据抓取滥用 / 批量转售 / 越权写入 / 拒绝服务测试**。
  校招宝对外接口为**只读**，任何尝试写入、提交投递、或绕过限流的测试都不被授权。

## 设计上的安全边界（有意为之）

- 对外接口**只读**：不提供任何写操作、不提供投递 / 提交类工具。
- **不导出** `apply_url` / `notice_url` / 内推码等投递类数据（合规要求，亦为转化护城河）。
- 匿名按 IP 限流（默认 120 次/分钟）。
- MCP Server 的每个工具均声明 `readOnlyHint: true`。

## 已知非问题

- 该接口只需 `GET` / 只读 JSON-RPC，**无需认证**是设计决策，不是缺陷。
- 返回体中的 `?ref=` 参数为来源归因标记，不影响页面内容。

---

*English: Please report security issues to kknee@qq.com. Do not open public issues for vulnerabilities. Our public endpoints are read-only by design; any write/abuse testing is not authorized.*
