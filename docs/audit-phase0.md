# Phase 0 审计报告 — AI Bookmark Manager

> 日期：2026-10-13 | 阶段：0（审计 + 质量基线） | 状态：**已通过阶段 0 验收**
> 原则：所有命令与结果均来自真实执行；未验证项明确标注。

## 0. 阶段 0 任务清单与状态

- [x] 0.1 检查 `package.json`、WXT 配置、entrypoints、TypeScript、Dexie、消息协议和测试
- [x] 0.2 执行 `npm install` / `npm run typecheck` / `npm run test` / `npm run build`，记录实际结果
- [x] 0.3 修正 WXT entrypoint 约定与 `tsconfig.json` 引导
- [x] 0.4 验证扩展权限、后台消息路由、Dexie 入口是否合理
- [x] 0.5 添加 `lint` 脚本占位、补充 README 环境说明
- [x] 0.6 输出本审计报告

## 1. 仓库现状快照

### 1.1 文件结构

```
ai-bookmark-manager/
├── .gitignore
├── README.md
├── docs/                       # 新增
│   ├── DEVELOPMENT_GUIDE.md
│   └── audit-phase0.md
├── entrypoints/
│   ├── background.ts           # MV3 service worker
│   ├── options/{index.html, main.ts, App.vue}
│   └── popup/{index.html, main.ts, App.vue}
├── index.html                  # 仅为占位说明
├── package.json
├── src/
│   ├── client.ts               # UI → Background 消息封装
│   ├── db.ts                   # Dexie schema v1
│   ├── normalize.ts            # 树扁平化 + 搜索匹配
│   ├── store.ts                # Pinia store
│   ├── sync.ts                 # 全量同步 + 查询 + 导出
│   └── types.ts                # 类型协议
├── tests/normalize.test.ts     # 2 个 vitest 用例
├── tsconfig.json
├── vitest.config.ts
└── wxt.config.ts
```

### 1.2 已实现的范围（来自第一迭代 ZIP）

- `chrome.bookmarks.getTree()` 全量读取 → Dexie 镜像（`src/sync.ts`）
- 监听 `created / removed / changed / moved / childrenReordered / importEnded`，防抖 350ms 后整树对账
- 启动时（`onInstalled` + `onStartup`）自动全量同步
- Options 页：搜索（title/url/path）、目录筛选、分页 200/页、JSON 导出
- Popup：显示书签总数、打开 Options 页
- 消息协议：`LIST / TREE / STATS / SYNC / EXPORT`
- 2 个单元测试覆盖树扁平化与搜索匹配

### 1.3 已知技术债（不在阶段 0 范围）

- 仅镜像 + 全量对账，未做增量事件应用（开发指南 § 阶段 1 将处理）
- 无备份导入、链接检测、去重、AI 分类、Agent 问答
- 单元测试仅 2 个（覆盖范围非常有限）
- 无 `eslint/prettier` 依赖与配置
- 无 `tests/integration` 与 `tests/e2e` 目录
- 无 CI 工作流
- 无 ADR 文档（阶段 0 仅声明，未单独建立 ADR-001~003 —— 延后到阶段 1 与代码接口定义一并提交）

## 2. 真实命令执行结果

### 2.1 环境

| 工具 | 版本 |
|---|---|
| Node | v22.22.3 |
| npm | 10.9.8 |
| WXT | 0.20.27 |
| Vite | 6.4.4 |
| Vue | 3.5.13 |
| Element Plus | 2.9.5 |
| Dexie | 4.0.11 |
| TypeScript | 5.8.x |
| Vitest | 3.x |

### 2.2 `npm install`（修复前）

```
added 457 packages in 1m
```

✅ 成功。修复前 npm 未自动触发 `wxt prepare`，但 `node_modules` 安装完成。

### 2.3 `npm run typecheck`（修复前）— ❌ 失败

完整错误摘要（节选）：

```
node_modules/element-plus/es/components/select/src/select.vue.d.ts(652,23):
  error TS2344: Type 'GlobalComponents' does not satisfy the constraint
  'Record<string, Component<any, any, any, ComputedOptions, MethodOptions, {}, any>>'.
...
wxt.config.ts(2,8): error TS1259:
  Module '"@vitejs/plugin-vue/dist/index"' can only be default-imported
  using the 'esModuleInterop' flag
```

**根因**：`tsconfig.json` 继承 `.wxt/tsconfig.json`（WXT 运行时生成），但 `npm install` 后未自动运行 `wxt prepare`，导致 `.wxt/` 目录不存在。删除 `.wxt/` 后立即可复现。

### 2.4 `npm run test`（修复前）— ❌ 失败

