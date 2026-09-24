import { registerReducer } from "./store.js";

export const CUE_GROUPS = {
  light: "灯光组",
  caption: "字幕组",
  percussion: "锣鼓组",
  entrance: "场务组",
  prop: "道具组",
  machinery: "机械组",
  blocking: "走位组",
};

// 高风险动作：升降台、烟火、快速换景
export const HIGH_RISK = new Set(["lift", "pyro", "quick_change"]);

export const SIGN_ROLES = ["understudy", "execution_group", "stage_manager"];

export function ts(value) {
  return Date.parse(value);
}

export function isHighRisk(cue) {
  return Boolean(cue.action) && HIGH_RISK.has(cue.action);
}

/** 反向依赖图：口令 -> 依赖它的口令（谁会在它之后被牵动）。 */
export function buildReverseGraph(pkg) {
  const reverse = new Map();
  for (const cue of pkg.cues) reverse.set(cue.id, []);
  for (const cue of pkg.cues) {
    for (const depOf of cue.dependsOn ?? []) {
      if (!reverse.has(depOf)) reverse.set(depOf, []);
      reverse.get(depOf).push(cue.id);
    }
  }
  return reverse;
}

/**
 * 从角色直接参与的口令出发，沿依赖图反向遍历，
 * 闭包内即需要重新确认的灯光、道具、机械与走位口令。
 */
export function impactedCueClosure(pkg, roleId) {
  const seeds = pkg.cues.filter((c) => (c.roles ?? []).includes(roleId)).map((c) => c.id);
  const reverse = buildReverseGraph(pkg);
  const seen = new Set();
  const queue = [...seeds];
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dependent of reverse.get(id) ?? []) {
      if (!seen.has(dependent)) queue.push(dependent);
    }
  }
  return pkg.cues.filter((c) => seen.has(c.id));
}

function passedCoverage(state, roleVersionId, performerId) {
  const segments = new Set();
  const actions = new Set();
  for (const receipt of Object.values(state.rehearsalReceipts)) {
    if (
      receipt.roleVersionId === roleVersionId &&
      receipt.performerId === performerId &&
      receipt.status === "passed"
    ) {
      if (receipt.segmentId) segments.add(receipt.segmentId);
      if (receipt.action) actions.add(receipt.action);
    }
  }
  return { segments, actions };
}

/**
 * 替演资格：在角色版本有效期内，通过口令要求的全部排练片段，
 * 高风险动作另有排练回执，且未受动作限制。
 * 回执只按既有事实累加，永不反向改写已经执行（或被阻断）的记录。
 */
export function checkQualification(state, roleVersion, performerId, cue, at) {
  const reasons = [];
  const listing = roleVersion.understudies.find((u) => u.performerId === performerId);
  if (!listing) reasons.push("not_listed_understudy");
  if (ts(at) < ts(roleVersion.validFrom) || ts(at) > ts(roleVersion.validTo))
    reasons.push("role_version_out_of_validity");

  const restrictions = new Set([...(roleVersion.actionRestrictions ?? []), ...(listing?.actionRestrictions ?? [])]);
  if (cue.action && restrictions.has(cue.action)) reasons.push("action_restricted");

  const { segments, actions } = passedCoverage(state, roleVersion.id, performerId);
  for (const segmentId of cue.rehearsalSegments ?? []) {
    if (!segments.has(segmentId)) reasons.push(`missing_segment:${segmentId}`);
  }
  if (isHighRisk(cue) && cue.action && !actions.has(cue.action)) {
    reasons.push(`missing_action_drill:${cue.action}`);
  }
  return { eligible: reasons.length === 0, reasons };
}

export function windowsOverlap(aStart, aEnd, bStart, bEnd) {
  return ts(aStart) < ts(bEnd) && ts(bStart) < ts(aEnd);
}

/**
 * 租约仲裁：同一替演/同一高风险设备在重叠时间窗只能有一个持有者。
 * 已被本场次同一角色持有则幂等返回；被其他场次持有则给出唯一冲突结果。
 */
export function findLeaseConflict(state, resourceKind, resourceId, startAt, endAt, performanceId, roleId) {
  for (const lease of Object.values(state.leases)) {
    if (
      lease.status === "granted" &&
      lease.resourceKind === resourceKind &&
      lease.resourceId === resourceId &&
      windowsOverlap(startAt, endAt, lease.startAt, lease.endAt)
    ) {
      if (lease.performanceId === performanceId && lease.roleId === roleId) {
        return { kind: "same_holder", lease };
      }
      return { kind: "conflict", lease };
    }
  }
  return null;
}

