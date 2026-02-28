# Matridx Ting 严格验收清单（A~H）

> 规则：A~H 必须全部通过，才允许交付。

## A 自动上传转写
- [ ] 录完上传模式，点击“停止录音”后自动触发上传与转写
- [ ] 无需手动点击“上传并转写”
- [ ] 最终 `recordings.status=transcribed`

## B 条目化会议笔记
- [ ] 同日多条会议分开记录，时间升序
- [ ] 每条包含：时间、贡献者、摘要、全文、来源
- [ ] `meeting_notes` 与 Markdown 文件一一对应

## C Realtime 路径
- [ ] realtime 结束后自动落库 transcript
- [ ] realtime 结束后自动落库 meeting note
- [ ] `meeting_notes.source=realtime`

## D 自动日报调度
- [ ] 用户时区正确上报（`PUT /users/me/timezone`）
- [ ] 本地时间 20:00 触发 `auto_20`
- [ ] 本地时间 23:30 触发 `auto_2330`
- [ ] 同日 `daily-summaries/YYYY/MM/DD/YYYYMMDD-{username}.md` 被最新版本覆盖

## E 无会议日处理
- [ ] 无会议当天仍生成日报（DB + 文件）
- [ ] 报告文案为“今日无会议记录”
- [ ] 无会议日不调用分析模型（无需 LLM Key）

## F 全链路失败注入
- [ ] 上传失败后可重试恢复
- [ ] 转写失败后可见错误且重试可恢复
- [ ] 会议笔记落盘失败可通过 `regenerate` 修复
- [ ] 日报落盘失败可通过 `regenerate` 修复
- [ ] 重复触发定时任务时去重生效（`daily_summary_runs`）

## G Agent 可读性
- [ ] `find NOTES_STORAGE_ROOT -name "*.md"` 可列出全部文件
- [ ] 抽样 frontmatter 字段完整且一致
- [ ] 文件命名符合约定

## H 离线可用
- [ ] 断网后可查看本地缓存 transcript
- [ ] 断网后可查看本地缓存 meeting notes
- [ ] UI 明确显示“离线缓存数据”

## 执行命令
- `pnpm qa:smoke`
- `pnpm qa:drill`
- 手工验收：按 A~H 逐项勾选，并附截图/日志
