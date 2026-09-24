import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server.js";

async function withServer(run, options = {}) {
  const server = createServer(options).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = () => `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base, server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function call(base, method, path, body) {
  const response = await fetch(`${base()}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

const T0 = "2026-09-24T19:00:00Z";
const T_END = "2026-09-24T22:00:00Z";
const at = (minutes) => new Date(Date.parse(T0) + minutes * 60000).toISOString();

/** 搭建标准舞台：主演、替演、监督、四个执行组及组员。 */
async function setupWorld(base) {
  const ids = {};
  const mk = async (path, body) => {
    const { status, json } = await call(base, "POST", path, body);
    assert.equal(status, 200, JSON.stringify(json));
    return json;
  };
  ids.show = (await mk("/v1/shows", { id: "show1", title: "霸王别姬" })).id;
  for (const [id, name, kind, groupType] of [
    ["lead", "主演", "performer", null],
    ["under", "替演", "performer", null],
    ["under2", "二号替演", "performer", null],
    ["sm", "舞台监督", "stage_manager", null],
    ["g_light", "灯光组", "group", "light"],
    ["g_mech", "机械组", "group", "machinery"],
    ["g_prop", "道具组", "group", "prop"],
    ["g_block", "走位组", "group", "blocking"],
    ["m_light", "灯光组员", "performer", "light"],
    ["m_mech", "机械组员", "performer", "machinery"],
    ["m_prop", "道具组员", "performer", "prop"],
    ["m_block", "走位组员", "performer", "blocking"],
  ]) {
    ids[id] = (await mk("/v1/people", { id, name, kind, groupType })).id;
  }

  // L1灯光 → M1升降台(lift) → P1烟火(pyro) → B1快速换景(quick_change)；X1 与角色无关。
  ids.pkg = (
    await mk("/v1/packages", {
      id: "pkg1",
      showId: ids.show,
      version: 3,
      cues: [
        { id: "L1", type: "light", roles: ["yu"], rehearsalSegments: ["s1"] },
        {
          id: "M1", type: "machinery", action: "lift", roles: ["yu"],
          rehearsalSegments: ["s1"], equipmentIds: ["eq_lift"], dependsOn: ["L1"],
        },
        {
          id: "P1", type: "prop", action: "pyro", roles: ["yu"],
          rehearsalSegments: ["s2"], equipmentIds: ["eq_fire"], dependsOn: ["M1"],
        },
        {
          id: "B1", type: "blocking", action: "quick_change", roles: ["yu"],
          rehearsalSegments: ["s3"], dependsOn: ["P1"],
        },
        { id: "X1", type: "light", roles: [] },
      ],
    })
  ).id;

  ids.role = (
    await mk("/v1/role-versions", {
      id: "role1", showId: ids.show, roleId: "yu", roleName: "虞姬",
      leadPerformerId: ids.lead,
      understudies: [{ performerId: ids.under, order: 1 }, { performerId: ids.under2, order: 2 }],
      validFrom: "2026-09-20T00:00:00Z", validTo: "2026-10-01T00:00:00Z",
    })
  ).id;

  return ids;
}

async function trainUnderstudy(base, ids) {
  const mk = async (path, body) => (await call(base, "POST", path, body)).json;
  for (const segmentId of ["s1", "s2", "s3"]) {
    await mk("/v1/rehearsal-receipts", { roleVersionId: ids.role, performerId: ids.under, segmentId });
  }
  for (const action of ["lift", "pyro", "quick_change"]) {
    await mk("/v1/rehearsal-receipts", { roleVersionId: ids.role, performerId: ids.under, action });
  }
}

async function openPerformance(base, ids, perfId = "perf1", startAt = T0, endAt = T_END) {
  const perf = (await call(base, "POST", "/v1/performances", { id: perfId, showId: ids.show, startAt, endAt })).json;
  await call(base, "POST", `/v1/performances/${perfId}/release`, { packageId: ids.pkg });
  return perf;
}

const GROUP_OF_CUE = { L1: "light", M1: "machinery", P1: "prop", B1: "blocking" };

async function completeRequest(
  base,
  ids,
  requestId,
  { decisions = {}, understudyId = ids.under } = {},
) {
  const report = (await call(base, "GET", `/v1/change-requests/${requestId}`)).json;
  for (const { cueId, cueType } of report.impactedCues) {
    const member = { light: ids.m_light, machinery: ids.m_mech, prop: ids.m_prop, blocking: ids.m_block }[cueType];
    const r = await call(base, "POST", `/v1/change-requests/${requestId}/reconfirmations`, {
      cueId, decision: decisions[cueId] ?? "confirmed", personId: member,
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  await call(base, "POST", `/v1/change-requests/${requestId}/signatures`, {
    role: "understudy", personId: understudyId,
  }).then((r) => assert.equal(r.status, 200, JSON.stringify(r.json)));
  for (const cueType of new Set(report.impactedCues.map((c) => c.cueType))) {
    const group = { light: ids.g_light, machinery: ids.g_mech, prop: ids.g_prop, blocking: ids.g_block }[cueType];
    const r = await call(base, "POST", `/v1/change-requests/${requestId}/signatures`, {
      role: `group:${cueType}`, personId: group,
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  const sm = await call(base, "POST", `/v1/change-requests/${requestId}/signatures`, {
    role: "stage_manager", personId: ids.sm,
  });
  assert.equal(sm.status, 200, JSON.stringify(sm.json));
}

test("依赖图闭包：换角申请冻结放行版并圈定全部受影响口令", async () => {
  await withServer(async (base) => {
    const ids = await setupWorld(base);
    await openPerformance(base, ids);
    const req = (
      await call(base, "POST", `/v1/performances/perf1/change-requests`, {
        roleVersionId: ids.role, replacementPerformerId: ids.under, reason: "injury",
      })
    ).json;
    assert.deepEqual(req.impactedCueIds, ["L1", "M1", "P1", "B1"]);
    assert.equal(req.frozenPackageVersion, 3);
    assert.equal(req.status, "frozen");
    // 未列入替演顺位的演员不能申请。
    const bad = await call(base, "POST", `/v1/performances/perf1/change-requests`, {
      roleVersionId: ids.role, replacementPerformerId: ids.lead, reason: "other",
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, "not_listed_understudy");
  });
});

test("资格：缺排练片段或缺高风险演练时报告缺口，补齐后放行", async () => {
  await withServer(async (base) => {
    const ids = await setupWorld(base);
    await openPerformance(base, ids);
    // 只通过 s1 + lift，未练 pyro / quick_change。
    await call(base, "POST", "/v1/rehearsal-receipts", { roleVersionId: ids.role, performerId: ids.under, segmentId: "s1" });
    await call(base, "POST", "/v1/rehearsal-receipts", { roleVersionId: ids.role, performerId: ids.under, action: "lift" });
    const req = (
      await call(base, "POST", `/v1/performances/perf1/change-requests`, {
        roleVersionId: ids.role, replacementPerformerId: ids.under, reason: "injury",
      })
    ).json;
    const byCue = Object.fromEntries(req.impactedCues.map((c) => [c.cueId, c]));
    assert.equal(byCue.L1.qualification.eligible, true);
    assert.ok(byCue.P1.qualification.reasons.some((r) => r === "missing_action_drill:pyro"));
    assert.ok(byCue.B1.qualification.reasons.includes("missing_segment:s3"));
  });
});

test("签署按职责对号入座，且不能代签自己的复核", async () => {
  await withServer(async (base) => {
    const ids = await setupWorld(base);
    await trainUnderstudy(base, ids);
    await openPerformance(base, ids);
    const req = (
      await call(base, "POST", `/v1/performances/perf1/change-requests`, {
        roleVersionId: ids.role, replacementPerformerId: ids.under, reason: "injury",
      })
    ).json;

    // 机械组员先复核 M1……
    const r1 = await call(base, "POST", `/v1/change-requests/${req.id}/reconfirmations`, {
      cueId: "M1", decision: "confirmed", personId: ids.m_mech,
    });
    assert.equal(r1.status, 200);
    // ……灯光组员不能复核机械口令。
    const r2 = await call(base, "POST", `/v1/change-requests/${req.id}/reconfirmations`, {
      cueId: "M1", decision: "confirmed", personId: ids.m_light,
    });
    assert.equal(r2.status, 403);
    assert.equal(r2.json.error, "wrong_execution_group");

    // 主演不能冒充替演本人签。
    const s1 = await call(base, "POST", `/v1/change-requests/${req.id}/signatures`, {
      role: "understudy", personId: ids.lead,
    });
    assert.equal(s1.status, 403);
    assert.equal(s1.json.error, "must_be_understudy");

    // 该机械组员若改坐机械组签署席 → 自签复核，禁止。
    const s2 = await call(base, "POST", `/v1/change-requests/${req.id}/signatures`, {
      role: "group:machinery", personId: ids.m_mech,
    });
    assert.equal(s2.status, 403);
    assert.equal(s2.json.error, "cannot_countersign_own_review");

    // 补齐其余复核（M1 已有），走完合法签署。
    const report = (await call(base, "GET", `/v1/change-requests/${req.id}`)).json;
    for (const cueId of ["L1", "P1", "B1"]) {
      const member = { L1: ids.m_light, P1: ids.m_prop, B1: ids.m_block }[cueId];
      await call(base, "POST", `/v1/change-requests/${req.id}/reconfirmations`, {
        cueId, decision: "confirmed", personId: member,
      });
    }
    await call(base, "POST", `/v1/change-requests/${req.id}/signatures`, {
      role: "understudy", personId: ids.under,
    });
    // 监督也不能顶组席。
    const s3 = await call(base, "POST", `/v1/change-requests/${req.id}/signatures`, {
      role: "group:machinery", personId: ids.sm,
    });
    assert.equal(s3.status, 403);
    for (const cueType of ["light", "machinery", "prop", "blocking"]) {
      const group = { light: ids.g_light, machinery: ids.g_mech, prop: ids.g_prop, blocking: ids.g_block }[cueType];
      await call(base, "POST", `/v1/change-requests/${req.id}/signatures`, {
        role: `group:${cueType}`, personId: group,
      });
    }
    await call(base, "POST", `/v1/change-requests/${req.id}/signatures`, {
      role: "stage_manager", personId: ids.sm,
    });
    const ready = (await call(base, "GET", `/v1/change-requests/${req.id}`)).json;
    assert.equal(ready.status, "ready");
  });
});

test("任一口令被阻断则申请不能授权；改判并补齐后可授权", async () => {
  await withServer(async (base) => {
    const ids = await setupWorld(base);
    await trainUnderstudy(base, ids);
    await openPerformance(base, ids);
    const req = (
      await call(base, "POST", `/v1/performances/perf1/change-requests`, {
        roleVersionId: ids.role, replacementPerformerId: ids.under, reason: "injury",
      })
    ).json;
    await completeRequest(base, ids, req.id, { decisions: { B1: "blocked" } });
    let report = (await call(base, "GET", `/v1/change-requests/${req.id}`)).json;
    assert.equal(report.status, "frozen");
    const denied = await call(base, "POST", `/v1/change-requests/${req.id}/authorize`, {});
    assert.equal(denied.status, 409);
    assert.deepEqual(denied.json.blockedCues, ["B1"]);

    // 走位组改判 confirmed（历史事件保留，最新判定生效）。
    const revised = await call(base, "POST", `/v1/change-requests/${req.id}/reconfirmations`, {
      cueId: "B1", decision: "confirmed", personId: ids.m_block,
    });
    assert.equal(revised.status, 200);
    report = (await call(base, "GET", `/v1/change-requests/${req.id}`)).json;
    assert.equal(report.status, "ready");
    const auth = (await call(base, "POST", `/v1/change-requests/${req.id}/authorize`, {})).json;
    assert.equal(auth.status, "active");
    assert.deepEqual(auth.scopeCueIds.sort(), ["B1", "L1", "M1", "P1"]);
    assert.equal(auth.leaseIds.length, 3); // 替演本人 + 升降台 + 烟火装置
  });
});

test("租约：两个场次同时借用同一替演或同一高风险设备只给唯一结果", async () => {
  await withServer(async (base) => {
    const ids = await setupWorld(base);
    await trainUnderstudy(base, ids);
    await openPerformance(base, ids, "perf1");
    await openPerformance(base, ids, "perf2", "2026-09-24T19:30:00Z", "2026-09-24T22:30:00Z");

    const req1 = (
      await call(base, "POST", `/v1/performances/perf1/change-requests`, {
        roleVersionId: ids.role, replacementPerformerId: ids.under, reason: "injury",
      })
    ).json;
    await completeRequest(base, ids, req1.id);
    const auth1 = (await call(base, "POST", `/v1/change-requests/${req1.id}/authorize`, {})).json;
    assert.equal(auth1.status, "active");

    // 同场次重复申请租约幂等；第二场次重叠窗口抢人 → 唯一冲突。
    const again = await call(base, "POST", "/v1/leases", {
      performanceId: "perf1", resourceKind: "performer", resourceId: ids.under, roleId: "yu",
    });
    assert.equal(again.status, 200);
    const conflict = await call(base, "POST", "/v1/leases", {
      performanceId: "perf2", resourceKind: "performer", resourceId: ids.under, roleId: "yu",
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error, "lease_conflict");
    assert.equal(conflict.json.holder.performanceId, "perf1");

    // 设备同理：第二场次抢烟火装置被拒。
    const eqConflict = await call(base, "POST", "/v1/leases", {
      performanceId: "perf2", resourceKind: "equipment", resourceId: "eq_fire", roleId: "yu",
    });
    assert.equal(eqConflict.status, 409);
    assert.equal(eqConflict.json.holder.performanceId, "perf1");

    // 不重叠的窗口可以租到（释放唯一约束后）。
    const later = await call(base, "POST", "/v1/leases", {
      performanceId: "perf2", resourceKind: "equipment", resourceId: "eq_fire", roleId: "yu",
      startAt: "2026-09-24T23:00:00Z", endAt: "2026-09-24T23:30:00Z",
    });
    assert.equal(later.status, 200);
  });
});

test("开演后只能从预先验证并已到达的安全点切换，支持再次伤停换人", async () => {
  await withServer(async (base) => {
    const ids = await setupWorld(base);
    await trainUnderstudy(base, ids);
    // 二号替演也练全。
    for (const segmentId of ["s1", "s2", "s3"]) {
      await call(base, "POST", "/v1/rehearsal-receipts", { roleVersionId: ids.role, performerId: ids.under2, segmentId });
    }
    for (const action of ["lift", "pyro", "quick_change"]) {
      await call(base, "POST", "/v1/rehearsal-receipts", { roleVersionId: ids.role, performerId: ids.under2, action });
    }
    await openPerformance(base, ids);
    const req = (
      await call(base, "POST", `/v1/performances/perf1/change-requests`, {
        roleVersionId: ids.role, replacementPerformerId: ids.under, reason: "injury",
      })
    ).json;
    await completeRequest(base, ids, req.id);
    const authA = (await call(base, "POST", `/v1/change-requests/${req.id}/authorize`, {})).json;

    // 安全点必须在开演前申报；开演后不得临时增设。
    const lateDeclare = await call(base, "POST", "/v1/performances/perf1/start", {});
    assert.equal(lateDeclare.status, 200);
    const late = await call(base, "POST", "/v1/performances/perf1/safety-points", { cueId: "M1" });
    assert.equal(late.status, 409);
    assert.equal(late.json.error, "performance_already_started");
  });

  await withServer(async (base) => {
    const ids = await setupWorld(base);
    await trainUnderstudy(base, ids);
    for (const segmentId of ["s1", "s2", "s3"]) {
      await call(base, "POST", "/v1/rehearsal-receipts", { roleVersionId: ids.role, performerId: ids.under2, segmentId });
    }
    for (const action of ["lift", "pyro", "quick_change"]) {
      await call(base, "POST", "/v1/rehearsal-receipts", { roleVersionId: ids.role, performerId: ids.under2, action });
    }
    await openPerformance(base, ids);

    const reqA = (
      await call(base, "POST", `/v1/performances/perf1/change-requests`, {
        roleVersionId: ids.role, replacementPerformerId: ids.under, reason: "injury",
      })
    ).json;
    await completeRequest(base, ids, reqA.id);
    const authA = (await call(base, "POST", `/v1/change-requests/${reqA.id}/authorize`, {})).json;

    // 开演前申报 M1 之后为安全点。
    const safe = (await call(base, "POST", "/v1/performances/perf1/safety-points", { id: "safe1", cueId: "M1" })).json;
    const started = await call(base, "POST", "/v1/performances/perf1/start", {});
    assert.deepEqual(started.json.activeRoleAuthorizations, { yu: authA.id });

    // 未到达 M1：不能切。
    const early = await call(base, "POST", "/v1/performances/perf1/switches", {
      safetyPointId: safe.id, items: [{ roleId: "yu", authorizationId: authA.id }],
    });
    assert.equal(early.status, 409);
    assert.equal(early.json.error, "safety_point_not_reached");

    await call(base, "POST", "/v1/cue-executions", { performanceId: "perf1", cueId: "L1" });
    await call(base, "POST", "/v1/cue-executions", { performanceId: "perf1", cueId: "M1" });

    // 演出中替演 A 再次伤停：走完整换角流程生成 B 的授权（旧申请被取代）。
    const reqB = (
      await call(base, "POST", `/v1/performances/perf1/change-requests`, {
        roleVersionId: ids.role, replacementPerformerId: ids.under2, reason: "injury",
      })
    ).json;
    assert.equal((await call(base, "GET", `/v1/change-requests/${reqA.id}`)).json.status, "authorized");
    await completeRequest(base, ids, reqB.id, { understudyId: ids.under2 });
    const authB = (await call(base, "POST", `/v1/change-requests/${reqB.id}/authorize`, {})).json;

    // 只能在预验证安全点切换；旧授权耗尽、旧申请作废、旧演员租约释放。
    const sw = await call(base, "POST", "/v1/performances/perf1/switches", {
      safetyPointId: safe.id, items: [{ roleId: "yu", authorizationId: authB.id }],
    });
    assert.equal(sw.status, 200);
    assert.deepEqual(sw.json.deactivations, [authA.id]);
    assert.equal(sw.json.releasedLeaseIds.length, 1);
    assert.equal((await call(base, "GET", `/v1/change-requests/${reqA.id}`)).json.status, "superseded");

    const sw2 = await call(base, "POST", "/v1/performances/perf1/switches", {
      safetyPointId: safe.id, items: [{ roleId: "yu", authorizationId: authB.id }],
    });
    assert.equal(sw2.status, 409);
    assert.equal(sw2.json.error, "safety_point_used");

    // 旧授权不再可用于执行。
    const p1 = await call(base, "POST", "/v1/cue-executions", { performanceId: "perf1", cueId: "P1" });
    assert.equal(p1.status, 200);
    assert.deepEqual(p1.json.authorizationIds, [authB.id]);
  });
});

test("迟到排练回执不得改写已执行动作", async () => {
  await withServer(async (base) => {
    const ids = await setupWorld(base);
    // 只练到 lift：M1 当下可执行。
    await call(base, "POST", "/v1/rehearsal-receipts", { roleVersionId: ids.role, performerId: ids.under, segmentId: "s1" });
    await call(base, "POST", "/v1/rehearsal-receipts", { roleVersionId: ids.role, performerId: ids.under, action: "lift" });
    await openPerformance(base, ids);
    const req = (
      await call(base, "POST", `/v1/performances/perf1/change-requests`, {
        roleVersionId: ids.role, replacementPerformerId: ids.under, reason: "injury",
      })
    ).json;
    // 四条全部确认（监督决定带未练动作的口令本场不触发，先授权）。
    await completeRequest(base, ids, req.id);
    await call(base, "POST", `/v1/change-requests/${req.id}/authorize`, {});
    await call(base, "POST", "/v1/performances/perf1/start", {});
    const exe = (await call(base, "POST", "/v1/cue-executions", { performanceId: "perf1", cueId: "L1" })).json;
    assert.equal(exe.outcome, "executed");

    // 事后补一条失败回执：只是追加事实，已执行动作不回滚、不改写。
    await call(base, "POST", "/v1/rehearsal-receipts", {
      roleVersionId: ids.role, performerId: ids.under, segmentId: "s1", status: "failed", at: at(30),
    });
    const tl = (await call(base, "GET", "/v1/performances/perf1/timeline")).json.timeline;
    const exeIdx = tl.findIndex((e) => e.type === "cue_attempt_recorded" && e.payload.outcome === "executed");
    const receiptIdx = tl.findIndex((e) => e.type === "receipt_recorded" && e.payload.status === "failed");
    // 回执不属于本场时间线（跨场次事实），已执行记录原样保留。
    assert.ok(exeIdx >= 0);
    assert.equal(receiptIdx, -1);
    const second = await call(base, "POST", "/v1/cue-executions", { performanceId: "perf1", cueId: "L1" });
    assert.equal(second.status, 409);
    assert.equal(second.json.error, "already_executed");
  });
});

test("紧急人工跳过必须保留原因和责任人，且一次性使用", async () => {
  await withServer(async (base) => {
    const ids = await setupWorld(base);
    await trainUnderstudy(base, ids);
    await openPerformance(base, ids);
    const req = (
      await call(base, "POST", `/v1/performances/perf1/change-requests`, {
        roleVersionId: ids.role, replacementPerformerId: ids.under, reason: "injury",
      })
    ).json;
    await completeRequest(base, ids, req.id);
    await call(base, "POST", `/v1/change-requests/${req.id}/authorize`, {});
    await call(base, "POST", "/v1/performances/perf1/start", {});
    await call(base, "POST", "/v1/cue-executions", { performanceId: "perf1", cueId: "L1" });
    await call(base, "POST", "/v1/cue-executions", { performanceId: "perf1", cueId: "M1" });

    // 释放烟火设备租约制造阻断。
    const leases = (await call(base, "GET", "/v1/leases?resourceKind=equipment&resourceId=eq_fire")).json;
    await call(base, "POST", `/v1/leases/${leases[0].id}/release`, {});
    const blocked = await call(base, "POST", "/v1/cue-executions", { performanceId: "perf1", cueId: "P1" });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.error, "cue_blocked");

    // 无原因 / 非监督 → 拒绝。
    const noReason = await call(base, "POST", "/v1/bypasses", {
      performanceId: "perf1", cueId: "P1", reason: "   ", responsiblePersonId: ids.sm,
    });
    assert.equal(noReason.status, 400);
    const notSm = await call(base, "POST", "/v1/bypasses", {
      performanceId: "perf1", cueId: "P1", reason: "x", responsiblePersonId: ids.under,
    });
    assert.equal(notSm.status, 403);

    const byp = (await call(base, "POST", "/v1/bypasses", {
      performanceId: "perf1", cueId: "P1",
      reason: "烟火控制器通讯故障，监督现场核验手动发射流程", responsiblePersonId: ids.sm,
    })).json;
    const skipped = await call(base, "POST", "/v1/cue-executions", {
      performanceId: "perf1", cueId: "P1", bypassId: byp.id,
    });
    assert.equal(skipped.status, 200);
    assert.equal(skipped.json.outcome, "executed_with_bypass");
    assert.deepEqual(skipped.json.reasons, ["equipment_lease_missing:eq_fire"]);

    const reuse = await call(base, "POST", "/v1/cue-executions", {
      performanceId: "perf1", cueId: "B1", bypassId: byp.id,
    });
    assert.equal(reuse.status, 409);
    assert.equal(reuse.json.error, "bypass_already_used");
  });
});

test("动作限制：被限制升降台的替演即使练过也不具备 lift 资格", async () => {
  await withServer(async (base) => {
    const ids = await setupWorld(base);
    await trainUnderstudy(base, ids);
    // 角色版本层面对该替演追加 lift 限制。
    const restricted = await call(base, "POST", "/v1/role-versions", {
      id: "role2", showId: ids.show, roleId: "yu", roleName: "虞姬（受限）",
      leadPerformerId: ids.lead,
      understudies: [{ performerId: ids.under, order: 1, actionRestrictions: ["lift"] }],
      validFrom: "2026-09-20T00:00:00Z", validTo: "2026-10-01T00:00:00Z",
    });
    assert.equal(restricted.status, 200);
    for (const segmentId of ["s1", "s2", "s3"]) {
      await call(base, "POST", "/v1/rehearsal-receipts", { roleVersionId: "role2", performerId: ids.under, segmentId });
    }
    for (const action of ["lift", "pyro", "quick_change"]) {
      await call(base, "POST", "/v1/rehearsal-receipts", { roleVersionId: "role2", performerId: ids.under, action });
    }
    await openPerformance(base, ids);
    const req = (
      await call(base, "POST", `/v1/performances/perf1/change-requests`, {
        roleVersionId: "role2", replacementPerformerId: ids.under, reason: "injury",
      })
    ).json;
    const byCue = Object.fromEntries(req.impactedCues.map((c) => [c.cueId, c]));
    assert.ok(byCue.M1.qualification.reasons.includes("action_restricted"));
    assert.equal(byCue.L1.qualification.eligible, true);
  });
});

test("角色版本过期后申请与授权均被拒", async () => {
  await withServer(async (base) => {
    const ids = await setupWorld(base);
    await trainUnderstudy(base, ids);
    const expired = await call(base, "POST", "/v1/role-versions", {
      id: "role_old", showId: ids.show, roleId: "yu", roleName: "虞姬（旧版）",
      leadPerformerId: ids.lead,
      understudies: [{ performerId: ids.under, order: 1 }],
      validFrom: "2026-08-01T00:00:00Z", validTo: "2026-09-01T00:00:00Z",
    });
    assert.equal(expired.status, 200);
    await openPerformance(base, ids);
    const req = (
      await call(base, "POST", `/v1/performances/perf1/change-requests`, {
        roleVersionId: "role_old", replacementPerformerId: ids.under, reason: "injury",
      })
    ).json;
    const m1 = req.impactedCues.find((c) => c.cueId === "M1");
    assert.ok(m1.qualification.reasons.includes("role_version_out_of_validity"));
  });
});

test("齐备后把判定改回阻断会令申请退回 frozen，授权门禁关闭", async () => {
  await withServer(async (base) => {
    const ids = await setupWorld(base);
    await trainUnderstudy(base, ids);
    await openPerformance(base, ids);
    const req = (
      await call(base, "POST", `/v1/performances/perf1/change-requests`, {
        roleVersionId: ids.role, replacementPerformerId: ids.under, reason: "injury",
      })
    ).json;
    await completeRequest(base, ids, req.id);
    assert.equal((await call(base, "GET", `/v1/change-requests/${req.id}`)).json.status, "ready");

    // 机械组改判阻断（已完成的签署保留，无需重签）。
    const blocked = await call(base, "POST", `/v1/change-requests/${req.id}/reconfirmations`, {
      cueId: "M1", decision: "blocked", personId: ids.m_mech,
    });
    assert.equal(blocked.status, 200);
    const report = (await call(base, "GET", `/v1/change-requests/${req.id}`)).json;
    assert.equal(report.status, "frozen");
    assert.deepEqual(report.missingSignatures, []);
    const denied = await call(base, "POST", `/v1/change-requests/${req.id}/authorize`, {});
    assert.equal(denied.status, 409);
    assert.deepEqual(denied.json.blockedCues, ["M1"]);
  });
});


test("进程重启后授权、待签交接与租约继续有效，并可按真实顺序复盘", async () => {
  const dir = await makeTempDir();
  const clock = { t: Date.parse(T0) + 5 * 60000 };
  const now = () => new Date(clock.t).toISOString();

  let requestId;
  let authId;
  await withServer(async (base) => {
    const ids = await setupWorld(base);
    await trainUnderstudy(base, ids);
    await openPerformance(base, ids);
    requestId = (
      await call(base, "POST", `/v1/performances/perf1/change-requests`, {
        roleVersionId: ids.role, replacementPerformerId: ids.under, reason: "injury",
      })
    ).json.id;
    await completeRequest(base, ids, requestId);
    authId = (await call(base, "POST", `/v1/change-requests/${requestId}/authorize`, {})).json.id;
  }, { dir, now });

  // 新进程：从事件日志 + 快照重建，授权与租约仍在。
  await withServer(async (base) => {
    const auth = (await call(base, "GET", `/v1/change-requests/${requestId}`)).json;
    assert.equal(auth.status, "authorized");
    assert.equal(auth.authorizationId, authId);
    const leases = await call(base, "GET", "/v1/leases?resourceKind=performer");
    assert.equal(leases.json.length, 1);
    assert.equal(leases.json[0].status, "granted");

    // 继续本场演出：开演、执行、安全点切换都可用。
    await call(base, "POST", "/v1/performances/perf1/start", {});
    const l1 = await call(base, "POST", "/v1/cue-executions", { performanceId: "perf1", cueId: "L1" });
    assert.equal(l1.status, 200);
    assert.equal(l1.json.authorizationIds[0], authId);

    const tl = (await call(base, "GET", "/v1/performances/perf1/timeline")).json;
    const types = tl.timeline.map((e) => e.type);
    // 严格按真实追加顺序：人员变更 → 重确认 → 签署 → 授权 → 开演 → 执行。
    assert.ok(types.indexOf("request_created") < types.indexOf("authorization_created"));
    assert.ok(types.indexOf("authorization_created") < types.indexOf("performance_started"));
    assert.ok(types.indexOf("performance_started") < types.lastIndexOf("cue_attempt_recorded"));
    // seq 单调，复盘可重放。
    const seqs = tl.timeline.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  }, { dir, now });
});

test("纯事件日志（快照缺失）同样可恢复并继续业务", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cue-service-nosnap-"));
  await withServer(async (base) => {
    const ids = await setupWorld(base);
    await trainUnderstudy(base, ids);
    await openPerformance(base, ids);
    const created = await call(base, "POST", `/v1/performances/perf1/change-requests`, {
      roleVersionId: ids.role, replacementPerformerId: ids.under, reason: "injury",
    });
    assert.equal(created.status, 200);
  }, { dir });

  // 模拟快照损坏/缺失：只保留追加日志，必须能完整重放。
  fs.rmSync(path.join(dir, "snapshot.json"), { force: true });
  await withServer(async (base) => {
    const list = (await call(base, "GET", "/v1/performances/perf1/timeline")).json;
    const created = list.timeline.find((e) => e.type === "request_created");
    assert.ok(created, "重启后应仍能看到待办换角申请");
    const report = (await call(base, "GET", `/v1/change-requests/${created.payload.id}`)).json;
    // 待签交接（frozen）在重启后仍有效。
    assert.equal(report.status, "frozen");
    assert.ok(report.missingSignatures.includes("stage_manager"));
  }, { dir });
});

async function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cue-service-"));
}