export function groupKey(cueType) {
  return `group:${cueType}`;
}

/** 一次换角需要的全部签署：替演本人 + 每个受影响执行组 + 舞台监督。 */
export function requiredSignatures(request, cues) {
  const groups = new Set(cues.map((c) => groupKey(c.type)));
  return ["understudy", ...[...groups].sort(), "stage_manager"];
}

export function missingSignatures(request, cues) {
  return requiredSignatures(request, cues).filter((key) => !request.signatures[key]);
}

export function activeLeasesFor(state, resourceKind, resourceId, at) {
  const moment = ts(at);
  return Object.values(state.leases).filter(
    (l) =>
      l.status === "granted" &&
      l.resourceKind === resourceKind &&
      l.resourceId === resourceId &&
      ts(l.startAt) <= moment &&
      moment < ts(l.endAt),
  );
}

/* ------------------------------ reducer ------------------------------ */

function applyEvent(state, event) {
  const { type, payload } = event;
  switch (type) {
    case "person_registered":
      state.people[payload.id] = payload;
      break;
    case "show_created":
      state.shows[payload.id] = payload;
      break;
    case "package_created":
      state.cuePackages[payload.id] = payload;
      break;
    case "role_version_created":
      state.roleVersions[payload.id] = { ...payload, understudies: [...payload.understudies] };
      break;
    case "receipt_recorded":
      state.rehearsalReceipts[payload.id] = payload;
      break;
    case "performance_created":
      state.performances[payload.id] = payload;
      break;
    case "package_released": {
      const performance = state.performances[payload.performanceId];
      performance.release = {
        packageId: payload.packageId,
        version: payload.version,
        at: payload.at,
        cues: payload.cues,
      };
      break;
    }
    case "performance_started": {
      state.performances[payload.performanceId].startedAt = payload.at;
      state.performances[payload.performanceId].activeRoleAuthorizations =
        payload.activeRoleAuthorizations;
      break;
    }
    case "request_created":
      state.requests[payload.id] = payload;
      break;
    case "request_withdrawn":
      state.requests[payload.requestId].status = "withdrawn";
      break;
    case "request_superseded":
      state.requests[payload.requestId].status = "superseded";
      state.requests[payload.requestId].supersededBy = payload.byRequestId;
      break;
    case "reconfirmation_recorded":
      state.reconfirmations[payload.id] = payload;
      break;
    case "request_signed": {
      const request = state.requests[payload.requestId];
      request.signatures[payload.key] = {
        personId: payload.personId,
        at: payload.at,
      };
      break;
    }
    case "request_readied":
      state.requests[payload.requestId].status = "ready";
      break;
    case "request_unreadied":
      state.requests[payload.requestId].status = "frozen";
      break;
    case "authorization_created":
      state.authorizations[payload.id] = payload;
      break;
    case "request_authorized": {
      const request = state.requests[payload.requestId];
      request.status = "authorized";
      request.authorizationId = payload.authorizationId;
      break;
    }
    case "authorization_status_changed": {
      const auth = state.authorizations[payload.authorizationId];
      auth.status = payload.status;
      auth.statusReason = payload.reason;
      break;
    }
    case "lease_granted":
      state.leases[payload.id] = payload;
      break;
    case "lease_released": {
      state.leases[payload.leaseId].status = "released";
      state.leases[payload.leaseId].releasedAt = payload.at;
      break;
    }
    case "safety_point_declared":
      state.safetyPoints[payload.id] = payload;
      break;
    case "switch_executed": {
      const performance = state.performances[payload.performanceId];
      for (const activation of payload.activations) {
        performance.activeRoleAuthorizations[activation.roleId] = activation.authorizationId;
      }
      performance.switches = [...(performance.switches ?? []), payload];
      state.safetyPoints[payload.safetyPointId].usedBySwitchId = payload.id;
      break;
    }
    case "bypass_recorded":
      state.bypasses[payload.id] = { ...payload, disposition: "unused" };
      break;
    case "cue_attempt_recorded":
      state.executions.push(payload);
      if (payload.outcome.startsWith("executed") && payload.bypassId) {
        state.bypasses[payload.bypassId].disposition = "used";
        state.bypasses[payload.bypassId].usedByExecutionId = payload.id;
      }
      break;
    default:
      throw new Error(`未知事件类型: ${type}`);
  }
}

registerReducer(applyEvent);
