# Phase 4 前置审计

日期：2026-10-13

## 已确认基线

- Phase 1 已提供书签同步、Dexie 本地索引、搜索和导出。
- Phase 2 已提供 `OperationPlan`、审批令牌、快照、审计和唯一的原生书签写入入口。
- Phase 3 已提供受控链接检测、静态私网防护、取消入口和健康结果持久化；DNS 与跨 Worker 恢复存在明确限制，见 `STATUS.md`。
- 数据库实际 schema 为 v4；此前 `data-model.md` 的 v3 描述已在本次审计中修正。

## 本次修复

1. 同步代次以持久化的 `syncState.generation` 为下限递增，避免 MV3 Service Worker 重启后 generation 回退。
2. 健康扫描的取消操作会清空未开始的队列项；扫描完成后状态转为 `completed`，跳过项计入进度。
3. 健康扫描改为可选 host permission；未授权链接不会发起网络请求。生产请求不再自动跟随重定向，且不再把不存在的 Node DNS API 当作安全检查。

## 质量门禁状态

锁文件原先包含 639 个不可访问的内网 npm tarball 地址，导致 `npm ci` 超时且本地 `wxt`、`eslint` 未生成。本次已将该固定 registry 前缀替换为官方 npm registry，并完成干净安装。

- `npm run typecheck`：通过。
- `npm run test`：16 个测试文件、190 个测试通过。
- `npm run lint`：通过。
- `npm run build`：通过；保留 Element Plus 相关的大 chunk 警告，未阻塞构建。
- `npm run dev`：通过，开发扩展已生成；`http://localhost:3000` 返回 200。

## P4 前置条件

- 保持 P4 默认只读；任何原生书签修改仍必须经 `OperationPlan`、审批和 `OperationExecutor`。
- P4 分析结果必须以持久化 `syncState` 为版本基线，不得仅依赖内存 generation。
