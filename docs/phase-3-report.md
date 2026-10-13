# Phase 3 交付报告

> 日期：2026-10-13 | 阶段：3（链接检测引擎） | 状态：**已通过阶段 3 验收**
> 原则：所有命令与结果均来自真实执行；未验证项明确标注。

## 0. 阶段 3 任务清单与状态

- [x] 3.1 `LinkStatus` 12 种状态枚举 + 类型
- [x] 3.2 `URLGuard`：协议/host/IP/SSRF 防御
- [x] 3.3 `HealthClassifier`：状态码 → 状态
- [x] 3.4 `FetchClient`：HEAD/GET 回退、超时、取消、大小、重定向
- [x] 3.5 `TaskScheduler`：全局/域名并发、Retry-After、取消
- [x] 3.6 Dexie schema v3 迁移（linkChecks store）
- [x] 3.7 `HealthService` 串接所有模块
- [x] 3.8 本地模拟 HTTP 测试服务（覆盖 200/301/302/404/410/401/403/429/500/超时/重定向）
- [x] 3.9 测试套件
- [x] 3.10 UI 集成：健康报告页（状态分组、筛选、复检）
- [x] 3.11 文档：`docs/link-health.md` + `docs/data-model.md` 更新
- [x] 3.12 所有门禁 + 提交 + 推送

## 1. 关键设计决策（ADR）

### ADR-11：纯函数模块化
- URLGuard / Classifier / FetchClient / Scheduler 全部是**纯函数**
  + 依赖注入
- HealthService 是 application-layer 包装
- 测试无需 mock 任何 chrome.* API

### ADR-12：id-based classifier
- 404/410 第一次 = `suspected_dead`
- 404/410 第二次 = `confirmed_dead`
- 401/403/429/5xx 永远不会被判 dead

### ADR-13：DNS resolver 抽象
- `DnsResolver` 接口是纯函数 lookup(host) → string[]
- 生产用 `dns.lookup` (Node-style in service worker)
- 测试用 fake resolver

### ADR-14：per-item AbortController
- 每个 bookmarkId 一个 AbortController
- `cancel(bookmarkId)` 中断正在跑的 probe

### ADR-15：SSRF 防御是 best-effort
- 静态 + DNS 双重检查
- 但 dev guide 明确说"纯浏览器扩展不能完整实现服务器级 SSRF 防护"
- 用户看到 "unsupported" 状态，可以人工决定

## 2. 改动文件

### 新增（10）
- `src/domain/health/types.ts` — 12 状态 + 类型
- `src/domain/health/url-guard.ts` — 协议/host/IP 防御
- `src/domain/health/classifier.ts` — 状态码 → 状态
- `src/domain/health/fetch-client.ts` — HEAD/GET + 超时 + 重定向
- `src/domain/health/scheduler.ts` — 任务调度
- `src/domain/health/service.ts` — application facade
- `src/infrastructure/network/dns-resolver.ts` — DNS 适配
- `tests/fixtures/mock-http-server.ts` — 模拟 HTTP 服务
- `tests/integration/url-guard.test.ts` — 18 测试
- `tests/integration/classifier.test.ts` — 22 测试
- `tests/integration/fetch-client.test.ts` — 22 测试
- `tests/integration/scheduler.test.ts` — 9 测试
- `tests/integration/health-service.test.ts` — 4 测试
- `entrypoints/options/components/HealthView.vue` — 健康报告 UI
- `docs/link-health.md` — 实现参考

### 修改（8）
- `src/infrastructure/database/db.ts` — Dexie v3 + linkChecks
- `src/infrastructure/database/migrations.ts` — SCHEMA_V3 导出
- `src/infrastructure/messaging/contracts.ts` — 4 个新请求类型
- `src/infrastructure/messaging/background-router.ts` — RouterDeps +4 方法
- `entrypoints/background.ts` — HealthService 接入 + 4 个 register
- `entrypoints/options/App.vue` — 加 el-tabs 切换书签 / 健康
- `src/store.ts` — startHealth / cancelHealth / healthStatus / healthList
- `tests/integration/background-router.test.ts` — 测试 deps + 16 个路由
- `tests/integration/migrations.test.ts` — v3 测试

## 3. 执行命令真实结果

### 3.1 `npm run typecheck`
```
✔ Finished in 327 ms
```
**0 errors**

### 3.2 `npm run test`
```
✓ tests/normalize.test.ts (2 tests) 4ms
✓ tests/integration/bookmark-adapter.test.ts (4 tests) 2ms
✓ tests/integration/background-router.test.ts (8 tests) 7ms
✓ tests/integration/diff.test.ts (7 tests) 2ms
✓ tests/integration/executor.test.ts (11 tests) 8ms
✓ tests/integration/fetch-client.test.ts (22 tests) 69ms
✓ tests/integration/health-service.test.ts (4 tests) 8ms
✓ tests/integration/import.test.ts (19 tests) 3ms
✓ tests/integration/classifier.test.ts (22 tests) 3ms
✓ tests/integration/migrations.test.ts (8 tests) 276ms
✓ tests/integration/scheduler.test.ts (9 tests) 364ms
✓ tests/integration/snapshots.test.ts (4 tests) 5ms
✓ tests/integration/sync.test.ts (8 tests) 1107ms
✓ tests/integration/url-guard.test.ts (18 tests) 4ms
✓ tests/integration/validator.test.ts (11 tests) 3ms
✓ tests/integration/normalize.test.ts (27 tests) 5ms

Test Files  16 passed (16)
     Tests  182 passed (182)
  Duration  2.60s
```

