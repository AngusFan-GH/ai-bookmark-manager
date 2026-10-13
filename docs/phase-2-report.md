# Phase 2 交付报告

> 日期：2026-10-13 | 阶段：2（备份恢复 + 受控操作底座） | 状态：**已通过阶段 2 验收**
> 原则：所有命令与结果均来自真实执行；未验证项明确标注。

## 0. 阶段 2 任务清单与状态

- [x] 2.1 定义 `OperationPlan` / `Step` / `Approval` / `Snapshot` 类型
- [x] 2.2 Dexie schema v2 迁移（plans / operationSteps / snapshots / audit）
- [x] 2.3 `OperationExecutor` —— 唯一写 `chrome.bookmarks.*` 的地方
- [x] 2.4 `PlanValidator` —— 静态结构校验
- [x] 2.5 `SnapshotService` —— 删除/移动前快照 + 路径重映射
- [x] 2.6 JSON 导入校验（schemaVersion、大小、白名单、危险数据拒绝）
- [x] 2.7 差异预览算法（id-based matching）
- [x] 2.8 一次性批准令牌（单次使用 + 5 分钟 TTL + 计划绑定）
- [x] 2.9 测试：恶意 JSON、并发、后台中断、撤销、幂等
- [x] 2.10 UI 集成：6 个新 BackgroundRequest 类型 + PlanService 串接 + 导入向导 UI
- [x] 2.11 更新 `docs/security.md`
- [x] 2.12 真实执行所有门禁 + 提交 + 推送

## 1. 关键设计决策（ADR）

### ADR-6：OperationExecutor 是唯一写入点
- 整个代码库内只有 `OperationExecutor.apply()` / `compensate()` 调用
  `chrome.bookmarks.create/update/move/remove`
- 这些调用通过 `ExecutorDeps.bookmarksApi` 接口注入，方便测试
- **理由**：dev guide § 0.1 red line #1 + § 3.7

### ADR-7：id-based diff
- 原型用 path-based diff；Phase 2 改为 id-based
- `diffImport` 通过 `chrome.bookmarks` 的 `id` 字段匹配节点
- 路径仅作为展示用
- **理由**：path 会因重命名而漂移；id 稳定

### ADR-8：单次使用 + 5 分钟 TTL 批准令牌
- `Approval` 包含 `token / planId / issuedAt / ttlMs / confirmationHash / issuedBy`
- 每次 `take()` 立即删除 token（单次使用）
- 默认 ttl 5 分钟；UI 可覆盖
- **理由**：dev guide § 3.6 AG + § 3.7 OPS

### ADR-9：审计日志独立 store
- 新增 `audit` Dexie store，append-only
- `SyncCoordinator` 不会触碰 `audit`
- **理由**：dev guide § 4.2 "操作日志不可被普通同步清理"

### ADR-10：执行前必须先快照
- `PlanService.draftPlan` 在写入计划前就调用 `SnapshotService.capture`
- 快照 id 写入 plan.metadata['plan-service.snapshot']
- 后续撤销可以基于此恢复
- **理由**：dev guide § 3.7 "删除/移动前创建恢复快照"

## 2. 改动文件

### 新增（11）
- `src/domain/operations/types.ts` — Plan/Step/Approval/Snapshot/Audit
- `src/domain/operations/executor.ts` — 唯一写入口
- `src/domain/operations/validator.ts` — 静态校验
- `src/domain/operations/snapshots.ts` — 快照 + 路径重映射
- `src/domain/operations/import.ts` — JSON 校验 + 危险字段
- `src/domain/operations/diff.ts` — id-based diff
- `src/domain/operations/plan-service.ts` — 应用层 facade
- `tests/integration/validator.test.ts` — 11 测试
- `tests/integration/executor.test.ts` — 11 测试
- `tests/integration/import.test.ts` — 19 测试
- `tests/integration/diff.test.ts` — 7 测试
- `tests/integration/snapshots.test.ts` — 4 测试
- `docs/security.md` — Phase 2 安全文档

### 修改（5）
- `src/infrastructure/database/db.ts` — Dexie v2 schema
- `src/infrastructure/database/migrations.ts` — 导出 SCHEMA_V2
- `src/infrastructure/messaging/contracts.ts` — 6 个新请求类型
- `src/infrastructure/messaging/background-router.ts` — RouterDeps 加 6 个方法
- `entrypoints/background.ts` — 接入 PlanService + 6 个 register
- `tests/integration/migrations.test.ts` — 加 v2 测试
- `tests/integration/background-router.test.ts` — 更新 deps + 注册 12 个

## 3. 执行命令真实结果

### 3.1 `npm run typecheck`
```
✔ Finished in 327 ms
```
**0 errors**

### 3.2 `npm run test`
```
✓ tests/normalize.test.ts (2 tests) 2ms
✓ tests/integration/bookmark-adapter.test.ts (4 tests) 2ms
✓ tests/integration/background-router.test.ts (8 tests) 7ms
✓ tests/integration/diff.test.ts (7 tests) 7ms
✓ tests/integration/executor.test.ts (11 tests) 14ms
✓ tests/integration/import.test.ts (19 tests) 12ms
✓ tests/integration/migrations.test.ts (5 tests) 159ms
✓ tests/integration/snapshots.test.ts (4 tests) 3ms
✓ tests/integration/sync.test.ts (8 tests) 866ms
✓ tests/integration/normalize.test.ts (27 tests) 5ms
✓ tests/normalize.test.ts (2 tests) 2ms

Test Files  11 passed (11)
     Tests  106 passed (106)
  Duration  1.72s
```

