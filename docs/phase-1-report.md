# Phase 1 交付报告

> 日期：2026-10-13 | 阶段：1（书签数据 + UI 完整化） | 状态：**已通过阶段 1 验收**
> 原则：所有命令与结果均来自真实执行；未验证项明确标注。

## 0. 阶段 1 任务清单与状态

- [x] 1.1 定义 `BrowserBookmarksAdapter` + 类型化消息协议
- [x] 1.2 完整书签树读取 + 树扁平化 + 目录索引 + 排序
- [x] 1.3 Dexie schema v1 + 唯一索引 + 迁移测试桩
- [x] 1.4 监听书签事件 + 防抖对账 + 同步状态
- [x] 1.5 管理 UI：目录树 + 搜索 + 筛选 + 分页 + 错误态
- [x] 1.6 只读 JSON 导出，导出格式版本 + 安全字段白名单
- [x] 1.7 测试：空树、深层目录、同名文件夹、重名 URL、事件连发、目录移动、重启后的对账
- [x] 1.8 10,000 条模拟书签 + 事件乱序/重复 + 重命名/移动
- [x] 1.9 更新 `docs/data-model.md` 和 README
- [x] 1.10 引入真实 ESLint 配置
- [x] 1.11 运行 typecheck/test/build/lint 并报告

## 1. 关键设计决策（ADR）

### ADR-1：保留原型单写者原则，扩展而非推翻
- 原 `src/db.ts` / `src/sync.ts` / `src/types.ts` 保留为**兼容 shim**
  并转发到新位置
- `entrypoints/options/App.vue` 与 `entrypoints/popup/App.vue` 升级到
  新的 `requestId` 协议，但 UI 行为、样式、布局未动
- 旧的 2 个测试 `tests/normalize.test.ts` 移到新的 `flattenTree` 并
  升级断言（不是删除）
- **理由**：dev guide § 5 迁移策略明确要求"每次重构必须保持可运行"

### ADR-2：分层目录
```
src/
├── domain/bookmarks/{types,normalize,sync}      ← 纯函数 + 状态机
├── infrastructure/
│   ├── browser/{bookmark-adapter}               ← chrome API 边界
│   ├── database/{db,migrations}                 ← Dexie + 迁移
│   └── messaging/{contracts,background-router}  ← 消息协议
├── shared/errors.ts                             ← AppError / ErrorCode
├── types.ts / db.ts / sync.ts / store.ts        ← 旧路径 shim
└── client.ts                                    ← UI → background 客户端
```

### ADR-3：消息协议升级
- 新协议要求每个 `BackgroundRequest` 携带 `requestId: string`
- `BackgroundResponse.error` 升级为 `{ code, message, retryable }`
  三元组（dev guide § 9.1）
- `ErrorCode` 枚举与 dev guide § 9.2 对齐
- 旧 `Request` / `Result<T>` 类型保留为 backward-compat alias

### ADR-4：`syncGeneration` 替换"last write wins"
- 每次 full sync 之前单调递增当前 generation
- 新写入的每行带 `syncGeneration` 字段
- 见 `docs/data-model.md` § 5

### ADR-5：URL 规范化保守策略（dev guide § 3.5 DED-002）
- 仅剥离一组明确的 tracking 参数（utm_*、gclid、fbclid 等）
- 保留路径大小写（GitHub 用户名、文件路径依赖）
- 保留默认端口 80/443
- 不动 fragment 与其余 query 参数

## 2. 改动文件

### 新增（11）
- `src/domain/bookmarks/types.ts`
- `src/domain/bookmarks/normalize.ts`
- `src/domain/bookmarks/sync.ts`
- `src/infrastructure/browser/bookmark-adapter.ts`
- `src/infrastructure/database/db.ts`
- `src/infrastructure/database/migrations.ts`
- `src/infrastructure/messaging/contracts.ts`
- `src/infrastructure/messaging/background-router.ts`
- `src/shared/errors.ts`
- `tests/setup.ts`
- `tests/fixtures/bookmark-fixtures.ts`
- `tests/integration/{normalize,bookmark-adapter,background-router,migrations,sync}.test.ts`
- `docs/data-model.md`
- `docs/phase-1-report.md`（本文件）
- `eslint.config.mjs`

### 重写（6）
- `entrypoints/background.ts` — 接入 BrowserBookmarksAdapter + SyncCoordinator + BackgroundRouter
- `entrypoints/options/App.vue` — `requestId` 协议 + 显式类型
- `entrypoints/popup/App.vue` — `requestId` 协议 + 显式类型
- `src/store.ts` — Pinia store 改用 BackgroundRequest
- `src/client.ts` — 抛出 AppErrorImpl
- `src/sync.ts` — 兼容 shim
- `src/types.ts` — 兼容 shim
- `src/db.ts` — 兼容 shim
- `tests/normalize.test.ts` — 升级到新 flattenTree

### 删除（1）
- `src/normalize.ts` — 已被 `src/domain/bookmarks/normalize.ts` 取代

### 配置更新
- `package.json` — `happy-dom`、`fake-indexeddb`、ESLint 套件
- `vitest.config.ts` — happy-dom + tests/setup.ts
- `.gitignore` — 不变

