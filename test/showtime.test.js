import assert from "node:assert/strict";
import test from "node:test";
import {
  CAST_CHANGE_BODY,
  api,
  makeClock,
  must,
  seedFixture,
  signAllDuties,
  startServer,
} from "./helpers.js";

test("开演后人员变化只能从预先验证的安全点切换", async (t) => {
  const clock = makeClock();
  const { base } = await startServer(t, { now: clock.now });
  await seedFixture(base);

  // 安全点必须由监督预先验证
  const badValidator = await api(base, "POST", "/shows/s1/safety-points", {
    afterCueId: "cue_caption",
    validatedBy: "p_lead",
  });
  assert.equal(badValidator.status, 400);

  const sp1 = (
    await must(base, "POST", "/shows/s1/safety-points", { afterCueId: "cue_caption", validatedBy: "p_sup" }, 201)
  ).point;
  const sp2 = (
    await must(base, "POST", "/shows/s1/safety-points", { afterCueId: "cue_lift", validatedBy: "p_sup" }, 201)
  ).point;

  await must(base, "POST", "/shows/s1/open", undefined, 200);

  // 开演后不能再新增安全点
  const latePoint = await api(base, "POST", "/shows/s1/safety-points", {
    afterCueId: "cue_caption",
    validatedBy: "p_sup",
  });
  assert.equal(latePoint.status, 409);

  // 开演后未指定安全点的人员变化被拒绝
  const noPoint = await api(base, "POST", "/shows/s1/cast-changes", CAST_CHANGE_BODY);
  assert.equal(noPoint.status, 409);
  assert.equal(noPoint.body.error.code, "safety_point_required");

  // 锚定口令已执行的安全点不可再用于切换
  await must(base, "POST", "/shows/s1/executions", { cueId: "cue_caption", executedBy: "p_crew_light" }, 201);
  const passed = await api(base, "POST", "/shows/s1/cast-changes", {
    ...CAST_CHANGE_BODY,
    safetyPointId: sp1.id,
  });
  assert.equal(passed.status, 409);
  assert.equal(passed.body.error.code, "safety_point_passed");

  // 预先验证且未经过的安全点可以切换
  const created = await must(base, "POST", "/shows/s1/cast-changes", {
    ...CAST_CHANGE_BODY,
    safetyPointId: sp2.id,
  }, 201);
  assert.equal(created.request.safetyPointId, sp2.id);

  // 切换签署期间受影响口令被冻结
  const frozen = await api(base, "POST", "/shows/s1/executions", { cueId: "cue_lift", executedBy: "p_lead" });
  assert.equal(frozen.status, 409);
  assert.equal(frozen.body.error.code, "cue_frozen");

  const final = await signAllDuties(base, "s1", created.request.id);
  assert.equal(final.authorization.safetyPointId, sp2.id);

  // 授权生成后口令解冻，替演从安全点接任执行
  const byUnderstudy = await must(
    base,
    "POST",
    "/shows/s1/executions",
    { cueId: "cue_lift", executedBy: "p_u1" },
    201,
  );
  assert.equal(byUnderstudy.execution.basis.type, "authorization");

  const review = await must(base, "GET", "/shows/s1/review", undefined, 200);
  assert.ok(
    review.summary.blockedActions.some(
      (item) => item.type === "execution_blocked" && item.reason === "cue_frozen",
    ),
  );
  assert.equal(review.summary.personnelChanges[0].safetyPointId, sp2.id);
});

test("迟到排练回执只登记不改写已执行动作", async (t) => {
  const clock = makeClock();
  const { base } = await startServer(t, { now: clock.now });
  await seedFixture(base);
  await must(base, "POST", "/shows/s1/open", undefined, 200);

  const executed = await must(
    base,
    "POST",
    "/shows/s1/executions",
    { cueId: "cue_lift", executedBy: "p_lead" },
    201,
  );
  assert.equal(executed.execution.basis.type, "released_version");

  // 已执行口令相关片段的回执属于迟到回执
  const receipt = await must(base, "POST", "/shows/s1/rehearsal-receipts", {
    personId: "p_u1",
    roleId: "r1",
    segmentId: "seg_lift",
    passedAt: "2026-09-24T12:00:00Z",
  }, 201);
  assert.equal(receipt.receipt.late, true);
  assert.equal(receipt.receipt.afterExecution, true);

  // 开演后到达但与已执行动作无关的回执同样标记迟到
  const other = await must(base, "POST", "/shows/s1/rehearsal-receipts", {
    personId: "p_u1",
    roleId: "r1",
    segmentId: "seg_other",
    passedAt: "2026-09-24T12:00:00Z",
  }, 201);
  assert.equal(other.receipt.late, true);
  assert.equal(other.receipt.afterExecution, false);

  // 已执行动作保持原样：执行人、执行依据均不被回执改写
  const review = await must(base, "GET", "/shows/s1/review", undefined, 200);
  const liftExecution = review.summary.executions.find((item) => item.cueId === "cue_lift");
  assert.equal(liftExecution.executedBy, "p_lead");
  assert.equal(liftExecution.basis.type, "released_version");
  const receipts = review.timeline.filter((event) => event.type === "rehearsal_receipt_recorded");
  assert.equal(receipts.length, 2);
  assert.ok(receipts.every((event) => event.receipt.late));
});

test("紧急人工跳过保留原因和责任人", async (t) => {
  const clock = makeClock();
  const { base } = await startServer(t, { now: clock.now });
  await seedFixture(base);

  // 未开演不能紧急跳过
  const notOpen = await api(base, "POST", "/shows/s1/skips", {
    cueId: "cue_lift",
    skippedBy: "p_sm",
    reason: "设备故障",
  });
  assert.equal(notOpen.status, 409);

  const sp = (
    await must(base, "POST", "/shows/s1/safety-points", { afterCueId: "cue_lift", validatedBy: "p_sup" }, 201)
  ).point;
  await must(base, "POST", "/shows/s1/open", undefined, 200);
  await must(base, "POST", "/shows/s1/cast-changes", { ...CAST_CHANGE_BODY, safetyPointId: sp.id }, 201);

  // 缺少原因或责任人都被拒绝
  assert.equal(
    (await api(base, "POST", "/shows/s1/skips", { cueId: "cue_lift", skippedBy: "p_sm" })).status,
    400,
  );
  assert.equal(
    (await api(base, "POST", "/shows/s1/skips", { cueId: "cue_lift", reason: "升降台故障" })).status,
    400,
  );

  // 冻结中的口令也可紧急跳过，原因与责任人完整保留
  const skipped = await must(base, "POST", "/shows/s1/skips", {
    cueId: "cue_lift",
    skippedBy: "p_sm",
    reason: "升降台异响，人工确认后跳过",
  }, 201);
  assert.equal(skipped.skip.skippedBy, "p_sm");
  assert.equal(skipped.skip.reason, "升降台异响，人工确认后跳过");

  const review = await must(base, "GET", "/shows/s1/review", undefined, 200);
  assert.deepEqual(review.summary.skips, [
    { cueId: "cue_lift", skippedBy: "p_sm", reason: "升降台异响，人工确认后跳过", at: skipped.skip.at },
  ]);
});
