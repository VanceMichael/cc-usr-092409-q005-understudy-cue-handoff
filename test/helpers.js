import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server.js";

export function makeClock(startIso = "2026-09-24T10:00:00Z") {
  const state = { ms: Date.parse(startIso) };
  return {
    now: () => new Date(state.ms),
    set(iso) {
      state.ms = Date.parse(iso);
    },
    advance(ms) {
      state.ms += ms;
    },
  };
}

export async function startServer(t, { dataDir, now } = {}) {
  const dir = dataDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "cue-service-")));
  const server = createServer({ dataDir: dir, now });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { server, dataDir: dir, base: `http://127.0.0.1:${server.address().port}` };
}

export async function api(base, method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

export async function must(base, method, path, body, expectedStatus) {
  const result = await api(base, method, path, body);
  assert.equal(
    result.status,
    expectedStatus,
    `${method} ${path} -> ${result.status}: ${JSON.stringify(result.body)}`,
  );
  return result.body;
}

export const PEOPLE = {
  p_lead: ["actor"],
  p_lead2: ["actor"],
  p_u1: ["understudy"],
  p_u2: ["understudy"],
  p_crew_light: ["crew:light"],
  p_crew_props: ["crew:props"],
  p_crew_mech: ["crew:machinery"],
  p_crew_block: ["crew:blocking"],
  p_sup: ["supervisor"],
  p_sm: ["supervisor"],
};

export async function seedPeople(base, people = PEOPLE) {
  for (const [id, staffRoles] of Object.entries(people)) {
    await must(base, "PUT", `/people/${id}`, { staffRoles }, 200);
  }
}

// 标准剧目装置：角色 r1（主演 p_lead，替演顺位 p_u1 > p_u2），
// 口令依赖图 cue_lift -> cue_pyro -> cue_light，另有独立 cue_caption。
export async function seedFixture(base, options = {}) {
  const showId = options.showId ?? "s1";
  const roleId = options.roleId ?? "r1";
  await seedPeople(base, options.people);
  await must(
    base,
    "POST",
    "/shows",
    {
      id: showId,
      name: options.name ?? "巡演之夜",
      startsAt: options.startsAt ?? "2026-09-24T19:00:00+08:00",
      endsAt: options.endsAt ?? "2026-09-24T22:00:00+08:00",
    },
    201,
  );
  await must(
    base,
    "POST",
    `/shows/${showId}/roles/${roleId}/versions`,
    {
      actorId: options.actorId ?? "p_lead",
      understudies: options.understudies ?? ["p_u1", "p_u2"],
      rehearsalPasses: options.rehearsalPasses ?? {
        p_u1: ["seg_lift", "seg_pyro"],
        p_u2: ["seg_lift"],
      },
      restrictions: options.restrictions ?? [
        { personId: "p_u2", deniedCueTypes: ["pyro"], note: "未受烟火训练" },
      ],
      validFrom: options.validFrom ?? "2026-09-01T00:00:00+08:00",
      validUntil: options.validUntil ?? "2026-10-08T00:00:00+08:00",
    },
    201,
  );
  await must(base, "POST", `/shows/${showId}/roles/${roleId}/versions/1/release`, undefined, 200);
  const cues = [
    {
      id: "cue_lift",
      type: "machinery",
      departments: ["machinery", "blocking"],
      roleIds: [roleId],
      requiredSegments: ["seg_lift"],
      highRiskEquipment: [options.liftEquipment ?? "eq_lift1"],
    },
    {
      id: "cue_pyro",
      type: "pyro",
      departments: ["machinery"],
      roleIds: [roleId],
      requiredSegments: ["seg_pyro"],
      highRiskEquipment: [options.pyroEquipment ?? "eq_pyro1"],
      dependsOn: ["cue_lift"],
    },
    { id: "cue_light", type: "light", departments: ["light"], dependsOn: ["cue_pyro"] },
    { id: "cue_caption", type: "caption" },
  ];
  for (const cue of cues) {
    await must(base, "POST", `/shows/${showId}/cues`, cue, 201);
  }
  return { showId, roleId };
}

export const CAST_CHANGE_BODY = {
  roleId: "r1",
  fromPersonId: "p_lead",
  toPersonId: "p_u1",
  reason: "主演巡演途中临时伤停",
  requestedBy: "p_sm",
};

// 替演 p_u1 换角申请的全部职责签署（申请人 p_sm，监督 p_sup）。
export async function signAllDuties(base, showId, castChangeId, { understudy = "p_u1" } = {}) {
  await must(base, "POST", `/shows/${showId}/cast-changes/${castChangeId}/signatures`, {
    duty: "understudy",
    signerId: understudy,
  }, 200);
  await must(base, "POST", `/shows/${showId}/cast-changes/${castChangeId}/signatures`, {
    duty: "crew:light",
    signerId: "p_crew_light",
    confirmedCueIds: ["cue_light"],
  }, 200);
  await must(base, "POST", `/shows/${showId}/cast-changes/${castChangeId}/signatures`, {
    duty: "crew:machinery",
    signerId: "p_crew_mech",
    confirmedCueIds: ["cue_lift", "cue_pyro"],
  }, 200);
  await must(base, "POST", `/shows/${showId}/cast-changes/${castChangeId}/signatures`, {
    duty: "crew:blocking",
    signerId: "p_crew_block",
    confirmedCueIds: ["cue_lift"],
  }, 200);
  return must(base, "POST", `/shows/${showId}/cast-changes/${castChangeId}/signatures`, {
    duty: "supervisor",
    signerId: "p_sup",
  }, 200);
}
