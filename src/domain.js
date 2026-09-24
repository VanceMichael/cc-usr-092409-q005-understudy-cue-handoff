// 领域常量与纯函数：不依赖存储状态，便于单测与复用。

// 需要重确认的四个执行口：灯光、道具、机械、舞台走位。
export const DEPARTMENTS = ["light", "props", "machinery", "blocking"];

export const CUE_TYPES = [
  "light",
  "caption",
  "percussion",
  "entrance",
  "machinery",
  "pyro",
  "scene_change",
];

// 升降台、烟火、快速换景等默认高风险口令类型。
export const HIGH_RISK_CUE_TYPES = new Set(["machinery", "pyro", "scene_change"]);

export const BASE_STAFF_ROLES = ["actor", "understudy", "supervisor"];

export function staffRoleValid(role) {
  if (BASE_STAFF_ROLES.includes(role)) return true;
  if (typeof role === "string" && role.startsWith("crew:")) {
    return DEPARTMENTS.includes(role.slice("crew:".length));
  }
  return false;
}

// 沿依赖图计算受换角影响的口令：角色直接参与的口令，加上所有下游依赖它们的口令。
// 返回按创建顺序排列的口令 id 与需要去重的执行口（按 DEPARTMENTS 规范顺序）。
export function computeAffectedCues(cues, roleId) {
  const byId = new Map(cues.map((cue) => [cue.id, cue]));
  const dependents = new Map();
  for (const cue of cues) {
    for (const dependency of cue.dependsOn) {
      if (!dependents.has(dependency)) dependents.set(dependency, new Set());
      dependents.get(dependency).add(cue.id);
    }
  }
  const affected = new Set();
  const queue = [];
  for (const cue of cues) {
    if (cue.roleIds.includes(roleId)) {
      affected.add(cue.id);
      queue.push(cue.id);
    }
  }
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of dependents.get(current) ?? []) {
      if (!affected.has(next)) {
        affected.add(next);
        queue.push(next);
      }
    }
  }
  const cueIds = cues.filter((cue) => affected.has(cue.id)).map((cue) => cue.id);
  const departments = DEPARTMENTS.filter((department) =>
    cueIds.some((id) => byId.get(id).departments.includes(department)),
  );
  return { cueIds, departments };
}

// 签署资格：按职责校验签署人，且任何人不能代签自己的复核。
// request 需含 toPersonId、requestedBy、requiredSignatures、signatures。
export function signatureEligibility({ request, duty, signerId, people }) {
  const person = people.get(signerId);
  if (!person) return { ok: false, reason: "signer_unknown" };
  if (!request.requiredSignatures.includes(duty)) {
    return { ok: false, reason: "duty_not_required" };
  }
  if (request.signatures.some((signature) => signature.duty === duty)) {
    return { ok: false, reason: "duty_already_signed" };
  }
  // 自我复核禁止优先于一人一职：先看签署人是否在被复核对象之列。
  if (duty === "understudy") {
    // 替演本人签署：只能由接任替演本人完成。
    if (signerId !== request.toPersonId) return { ok: false, reason: "must_be_incoming_understudy" };
  } else {
    // 接任替演不得为自己的换角做执行组或监督复核。
    if (signerId === request.toPersonId) return { ok: false, reason: "self_review_forbidden" };
    // 申请人不得复核自己的申请。
    if (duty === "supervisor" && signerId === request.requestedBy) {
      return { ok: false, reason: "self_review_forbidden" };
    }
  }
  if (request.signatures.some((signature) => signature.signerId === signerId)) {
    return { ok: false, reason: "signer_already_signed" };
  }
  if (duty === "understudy") return { ok: true };
  if (duty === "supervisor") {
    if (!person.staffRoles.includes("supervisor")) return { ok: false, reason: "not_supervisor" };
    return { ok: true };
  }
  if (duty.startsWith("crew:")) {
    const department = duty.slice("crew:".length);
    if (!person.staffRoles.includes(`crew:${department}`)) {
      return { ok: false, reason: "not_department_crew" };
    }
    return { ok: true };
  }
  return { ok: false, reason: "unknown_duty" };
}
