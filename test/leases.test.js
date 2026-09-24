import assert from "node:assert/strict";
import test from "node:test";
import { CAST_CHANGE_BODY, api, makeClock, must, seedFixture, startServer } from "./helpers.js";

test("两个场次同时借用同一替演时租约给出唯一结果", async (t) => {
  const clock = makeClock();
  const { base } = await startServer(t, { now: clock.now });
  await seedFixture(base);
  await seedFixture(base, { showId: "s2", liftEquipment: "eq_lift2", pyroEquipment: "eq_pyro2" });

  const first = await must(base, "POST", "/shows/s1/cast-changes", CAST_CHANGE_BODY, 201);
  assert.equal(first.request.status, "open");

  // 同一替演已被 s1 租用，s2 的申请被唯一拒绝
  const conflict = await api(base, "POST", "/shows/s2/cast-changes", CAST_CHANGE_BODY);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "lease_conflict");
  assert.equal(conflict.body.error.details.resourceId, "person:p_u1");
  assert.equal(conflict.body.error.details.heldByShow, "s1");

  const review = await must(base, "GET", "/shows/s2/review", undefined, 200);
  assert.ok(
    review.timeline.some(
      (event) => event.type === "cast_change_rejected" && event.reason === "lease_conflict",
    ),
  );

  // s1 撤销交接释放租约后，s2 才能借用
  await must(base, "POST", `/shows/s1/cast-changes/${first.request.id}/cancel`, {}, 200);
  const retry = await must(base, "POST", "/shows/s2/cast-changes", CAST_CHANGE_BODY, 201);
  assert.equal(retry.request.status, "open");

  const leases = await must(base, "GET", "/leases", undefined, 200);
  const personLeases = leases.leases.filter((lease) => lease.resourceId === "person:p_u1");
  assert.equal(personLeases.length, 2);
  const active = personLeases.filter((lease) => lease.status === "active");
  assert.equal(active.length, 1);
  assert.equal(active[0].showId, "s2");
});

test("两个场次同时借用同一高风险设备时租约给出唯一结果", async (t) => {
  const clock = makeClock();
  const { base } = await startServer(t, { now: clock.now });
  await seedFixture(base);
  // s2 是更晚的场次，与 s1 使用同一批高风险设备
  await seedFixture(base, {
    showId: "s2",
    startsAt: "2026-09-24T23:30:00+08:00",
    endsAt: "2026-09-25T02:00:00+08:00",
  });

  await must(base, "POST", "/shows/s1/open", undefined, 200);

  // s1 开演租用了升降台与烟火设备，s2 开演被阻断
  const blocked = await api(base, "POST", "/shows/s2/open");
  assert.equal(blocked.status, 409);
  const conflicts = blocked.body.error.details.issues.filter(
    (issue) => issue.code === "equipment_lease_conflict",
  );
  assert.deepEqual(
    conflicts.map((issue) => issue.resourceId).sort(),
    ["equipment:eq_lift1", "equipment:eq_pyro1"],
  );
  assert.ok(conflicts.every((issue) => issue.heldByShow === "s1"));

  const readiness = await must(base, "GET", "/shows/s2/readiness", undefined, 200);
  assert.equal(readiness.ready, false);

  const review = await must(base, "GET", "/shows/s2/review", undefined, 200);
  assert.ok(review.timeline.some((event) => event.type === "show_open_blocked"));

  // s1 场次结束租约过期后，s2 可以开演
  clock.set("2026-09-24T15:00:00Z");
  await must(base, "POST", "/shows/s2/open", undefined, 200);

  const leases = await must(base, "GET", "/leases", undefined, 200);
  const s1Lease = leases.leases.find(
    (lease) => lease.resourceId === "equipment:eq_lift1" && lease.showId === "s1",
  );
  assert.equal(s1Lease.status, "expired");
  const s2Lease = leases.leases.find(
    (lease) => lease.resourceId === "equipment:eq_lift1" && lease.showId === "s2",
  );
  assert.equal(s2Lease.status, "active");
});

test("散场释放设备租约后其他场次可复用", async (t) => {
  const clock = makeClock();
  const { base } = await startServer(t, { now: clock.now });
  await seedFixture(base);
  await seedFixture(base, { showId: "s2" });

  await must(base, "POST", "/shows/s1/open", undefined, 200);
  await must(base, "POST", "/shows/s1/close", undefined, 200);
  await must(base, "POST", "/shows/s2/open", undefined, 200);

  const leases = await must(base, "GET", "/leases", undefined, 200);
  const s1Lease = leases.leases.find(
    (lease) => lease.resourceId === "equipment:eq_lift1" && lease.showId === "s1",
  );
  assert.equal(s1Lease.status, "released");
});
