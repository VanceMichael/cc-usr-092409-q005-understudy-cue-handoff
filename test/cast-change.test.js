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

test("替演排练片段不足与动作限制冲突被拒绝并留痕", async (t) => {
  const clock = makeClock();
  const { base } = await startServer(t, { now: clock.now });
  await seedFixture(base);

  // p_u2 只通过过 seg_lift，缺少烟火口令所需的 seg_pyro
  const denied = await api(base, "POST", "/shows/s1/cast-changes", { ...CAST_CHANGE_BODY, toPersonId: "p_u2" });
  assert.equal(denied.status, 409);
  assert.equal(denied.body.error.code, "missing_rehearsal");
  assert.deepEqual(denied.body.error.details.gaps, [
    { cueId: "cue_pyro", missingSegments: ["seg_pyro"] },
  ]);

  // 登记排练回执后片段满足，但 p_u2 的动作限制禁止烟火口令
  const receipt = await api(base, "POST", "/shows/s1/rehearsal-receipts", {
    personId: "p_u2",
    roleId: "r1",
    segmentId: "seg_pyro",
    passedAt: "2026-09-20T10:00:00+08:00",
  });
  assert.equal(receipt.status, 201);
  assert.equal(receipt.body.receipt.late, false);

  const stillDenied = await api(base, "POST", "/shows/s1/cast-changes", {
    ...CAST_CHANGE_BODY,
    toPersonId: "p_u2",
  });
  assert.equal(stillDenied.status, 409);
  assert.equal(stillDenied.body.error.code, "restriction_conflict");
  assert.equal(stillDenied.body.error.details.conflicts[0].cueId, "cue_pyro");

  const review = await must(base, "GET", "/shows/s1/review", undefined, 200);
  const rejected = review.timeline.filter((event) => event.type === "cast_change_rejected");
  assert.deepEqual(
    rejected.map((event) => event.reason),
    ["missing_rehearsal", "restriction_conflict"],
  );
});