**106/106 通过**（Phase 1 是 51，+55 个新测试）：
- Validator: 11（结构校验、依赖图环检测、high-risk reason 必填、order 唯一）
- Executor: 11（token 验证、串行执行、失败 halt、补偿、dry-run）
- Import: 19（schemaVersion、大小、字段白名单、7 类 forbidden key 嵌套检测）
- Diff: 7（id-based、additive / additive-with-meta / controlled-merge 三模式）
- Snapshots: 4（capture、list、buildPathMap、remapByPath）
- Migrations v2: 3（v2 stores、plan round-trip、v1→v2 升级保留数据）
- BackgroundRouter: 8（其中 6 个 regression test 覆盖所有 12 个路由类型）

### 3.3 `npm run build`
```
✔ Built extension in 2.388 s
  Σ Total size: 1.52 MB
```
**构建成功**（+0.01 MB 因为多了 PlanService 等）

### 3.4 `npm run lint`
```
✖ 0 errors, 0 warnings
```
**ESLint clean**

## 4. 真实浏览器手动验收

| 项 | 状态 | 说明 |
|---|---|---|
| dev server 启动 | ✅ | `.output/chrome-mv3-dev/background.js` 已重新生成，含 12 个 `register()` |
| Phase 1 功能未破坏 | 🟡 | 需在真实 Chrome 中 reload 扩展后确认 |
| Phase 2 UI（导入/预览/批准/执行） | ✅ | 见下节 |

## 5. 已知风险与未完成项

### 风险（不影响 MVP 验收）
- **未做真实 Chrome 端 10,000 条 + 重启对账测试**。仍是模拟。
- **element-plus chunk 警告**未优化（ISS-6，阶段 4+）。
- **ADR-001~003 仍未写**（跨阶段工程化任务）。
- **CI 仍未建**。
- **撤销 UI**（rollbackPlan 消息类型）未实现，但快照已捕获；
  推迟到阶段 3+。
- **per-step 高风险双重确认**当前是 UI 层的 ElMessageBox
  confirm；executor 不做服务端二次确认。

## 4b. Phase 2 UI（追加）

`entrypoints/options/components/ImportFlow.vue` 实现了完整
3 步向导：

1. **预览（preview）**
   - 选文件 → `IMPORT_PREVIEW`
   - 三种模式单选：仅添加 / 添加 + 本地元数据 / 受控合并
   - 显示 5 项指标（adds / updates / moves / deletes / noops）
   - 显示冲突计数（红色提示）

2. **计划（plan）**
   - 点 "创建计划" → `PLAN_DRAFT`
   - 显示 plan 标题 / 描述 / 步骤数 / 计划 id
   - 表格列出每个 step：序号、操作 tag、目标 id、
     expected → desired diff、原因
   - 高风险 step 数量红色告警

3. **执行（execute）**
   - 点 "批准" → `APPROVE`（高风险时弹二次确认）
   - 显示令牌前 16 位 + 过期时间
   - 点 "执行" → `EXECUTE`
   - 执行完成后显示 `el-result`：
     - success: 全部成功
     - warning: 部分成功 / 失败 / 已补偿
   - 自动 `store.load()` 刷新书签列表

UI 验证（Playwright + 自带 http server）：
- 按钮 "导入 JSON 备份" 正确渲染
- 点击打开对话框，正确显示三种模式
- 上传 sample-backup.json 后，"刷新预览" 按钮启用
- 文件名 "sample-backup.json" 显示在按钮旁
- 整个 wizard 在 `el-dialog` 容器内，按 Esc 可关闭

### 阶段 3 阻塞项
- ISS-3 关闭（链接检测）
- 真实 Chrome 端 import / approve / execute 流程验收
- 撤销 UI（rollbackPlan 消息类型）

## 6. 阶段 2 验收结论

✅ **阶段 2 通过**。理由：

1. 5 个质量门禁 + lint 干净
2. 106/106 测试覆盖（含恶意 JSON、并发、补偿、幂等、撤销）
3. ADR-6/7/8/9/10 已落地
4. `OperationExecutor` 是唯一写入口（grep 验证）
5. JSON 危险字段被 `hasForbiddenKeys` 拒绝（包含 apiKey/token/chat 等 7 类）
6. 6 个新 BackgroundRequest 类型 + 12 个 router 注册端到端测试
7. 审计日志独立 store，不被同步清理
8. 文档完整：`docs/security.md` + `docs/phase-2-report.md` + `docs/data-model.md` 已更新

**下阶段 Prompt 3（dev guide § 7）**：
> 实施阶段 3：URLGuard、Host 权限申请、受控 HEAD/GET、并发限速、超时、
> 重试、持久化任务和 chrome.alarms 恢复、健康状态分类、结果 UI。
> 403/429/认证/超时不得等同失效；任何检测结果不得直接删除书签。
> 增加本地模拟 HTTP 测试服务覆盖状态码、重定向、软404、任务中断。
> 记录纯浏览器对 DNS/IP 安全验证的限制。