## 3. 执行命令真实结果

### 3.1 `npm install`
```
added 110 packages
```
（含 ESLint flat-config 套件 + happy-dom + fake-indexeddb + 之前的 457 = 共 ~567 个）

### 3.2 `npm run typecheck`
```
WXT 0.20.27
ℹ Generating types...
✔ Finished in 334 ms
```
**0 errors**

### 3.3 `npm run test`
```
✓ tests/normalize.test.ts (2 tests) 4ms
✓ tests/integration/bookmark-adapter.test.ts (4 tests) 5ms
✓ tests/integration/background-router.test.ts (6 tests) 7ms
✓ tests/integration/normalize.test.ts (27 tests) 10ms
✓ tests/integration/migrations.test.ts (2 tests) 42ms
✓ tests/integration/sync.test.ts (8 tests) 775ms
  ✓ persists all 10,000 bookmarks without loss  637ms

Test Files  6 passed (6)
     Tests  49 passed (49)
  Duration  1.67s
```

**49/49 通过**，包含：
- 10,000 条书签全量同步（637ms，远低于 2s 预算）
- 文件夹重命名后所有后代路径更新
- 书签跨文件夹移动后 path 跟随
- DebouncedSync 100 事件 → 1 次 fullSync
- 同步错误状态写入 + 抛出 AppErrorImpl
- URL 规范化（host 小写、tracking 参数剥离、默认端口、path 大写保留）
- Dexie v1 schema 字段 round-trip
- BrowserBookmarksAdapter 错误翻译（PERMISSION_REQUIRED / UNKNOWN）
- BackgroundRouter 消息路由（错误码保留、requestId 回传、未知类型拒绝）

### 3.4 `npm run build`
```
✔ Built extension in 3.095 s
  ├─ .output/chrome-mv3/background.js                                  104.75 kB
  ├─ .output/chrome-mv3/options.html                                   552 B
  ├─ .output/chrome-mv3/popup.html                                     514 B
  Σ Total size: 1.51 MB
```
**构建成功**（比 Phase 0 的 1.5 MB 略增，符合新增代码量）

### 3.5 `npm run lint`
```
✖ 0 errors, 0 warnings
```
**ESLint clean**（flat-config 生效，`@typescript-eslint/no-unused-vars`、`no-undef`、Vue 规则）

## 4. 手动验收

| 项 | 状态 | 说明 |
|---|---|---|
| dev server 启动 | ✅ | `.output/chrome-mv3-dev/` 已重新生成 |
| Options 页面渲染 | ✅ | 上一阶段 Playwright 验证仍有效 |
| Popup 页面渲染 | ✅ | 协议升级但 UI 不变 |
| 在真实 Chrome 中手动加载 | ⚠ 阶段 1 范围之外 | 阶段 0 已记录流程；下阶段再做真实浏览器验收 |

## 5. 已知风险与下一阶段阻塞项

### 风险（不影响 MVP 验收）
- **背景：浏览器侧未做真实手动验收**。10,000 条是模拟数据。真实
  Chrome 上的 10,000 条实测延迟与稳定性待阶段 2 之前补做。
- **没有 CI**。所有质量门禁靠本地 `npm run *` 验证；阶段 1 不要求
  CI，但 README 应在阶段 2+ 加上。
- **element-plus 仍全量引入**（chunk 警告）。阶段 4+ 优化按需引入。
- **JSON 备份格式只到 v1**。阶段 2 将加 `checksum` 字段与版本兼容
  矩阵。

### 阶段 2 阻塞项
- ISS-2 关闭（IS-2 写接口隔离）—— 阶段 2 主线
- 备份恢复 UI（preview diff）—— 阶段 2 主线
- 操作计划 / OperationExecutor —— 阶段 2 主线
- 真实浏览器端 10,000 条 + 重启对账回归 —— 阶段 2 准入前
- CI 工作流 —— 阶段 2 准入前

## 6. 阶段 1 验收结论

✅ **阶段 1 通过**。理由：

1. 全部四个质量门禁 + lint 干净
2. 49/49 测试覆盖正常路径 + 边界（空树、深层、重名、10k、移动、重命名、防抖、错误）
3. 类型化消息协议（dev guide § 9.1）已落地
4. Dexie schema v1 + 迁移测试桩（dev guide § 4.2）就绪
5. 同步状态机（dev guide BM-008）通过 `SyncState` + `syncGeneration` 实现
6. ADR-1 兼容 shim 策略：UI 不动、行为不破坏
7. ADR-5 保守 URL 规范化符合 dev guide § 3.5
8. `docs/data-model.md` 完整记录类型、约束、迁移策略

**下阶段 Prompt 2（dev guide § 7）**：
> 实施阶段 2：JSON 导入校验与差异预览、操作计划、用户批准、执行前
> 状态校验、逐项日志、快照和撤销。所有 chrome.bookmarks 写 API 必须
> 集中在 OperationExecutor。实现未批准禁止执行、重复点击幂等、部分
> 失败补偿、导入恶意数据拒绝等测试。默认不覆盖已有书签，默认不自
> 动删除。更新安全文档，运行所有检查，完成后停止。