test("换角冻结放行版与受影响口令，按职责签署后生成本场授权", async (t) => {
  const clock = makeClock();
  const { base } = await startServer(t, { now: clock.now });
  await seedFixture(base);

  const created = await api(base, "POST", "/shows/s1/cast-changes", CAST_CHANGE_BODY);
  assert.equal(created.status, 201);
  const request = created.body.request;
  assert.equal(request.status, "open");
  // 沿依赖图找出受影响口令：cue_lift、cue_pyro 直接涉及角色，cue_light 在下游
  assert.deepEqual(request.affectedCues, ["cue_lift", "cue_pyro", "cue_light"]);
  assert.deepEqual(request.requiredSignatures, [
    "understudy",
    "crew:light",
    "crew:machinery",
    "crew:blocking",
    "supervisor",
  ]);

  // 放行版与受影响口令被冻结，未受影响的口令不受影响
  const detail = await must(base, "GET", "/shows/s1", undefined, 200);
  assert.equal(detail.show.roles[0].frozenBy, request.id);
  assert.deepEqual(detail.show.cues.find((cue) => cue.id === "cue_lift").frozenBy, [request.id]);
  assert.deepEqual(detail.show.cues.find((cue) => cue.id === "cue_caption").frozenBy, []);

  // 冻结期间不允许开演，监督可据此判断今晚不能安全开演
  const readiness = await must(base, "GET", "/shows/s1/readiness", undefined, 200);
  assert.equal(readiness.ready, false);
  assert.deepEqual(
    readiness.issues.map((issue) => issue.code),
    ["cast_change_pending"],
  );
  const openAttempt = await api(base, "POST", "/shows/s1/open");
  assert.equal(openAttempt.status, 409);
  assert.equal(openAttempt.body.error.details.issues[0].code, "cast_change_pending");

  // 同一角色重复申请被拒
  const duplicate = await api(base, "POST", "/shows/s1/cast-changes", CAST_CHANGE_BODY);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, "cast_change_pending");

  const ccId = request.id;
  const sign = (body) => api(base, "POST", `/shows/s1/cast-changes/${ccId}/signatures`, body);

  // 非接任替演不得代签本人职责
  const impersonation = await sign({ duty: "understudy", signerId: "p_u2" });
  assert.equal(impersonation.status, 403);
  assert.equal(impersonation.body.error.details.reason, "must_be_incoming_understudy");

  // 替演本人签署
  assert.equal((await sign({ duty: "understudy", signerId: "p_u1" })).status, 200);

  // 同一职责不能重复签署
  const dupDuty = await sign({ duty: "understudy", signerId: "p_u1" });
  assert.equal(dupDuty.status, 403);
  assert.equal(dupDuty.body.error.details.reason, "duty_already_signed");

  // 替演不得复核自己的换角（执行组与监督职责都不行）
  const selfCrew = await sign({ duty: "crew:light", signerId: "p_u1", confirmedCueIds: ["cue_light"] });
  assert.equal(selfCrew.status, 403);
  assert.equal(selfCrew.body.error.details.reason, "self_review_forbidden");
  const selfSupervisor = await sign({ duty: "supervisor", signerId: "p_u1" });
  assert.equal(selfSupervisor.status, 403);
  assert.equal(selfSupervisor.body.error.details.reason, "self_review_forbidden");

  // 申请人不得担任本次申请的监督复核
  const requesterReview = await sign({ duty: "supervisor", signerId: "p_sm" });
  assert.equal(requesterReview.status, 403);
  assert.equal(requesterReview.body.error.details.reason, "self_review_forbidden");

  // 执行组签署必须完整覆盖本执行口受影响口令
  assert.equal((await sign({ duty: "crew:light", signerId: "p_crew_light" })).status, 400);
  const partial = await sign({
    duty: "crew:machinery",
    signerId: "p_crew_mech",
    confirmedCueIds: ["cue_lift"],
  });
  assert.equal(partial.status, 400);
  assert.equal(partial.body.error.code, "incomplete_confirmation");
  const unknownCue = await sign({
    duty: "crew:light",
    signerId: "p_crew_light",
    confirmedCueIds: ["cue_caption"],
  });
  assert.equal(unknownCue.status, 400);

  // 执行组按口重确认
  assert.equal(
    (await sign({ duty: "crew:light", signerId: "p_crew_light", confirmedCueIds: ["cue_light"] })).status,
    200,
  );
  assert.equal(
    (
      await sign({
        duty: "crew:machinery",
        signerId: "p_crew_mech",
        confirmedCueIds: ["cue_lift", "cue_pyro"],
      })
    ).status,
    200,
  );
  assert.equal(
    (await sign({ duty: "crew:blocking", signerId: "p_crew_block", confirmedCueIds: ["cue_lift"] })).status,
    200,
  );

  // 一人只能签一个职责
  const doubleHat = await sign({ duty: "supervisor", signerId: "p_crew_block" });
  assert.equal(doubleHat.status, 403);
  assert.equal(doubleHat.body.error.details.reason, "signer_already_signed");

  // 监督签署后自动生成本场授权
  const final = await sign({ duty: "supervisor", signerId: "p_sup" });
  assert.equal(final.status, 200);
  const authorization = final.body.authorization;
  assert.ok(authorization);
  assert.equal(authorization.personId, "p_u1");
  assert.deepEqual(authorization.affectedCues, ["cue_lift", "cue_pyro", "cue_light"]);
  assert.equal(authorization.validUntil, "2026-09-24T14:00:00.000Z");

  // 授权后解冻，可以安全开演
  const signed = await must(base, "GET", `/shows/s1/cast-changes/${ccId}`, undefined, 200);
  assert.equal(signed.request.status, "authorized");
  assert.equal((await must(base, "GET", "/shows/s1/readiness", undefined, 200)).ready, true);
  await must(base, "POST", "/shows/s1/open", undefined, 200);

  // 原主演失去口令执行权，替演凭授权执行
  const byLead = await api(base, "POST", "/shows/s1/executions", { cueId: "cue_lift", executedBy: "p_lead" });
  assert.equal(byLead.status, 409);
  assert.equal(byLead.body.error.code, "executor_not_authorized");
  const byUnderstudy = await must(
    base,
    "POST",
    "/shows/s1/executions",
    { cueId: "cue_lift", executedBy: "p_u1" },
    201,
  );
  assert.equal(byUnderstudy.execution.basis.type, "authorization");
  assert.equal(byUnderstudy.execution.basis.authorizationId, authorization.id);

  await must(base, "POST", "/shows/s1/close", undefined, 200);

  // 散场复盘：按真实顺序还原人员变更、重新确认的口令、被阻断动作及最终执行依据
  const review = await must(base, "GET", "/shows/s1/review", undefined, 200);
  const seqs = review.timeline.map((event) => event.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));

  assert.equal(review.summary.personnelChanges.length, 1);
  assert.equal(review.summary.personnelChanges[0].toPersonId, "p_u1");
  assert.equal(review.summary.personnelChanges[0].status, "authorized");
  assert.equal(review.summary.personnelChanges[0].authorizationId, authorization.id);

  assert.deepEqual(
    review.summary.reconfirmedCues.map((item) => item.department).sort(),
    ["blocking", "light", "machinery"],
  );
  const machinery = review.summary.reconfirmedCues.find((item) => item.department === "machinery");
  assert.deepEqual(machinery.cueIds, ["cue_lift", "cue_pyro"]);
  assert.equal(machinery.confirmedBy, "p_crew_mech");

  const blockedTypes = review.summary.blockedActions.map((item) => item.type);
  assert.ok(blockedTypes.includes("show_open_blocked"));
  assert.ok(blockedTypes.includes("signature_rejected"));
  assert.ok(blockedTypes.includes("execution_blocked"));

  const liftExecution = review.summary.executions.find((item) => item.cueId === "cue_lift");
  assert.equal(liftExecution.basis.type, "authorization");
  assert.equal(liftExecution.basis.authorizationId, authorization.id);
});