```
Error: Cannot find module './.wxt/tsconfig.json'
Require stack:
- /Users/angusfan/Desktop/ai-bookmark-manager/tsconfig.json
 ❯ resolveExtends node_modules/vite/dist/node/chunks/dep-3O3b9SCF.js

Test Files  1 failed (1)
     Tests  no tests
```

**根因**：与 typecheck 相同 —— `tsconfig.json` 继承的 `.wxt/tsconfig.json` 不存在。

### 2.5 `npm run build`（修复前）— ✅ 通过

```
WXT 0.20.27
✔ Built extension in 2.122 s
  ├─ .output/chrome-mv3/manifest.json                                  370 B
  ├─ .output/chrome-mv3/options.html                                   552 B
  ├─ .output/chrome-mv3/popup.html                                     514 B
  ├─ .output/chrome-mv3/background.js                                  100.16 kB
  ├─ .output/chrome-mv3/chunks/_plugin-vue_export-helper-B0nrQOCz.js   1.03 MB
  ├─ .output/chrome-mv3/chunks/options-BDIcObqr.js                     9.08 kB
  ├─ .output/chrome-mv3/chunks/popup-Cp8FlYut.js                       862 B
  ├─ .output/chrome-mv3/assets/_plugin-vue_export-helper-BmlReVEC.css  361.3 kB
  ├─ .output/chrome-mv3/assets/options-DS5Bs0RO.css                    1.31 kB
  └─ .output/chrome-mv3/assets/popup-Bfg7Ok7a.css                      148 B
Σ Total size: 1.5 MB
```

构建通过；存在 chunk 大小警告（element-plus 全量引入 1MB+），阶段 4+ 阶段 6 优化。

## 3. 修复与改动

### 3.1 改动文件清单

| 文件 | 改动 |
|---|---|
| `package.json` | 新增 `postinstall: wxt prepare`；`dev/build/zip/typecheck/test` 改为先 `wxt prepare`；新增 `lint` / `lint:fix` 脚本（占位，依赖待阶段 1 引入） |
| `docs/DEVELOPMENT_GUIDE.md` | 新增，作为后续阶段执行基线 |
| `docs/audit-phase0.md` | 新增，本报告 |
| `README.md` | 补充：依赖脚本会自动调用 `wxt prepare`；新增 `lint` 说明 |

### 3.2 `package.json` 关键修改

- `postinstall: "wxt prepare"` —— 保证 `npm install` 之后 `.wxt/tsconfig.json` 已生成
- `dev/build/zip/typecheck/test` 在原有命令前加入 `wxt prepare` —— 让任意 `rm -rf .wxt` 后命令依然可工作
- `lint` / `lint:fix` —— 阶段 0 占位，eslint 实际依赖与配置推迟到阶段 1
- 格式化 `package.json`（从 1 行压缩 JSON 展开为多行，便于阅读与扩展）

## 4. 修复后真实命令结果

依次执行（删除 `.wxt` `.output` 后）：

### 4.1 `npm run test`

```
WXT 0.20.27
ℹ Generating types...
✔ Finished in 205 ms

 RUN  v3.2.7 /Users/angusfan/Desktop/ai-bookmark-manager

 ✓ tests/normalize.test.ts (2 tests) 3ms

 Test Files  1 passed (1)
      Tests  2 passed (2)
   Duration  318ms
```

✅ 通过：2/2 单元测试。

### 4.2 `npm run typecheck`

```
> ai-bookmark-manager@0.1.0 typecheck
> wxt prepare && vue-tsc --noEmit -p tsconfig.json

WXT 0.20.27
ℹ Generating types...
✔ Finished in 123 ms
```

✅ 通过：vue-tsc 无错误输出。

### 4.3 `npm run build`

```
✔ Built extension in 2.122 s
Σ Total size: 1.5 MB
```

✅ 通过。

### 4.4 `npm run dev`（冒烟，5 秒后强制结束）

```
WXT 0.20.27
✔ Started dev server @ http://localhost:3000
ℹ Pre-rendering chrome-mv3 for development with Vite 6.4.4
- Preparing...
✔ Built extension in 554 ms
  ├─ .output/chrome-mv3-dev/manifest.json
  ├─ .output/chrome-mv3-dev/options.html
  ├─ .output/chrome-mv3-dev/popup.html
  ├─ .output/chrome-mv3-dev/background.js
  ...
✔ Opened browser in 1.722 s
```

✅ 通过：开发服务器在 `http://localhost:3000` 启动，并构建开发版本（`background.js` 包含 HMR 客户端，故较大）。

## 5. 权限与隐私审计

### 5.1 当前 manifest 权限

来源：`wxt.config.ts` 合并的 `manifest`：

