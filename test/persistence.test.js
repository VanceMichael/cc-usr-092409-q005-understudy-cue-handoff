import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

async function restart(t, dataDir, clock, server) {
  await new Promise((resolve) => server.close(resolve));
  return startServer(t, { dataDir, now: clock.now });
}

test("进程重启后未过期授权、待签交接与资源租约继续有效", async (t) => {
  const clock = makeClock();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cue-service-"));
  const first = await startServer(t, { dataDir, now: clock.now });

  await seedFixture(first.base);
  await seedFixture(first.base, {
    showId: "s2",
    roleId: "r2",
    actorId: "p_lead2",
    understudies: ["p_u2"],
    rehearsalPasses: { p_u2: ["seg_lift", "seg_pyro"] },
    restrictions: [],
    liftEquipment: "eq_lift2",
    pyroEquipment: "eq_pyro2",
  });

  // s1：换角申请部分签署（待签交接）
  const pending = await must(first.base, "POST", "/shows/s1/cast-changes", CAST_CHANGE_BODY, 201);
  const ccId = pending.request.id;
  await must(first.base, "POST", `/shows/s1/cast-changes/${ccId}/signatures`, {
    duty: "understudy",
    signerId: "p_u1",
  }, 200);
  await must(first.base, "POST", `/shows/s1/cast-changes/${ccId}/signatures`, {
    duty: "crew:light",
    signerId: "p_crew_light",
    confirmedCueIds: ["cue_light"],
  }, 200);

  // s2：完成交接生成授权并开演（人员与设备租约生效）
  const s2change = await must(first.base, "POST", "/shows/s2/cast-changes", {
    ...CAST_CHANGE_BODY,
    roleId: "r2",
    fromPersonId: "p_lead2",
    toPersonId: "p_u2",
  }, 201);
  const s2final = await signAllDuties(first.base, "s2", s2change.request.id, { understudy: "p_u2" });
  await must(first.base, "POST", "/shows/s2/open", undefined, 200);
  const eventsBeforeRestart = first.server.store.events.length;

  // 进程重启
  const second = await restart(t, dataDir, clock, first.server);

  // 待签交接继续有效：已签职责保留，可继续签署
  const resumed = await must(second.base, "GET", `/shows/s1/cast-changes/${ccId}`, undefined, 200);
  assert.equal(resumed.request.status, "open");
  assert.deepEqual(
    resumed.request.signatures.map((signature) => signature.duty),
    ["understudy", "crew:light"],
  );
  await must(second.base, "POST", `/shows/s1/cast-changes/${ccId}/signatures`, {
    duty: "crew:machinery",
    signerId: "p_crew_mech",
    confirmedCueIds: ["cue_lift", "cue_pyro"],
  }, 200);
  await must(second.base, "POST", `/shows/s1/cast-changes/${ccId}/signatures`, {
    duty: "crew:blocking",
    signerId: "p_crew_block",
    confirmedCueIds: ["cue_lift"],
  }, 200);
  const final = await must(second.base, "POST", `/shows/s1/cast-changes/${ccId}/signatures`, {
    duty: "supervisor",
    signerId: "p_sup",
  }, 200);
  assert.ok(final.authorization);

  // 未过期授权继续有效
  const authorizations = await must(second.base, "GET", "/shows/s2/authorizations", undefined, 200);
  assert.equal(authorizations.authorizations.length, 1);
  assert.equal(authorizations.authorizations[0].status, "active");
  assert.equal(authorizations.authorizations[0].personId, "p_u2");

  // 资源租约继续有效：第三场借用同一替演仍被唯一拒绝
  await seedFixture(second.base, {
    showId: "s3",
    roleId: "r3",
    rehearsalPasses: { p_u2: ["seg_lift", "seg_pyro"] },
    restrictions: [],
    liftEquipment: "eq_lift3",
    pyroEquipment: "eq_pyro3",
  });
  const conflict = await api(second.base, "POST", "/shows/s3/cast-changes", {
    ...CAST_CHANGE_BODY,
    roleId: "r3",
    toPersonId: "p_u2",
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "lease_conflict");
  assert.equal(conflict.body.error.details.heldByShow, "s2");

  // s2 开演状态与授权依据在重启后照常工作
  const executed = await must(second.base, "POST", "/shows/s2/executions", {
    cueId: "cue_lift",
    executedBy: "p_u2",
  }, 201);
  assert.equal(executed.execution.basis.authorizationId, s2final.authorization.id);

  // 复盘时间线跨重启保持真实顺序且连续
  const review = await must(second.base, "GET", "/shows/s2/review", undefined, 200);
  const seqs = review.timeline.map((event) => event.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.ok(seqs.some((seq) => seq > eventsBeforeRestart));
});

test("授权过期后回落到放行版演员", async (t) => {
  const clock = makeClock();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cue-service-"));
  const first = await startServer(t, { dataDir, now: clock.now });
  await seedFixture(first.base);

  const change = await must(first.base, "POST", "/shows/s1/cast-changes", CAST_CHANGE_BODY, 201);
  await signAllDuties(first.base, "s1", change.request.id);
  await must(first.base, "POST", "/shows/s1/open", undefined, 200);

  // 时间推进到授权有效期（场次结束时间）之后并重启
  clock.set("2026-09-24T15:00:00Z");
  const second = await restart(t, dataDir, clock, first.server);

  const authorizations = await must(second.base, "GET", "/shows/s1/authorizations", undefined, 200);
  assert.equal(authorizations.authorizations[0].status, "expired");

  const byUnderstudy = await api(second.base, "POST", "/shows/s1/executions", {
    cueId: "cue_lift",
    executedBy: "p_u1",
  });
  assert.equal(byUnderstudy.status, 409);
  assert.equal(byUnderstudy.body.error.code, "executor_not_authorized");

  const byLead = await must(second.base, "POST", "/shows/s1/executions", {
    cueId: "cue_lift",
    executedBy: "p_lead",
  }, 201);
  assert.equal(byLead.execution.basis.type, "released_version");
});
