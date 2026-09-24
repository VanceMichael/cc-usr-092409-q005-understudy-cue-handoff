import assert from "node:assert/strict";
import test from "node:test";
import { api, makeClock, must, seedFixture, startServer } from "./helpers.js";

test("健康接口返回可用状态", async (t) => {
  const { base } = await startServer(t, { now: makeClock().now });
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
});

test("场次全流程：开演、按放行版执行、散场复盘", async (t) => {
  const clock = makeClock();
  const { base } = await startServer(t, { now: clock.now });
  await seedFixture(base);

  const readiness = await must(base, "GET", "/shows/s1/readiness", undefined, 200);
  assert.equal(readiness.ready, true);

  await must(base, "POST", "/shows/s1/open", undefined, 200);

  const lift = await must(base, "POST", "/shows/s1/executions", { cueId: "cue_lift", executedBy: "p_lead" }, 201);
  assert.deepEqual(lift.execution.basis, { type: "released_version", roleId: "r1", version: 1 });

  const caption = await must(base, "POST", "/shows/s1/executions", { cueId: "cue_caption", executedBy: "p_crew_light" }, 201);
  assert.equal(caption.execution.basis.type, "no_role");

  // 非当前授权人员执行角色口令被阻断并留痕
  const unauthorized = await api(base, "POST", "/shows/s1/executions", { cueId: "cue_lift", executedBy: "p_u1" });
  assert.equal(unauthorized.status, 409);
  assert.equal(unauthorized.body.error.code, "executor_not_authorized");

  await must(base, "POST", "/shows/s1/close", undefined, 200);

  const review = await must(base, "GET", "/shows/s1/review", undefined, 200);
  assert.equal(review.status, "closed");
  assert.equal(review.summary.executions.length, 2);
  assert.ok(
    review.summary.blockedActions.some(
      (item) => item.type === "execution_blocked" && item.reason === "executor_not_authorized",
    ),
  );
  assert.ok(review.timeline.some((event) => event.category === "lifecycle" && event.type === "show_closed"));

  // 散场后设备租约全部释放
  const leases = await must(base, "GET", "/leases", undefined, 200);
  const showLeases = leases.leases.filter((lease) => lease.showId === "s1");
  assert.ok(showLeases.length >= 2);
  assert.ok(showLeases.every((lease) => lease.status === "released"));
});

test("未开演执行口令被阻断并留痕", async (t) => {
  const clock = makeClock();
  const { base } = await startServer(t, { now: clock.now });
  await seedFixture(base);
  const blocked = await api(base, "POST", "/shows/s1/executions", { cueId: "cue_lift", executedBy: "p_lead" });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, "show_not_open");
  const review = await must(base, "GET", "/shows/s1/review", undefined, 200);
  assert.ok(
    review.summary.blockedActions.some(
      (item) => item.type === "execution_blocked" && item.reason === "show_not_open",
    ),
  );
});

test("非法输入被拒绝", async (t) => {
  const clock = makeClock();
  const { base } = await startServer(t, { now: clock.now });
  await seedFixture(base);

  // 时间必须带时区
  const naiveTime = await api(base, "POST", "/shows", {
    startsAt: "2026-09-24 19:00:00",
    endsAt: "2026-09-24T22:00:00+08:00",
  });
  assert.equal(naiveTime.status, 400);

  const reversed = await api(base, "POST", "/shows", {
    startsAt: "2026-09-24T22:00:00+08:00",
    endsAt: "2026-09-24T19:00:00+08:00",
  });
  assert.equal(reversed.status, 400);

  const badRole = await api(base, "PUT", "/people/p_x", { staffRoles: ["diva"] });
  assert.equal(badRole.status, 400);

  const badCueType = await api(base, "POST", "/shows/s1/cues", { type: "hologram" });
  assert.equal(badCueType.status, 400);

  const selfDependency = await api(base, "POST", "/shows/s1/cues", {
    id: "cue_x",
    type: "light",
    departments: ["light"],
    dependsOn: ["cue_x"],
  });
  assert.equal(selfDependency.status, 400);

  const unknownDepartment = await api(base, "POST", "/shows/s1/cues", {
    type: "light",
    departments: ["costume"],
  });
  assert.equal(unknownDepartment.status, 400);

  const unknownActor = await api(base, "POST", "/shows/s1/roles/r9/versions", {
    actorId: "p_ghost",
    understudies: [],
    validFrom: "2026-09-01T00:00:00+08:00",
    validUntil: "2026-10-08T00:00:00+08:00",
  });
  assert.equal(unknownActor.status, 400);

  const unknownRequester = await api(base, "POST", "/shows/s1/cast-changes", {
    roleId: "r1",
    fromPersonId: "p_lead",
    toPersonId: "p_u1",
    requestedBy: "p_ghost",
  });
  assert.equal(unknownRequester.status, 400);

  assert.equal((await api(base, "GET", "/no-such-route")).status, 404);
  assert.equal((await api(base, "GET", "/shows/s9")).status, 404);
});