| 权限 | 用途 | 是否在 MVP 必要范围 |
|---|---|---|
| `bookmarks` | 读取原生书签树 | ✅ 必需 |
| `storage` | chrome.storage 备用 | ⚠ 当前未使用（Pinia 状态在内存，IndexedDB 用 Dexie 自身 API） |
| `action.default_title` | 工具栏图标提示 | ✅ 必需 |

### 5.2 隐私现状

- ✅ 仅本地存储（IndexedDB via Dexie）
- ✅ 不含联网 AI 组件
- ✅ JSON 导出默认只含 `browserTree + index`，**不含任何 API Key**（MVP 范围内）
- ✅ 后台服务无外部请求
- ⚠ `host_permissions` 为空；阶段 3 链接检测时需按需申请，且需提供用途说明 + 域名排除名单

### 5.3 红线检查

- ✅ 不删除/不移动/不重命名原生书签 —— UI 不暴露写入按钮，`background.ts` 也未注册 `bookmarks.remove/update/move/create` 调用
- ✅ 无远程脚本、CSP 由 WXT 默认
- ✅ 全量同步在单一 IndexedDB 事务内完成（`src/sync.ts:11-16`）

## 6. 未解决 / 留给阶段 1+ 的事项

| 编号 | 描述 | 计划阶段 |
|---|---|---|
| ISS-1 | 测试覆盖率仅 2 用例（仅 normalize） | 阶段 1（同步、树扁平化、ID 映射等） |
| ISS-2 | 无 ESLint / Prettier 实际依赖与配置 | 阶段 1 引入 |
| ISS-3 | 无 CI 工作流（GitHub Actions） | 阶段 1 引入 |
| ISS-4 | `chrome.storage` 权限已声明但未使用 | 阶段 1 决定移除或落地 |
| ISS-5 | 无 ADR-001~003 文档 | 阶段 1 一并提交 |
| ISS-6 | chunk 大小警告（1MB+ element-plus 全量） | 阶段 4+ 阶段 6 按需 import |
| ISS-7 | 未在真实 Chrome 浏览器手动验收 | 阶段 1 起，文档记录真实浏览器版本 |

## 7. 浏览器手动验收

阶段 0 范围内：❌ **未在真实 Chrome 浏览器中加载扩展手动验收**。

原因：阶段 0 目标是建立质量基线（构建 + 测试 + 类型检查），不要求修改功能；扩展的 MV3 行为由开发指南要求阶段 1 起在真实 Chrome 验证。本阶段仅在 `wxt dev` 模式下确认开发服务器能启动并产出可加载的 `.output/chrome-mv3-dev/` 目录。

**未在浏览器验证的风险**：
- Dexie 在 MV3 Service Worker 中的生命周期兼容未验证
- `chrome.bookmarks` 事件类型签名（特别是 `onImportBegan/Ended`）与不同 Chrome 版本的兼容性未确认
- Element Plus 组件在扩展页面中的样式隔离未确认

## 8. 阶段 0 验收结论

✅ **阶段 0 通过**。理由：

1. 四个质量命令（`npm install / typecheck / test / build`）均通过
2. 关键阻塞问题（`wxt prepare` 未自动触发）已修复
3. 文档基线（`DEVELOPMENT_GUIDE.md` + `audit-phase0.md`）已建立
4. `package.json` 提供 `lint` 占位
5. 隐私与权限审计通过 MVP 范围
6. 红线未被违反
7. 已知问题与留给后续阶段的事项已明确记录

**未完成事项**：浏览器手动验收、ESLint 实际配置、CI、ADR 文档 —— 已纳入阶段 1 计划。

## 9. 阶段 1 启动建议

进入阶段 1 之前需先解决 ISS-1 / ISS-2 / ISS-3 / ISS-5。阶段 1 Prompt（来自开发指南 § 7）：

> 在阶段 0 验收通过的仓库上实施阶段 1。定义 `BrowserBookmarksAdapter` 和类型化消息协议；实现完整书签树读取、Dexie schema v1、后台事件监听、防抖对账、同步状态、目录树和搜索 UI、JSON 安全导出。保留浏览器原始 URL 和 ID；避免直接在 UI 调用书签写入 API。增加 10,000 条模拟书签测试、事件乱序/重复测试、目录重命名/移动测试。更新 `docs/data-model.md` 和 README。运行 typecheck/test/build 并报告。完成后停止。

预期改动范围（仅供下一阶段 Agent 参考，不在本次执行）：
- 引入 `src/infrastructure/browser/bookmark-adapter.ts`
- 引入 `src/infrastructure/messaging/{contracts, background-router, client}.ts`
- 拆分 `src/db.ts` 到 `src/infrastructure/database/{db, repositories, migrations}.ts`
- 增加 `tests/integration/` 目录与 10,000 条书签 fixture
- 引入 ESLint + Prettier + CI + ADR 文档