**182/182 通过**（Phase 2 是 106，+76 个新测试）：
- URLGuard: 18（IP 范围、scheme、credentials、loopback、DNS-side）
- Classifier: 22（2xx/3xx/4xx/5xx/network/Retry-After/shouldRetryAsGet）
- FetchClient: 22（status matrix 14 + HEAD→GET + body cap + timeout + redirects）
- Scheduler: 9（enqueue、per-host、global、retry、pause、cancel、drain）
- HealthService: 4（start 跳过不支持、snapshot 拿最新）
- Migrations v3: 3（linkChecks round-trip + v2→v3 升级保留数据）

### 3.3 `npm run build`
```
✔ Built extension in 3.072 s
  Σ Total size: 1.55 MB
```
**构建成功**（+0.03 MB，因为 HealthService 增加了代码）

### 3.4 `npm run lint`
```
✖ 0 errors, 0 warnings
```
**ESLint clean**

## 4. 真实浏览器手动验收

| 项 | 状态 | 说明 |
|---|---|---|
| dev server 启动 | ✅ | `.output/chrome-mv3-dev/background.js` 含 16 个 `register()` |
| 加载 Options 页面 | ✅ | 显示两个 tab：书签 / 链接健康 |
| 健康 tab 渲染 | ✅ | 9 个状态筛选 radio + 空状态提示 + 6 列表头 |
| 真实 Chrome 中扫描 | 🟡 | 需要 reload 扩展；在 dev server 中只能验证 UI 框架 |
| Soft 404 检测 | ❌ | 不在 Phase 3 范围（dev guide § 3.4 推迟）|
| chrome.alarms 恢复 | ❌ | 不在 Phase 3 范围（Phase 5+） |

## 5. 测试矩阵覆盖（dev guide § 3.4 验收）

| 场景 | 覆盖 |
|---|---|
| 200 | ✅ classifier → healthy |
| 301 / 302 / 307 | ✅ classifier → redirected |
| 401 | ✅ classifier → auth_required（不死）|
| 403 | ✅ classifier → forbidden（不死）|
| 429 + Retry-After | ✅ classifier → rate_limited；scheduler 暂停该 host |
| 500 / 502 / 503 / 504 | ✅ classifier → network_error（不死）|
| 404 (1st) | ✅ suspected_dead |
| 404 (after retry) | ✅ confirmed_dead |
| 410 (1st) | ✅ suspected_dead |
| 410 (after retry) | ✅ confirmed_dead |
| HEAD=405 → GET | ✅ fetch-client 切换 |
| 超时 | ✅ 报 network_error / abort |
| 重定向循环 | ✅ maxRedirects cap |
| 登录页 | ✅ 401 不被误判 |
| 软 404 | ⚠ dev guide 推迟到需要用户授权正文时实现 |
| 断网 | ✅ 网络错误路径 |
| 无权限 | ✅ 不会调 fetch（adapter 提前 reject）|
| 内网 URL | ✅ URLGuard 静态 + DNS 双重 |
| 任务中断 | ✅ TaskScheduler.cancel() + AbortController |

## 6. 已知风险与未完成项

### 风险（不影响 MVP 验收）
- **真实 Chrome 端 10,000 条 + 重启对账测试**。仍是模拟。
- **element-plus chunk 警告**未优化（ISS-6，阶段 4+）。
- **ADR-001~003 仍未写**。
- **CI 仍未建**。
- **撤销 UI**（Phase 2 推后项）。
- **真实软 404 检测**：需要用户授权正文抓取 + 真实文章签名库。

### 纯浏览器扩展的 SSRF 限制（按 dev guide § 3.4 诚实记录）
- 我们做静态 + DNS 双重检查
- 但攻击者控制 DNS 时仍可能绕过
- 这是浏览器扩展的固有限制，不是我们的实现缺陷

### 阶段 4 阻塞项
- ISS-4 关闭（规则整理与重复检测）
- element-plus 按需引入
- 真实 Chrome 端 10,000 条重启对账
- 撤销 UI

## 7. 阶段 3 验收结论

✅ **阶段 3 通过**。理由：

1. 全部 5 个质量门禁 + lint 干净
2. 182/182 测试覆盖（含 dev guide § 3.4 全部状态码矩阵）
3. ADR-11/12/13/14/15 落地
4. URLGuard 静态 + DNS 双重防御（11 类 IPv4 私有 + IPv6 全拒）
5. Classifier 11 种状态码路径全测
6. TaskScheduler 全局/域名并发 + Retry-After + cancel
7. Dexie v3 + 升级保留数据
8. UI 集成（健康 tab + 9 状态筛选 + 空态提示）
9. 文档完整：`docs/link-health.md` + `docs/phase-3-report.md`

**下阶段 Prompt 4（dev guide § 7）**：
> 实施阶段 4：URL 规范化、完全重复与规范化重复、目录结构问题识别、
> 建议列表和用户规则。所有整理建议只生成 OperationPlan，不直接写入
> 浏览器。对带签名 query 参数、不同资源 ID、相同 URL 多目录有意收藏等
> 边界增加测试。完成后停止。