test("换角申请校验：替演顺位、现任人员与版本有效期", async (t) => {
  const clock = makeClock();
  const { base } = await startServer(t, { now: clock.now });
  await seedFixture(base);

  const notInOrder = await api(base, "POST", "/shows/s1/cast-changes", {
    ...CAST_CHANGE_BODY,
    toPersonId: "p_crew_light",
  });
  assert.equal(notInOrder.status, 409);
  assert.equal(notInOrder.body.error.code, "not_in_understudy_order");

  const mismatch = await api(base, "POST", "/shows/s1/cast-changes", {
    ...CAST_CHANGE_BODY,
    fromPersonId: "p_u2",
  });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error.code, "from_person_mismatch");

  const noOp = await api(base, "POST", "/shows/s1/cast-changes", {
    ...CAST_CHANGE_BODY,
    toPersonId: "p_lead",
  });
  assert.equal(noOp.status, 409);
  assert.equal(noOp.body.error.code, "no_op_change");

  // 放行版过期后申请与开演都被阻断
  clock.set("2026-10-09T00:00:00Z");
  const expired = await api(base, "POST", "/shows/s1/cast-changes", CAST_CHANGE_BODY);
  assert.equal(expired.status, 409);
  assert.equal(expired.body.error.code, "version_expired");
  const openAttempt = await api(base, "POST", "/shows/s1/open");
  assert.equal(openAttempt.status, 409);
  assert.equal(openAttempt.body.error.details.issues[0].code, "version_expired");
});

test("撤销换角申请解冻口令并释放替演租约", async (t) => {
  const clock = makeClock();
  const { base } = await startServer(t, { now: clock.now });
  await seedFixture(base);

  const created = await must(base, "POST", "/shows/s1/cast-changes", CAST_CHANGE_BODY, 201);
  const cancelled = await must(
    base,
    "POST",
    `/shows/s1/cast-changes/${created.request.id}/cancel`,
    { cancelledBy: "p_sm" },
    200,
  );
  assert.equal(cancelled.request.status, "cancelled");

  const detail = await must(base, "GET", "/shows/s1", undefined, 200);
  assert.equal(detail.show.roles[0].frozenBy, null);
  assert.ok(detail.show.cues.every((cue) => cue.frozenBy.length === 0));

  const leases = await must(base, "GET", "/leases", undefined, 200);
  assert.equal(leases.leases.find((lease) => lease.resourceId === "person:p_u1").status, "released");

  // 已撤销申请不能再签署
  const signCancelled = await api(base, "POST", `/shows/s1/cast-changes/${created.request.id}/signatures`, {
    duty: "understudy",
    signerId: "p_u1",
  });
  assert.equal(signCancelled.status, 409);

  // 撤销后可以重新申请并完成交接
  const again = await must(base, "POST", "/shows/s1/cast-changes", CAST_CHANGE_BODY, 201);
  const final = await signAllDuties(base, "s1", again.request.id);
  assert.ok(final.authorization);
});
