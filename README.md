# 戏曲舞台口令服务

制作团队用结构化口令包衔接灯光、字幕、锣鼓和上下场动作。`contracts/domain.json` 保存领域对象与枚举，`src/server.js` 提供单进程 HTTP 服务，默认监听 8082 端口并暴露 `GET /health`。

服务覆盖巡演替演场景的人员资格与场次交接：

- **角色版本**：记录演员、替演顺位、已通过的排练片段、动作限制与有效期；同一角色同一时刻只有一个放行版。
- **临时换角**：申请即冻结当前放行版与受影响口令，系统沿依赖图找出需要重确认的灯光、道具、机械、舞台走位；校验替演顺位、排练片段、动作限制与有效期。
- **按职责签署**：替演本人、受影响执行组（按执行口逐一重确认口令）、监督全部签署后才生成本场授权；任何人不能代签自己的复核（替演不得复核自己的换角，申请人不得担任本次监督，一人只能签一个职责）。
- **资源租约**：同一替演（`person:<id>`）或同一高风险设备（`equipment:<id>`）同一时间只能租给一个场次，冲突时只有唯一成功结果。
- **开演后变更**：人员再次变化只能从开演前预先验证的安全点切换；迟到排练回执只登记不改写已执行动作；紧急人工跳过必须记录原因与责任人。
- **持久化**：所有变更以追加事件写入 `data/events.jsonl`（可用 `DATA_DIR` 覆盖），进程重启后未过期授权、待签交接与资源租约继续有效。
- **散场复盘**：`GET /shows/:id/review` 按真实顺序还原人员变更、重新确认的口令、被阻断动作及最终执行依据。

## 主要接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| PUT | `/people/:id` | 登记人员及岗位（actor / understudy / supervisor / crew:<执行口>） |
| POST | `/shows` | 创建场次（startsAt/endsAt） |
| POST | `/shows/:id/roles/:roleId/versions` | 新建角色版本 |
| POST | `/shows/:id/roles/:roleId/versions/:version/release` | 放行版本 |
| POST | `/shows/:id/cues` | 新建口令（类型、执行口、依赖、所需排练片段、高风险设备） |
| POST | `/shows/:id/safety-points` | 开演前由监督预先验证安全点 |
| POST | `/shows/:id/cast-changes` | 临时换角申请（冻结放行版与受影响口令） |
| POST | `/shows/:id/cast-changes/:cc/signatures` | 按职责签署，签齐自动生成授权 |
| POST | `/shows/:id/cast-changes/:cc/cancel` | 撤销待签申请（解冻并释放租约） |
| GET | `/shows/:id/readiness` | 开演前安全检查（能否开演） |
| POST | `/shows/:id/open` · `/close` | 开演 / 散场（开演时租约高风险设备） |
| POST | `/shows/:id/executions` | 执行口令（校验授权与冻结状态） |
| POST | `/shows/:id/skips` | 紧急人工跳过（需原因与责任人） |
| POST | `/shows/:id/rehearsal-receipts` | 登记排练回执（迟到回执标记 late） |
| GET | `/shows/:id/review` | 散场复盘时间线 |
| GET | `/leases` | 资源租约现状 |

## 测试

```bash
npm test
```

## 编译或构建

```bash
npm run build
```

## 启动

```bash
npm start
```

领域载荷使用 JSON，时间使用带时区的 RFC 3339 字符串。人员只以 id 引用，不登记姓名等身份信息；日志不得写入联系人、身份信息或原始凭据。
