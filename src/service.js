import {
  CUE_GROUPS,
  checkQualification,
  findLeaseConflict,
  groupKey,
  impactedCueClosure,
  isHighRisk,
  missingSignatures,
  requiredSignatures,
  ts,
} from "./domain.js";

export class ApiError extends Error {
  constructor(status, code, details = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const require_ = (body, field) => {
  if (body[field] === undefined || body[field] === null) {
    throw new ApiError(400, "missing_field", { field });
  }
  return body[field];
};

const WINDOW_MS = 3 * 60 * 60 * 1000;

export class CueService {
  constructor(store) {
    this.store = store;
  }

  get s() {
    return this.store.state;
  }

  at(body = {}) {
    return body.at ?? this.store.now();
  }

  #id(prefix, body) {
    return body.id ?? this.store.nextId(prefix);
  }

  #get(collection, id, label) {
    const item = this.s[collection][id];
    if (!item) throw new ApiError(404, "not_found", { entity: label, id });
    return item;
  }

  /* ----------------------------- 基础档案 ----------------------------- */

  registerPerson(body) {
    const id = this.#id("ppl", body);
    const kind = require_(body, "kind"); // performer | group | stage_manager
    if (!["performer", "group", "stage_manager"].includes(kind)) {
      throw new ApiError(400, "invalid_kind", { kind });
    }
    const person = {
      id,
      name: body.name ?? id,
      kind,
      // 组主体的专业类型；组员（performer）也可用 groupType 标明所属专业，
      // 以便以个人身份录入本组口令的重确认。
      groupType: body.groupType ?? null,
    };
    this.store.mutate("person_registered", person);
    return person;
  }

  createShow(body) {
    const show = { id: this.#id("show", body), title: require_(body, "title") };
    this.store.mutate("show_created", show);
    return show;
  }

  createPackage(body) {
    const showId = require_(body, "showId");
    this.#get("shows", showId, "show");
    const cueIds = new Set();
    const cues = (body.cues ?? []).map((cue) => {
      if (!cue.id || cueIds.has(cue.id)) throw new ApiError(400, "bad_cue_id", { cue });
      cueIds.add(cue.id);
      if (!CUE_GROUPS[cue.type]) throw new ApiError(400, "bad_cue_type", { cueId: cue.id, type: cue.type });
      return {
        id: cue.id,
        type: cue.type,
        label: cue.label ?? cue.id,
        action: cue.action ?? null,
        dependsOn: [...(cue.dependsOn ?? [])],
        roles: [...(cue.roles ?? [])],
        rehearsalSegments: [...(cue.rehearsalSegments ?? [])],
        equipmentIds: [...(cue.equipmentIds ?? [])],
      };
    });
    for (const cue of cues) {
      for (const dep of cue.dependsOn) {
        if (!cueIds.has(dep)) throw new ApiError(400, "unknown_dependency", { cueId: cue.id, dependsOn: dep });
      }
    }
    const pkg = {
      id: this.#id("pkg", body),
      showId,
      version: body.version ?? 1,
      cues,
      immutable: true,
    };
    this.store.mutate("package_created", pkg);
    return pkg;
  }

  createRoleVersion(body) {
    const showId = require_(body, "showId");
    this.#get("shows", showId, "show");
    const validFrom = require_(body, "validFrom");
    const validTo = require_(body, "validTo");
    if (ts(validTo) <= ts(validFrom)) throw new ApiError(400, "bad_validity_window");
    const understudies = (body.understudies ?? []).map((u, index) => ({
      performerId: require_(u, "performerId"),
      order: u.order ?? index + 1,
      actionRestrictions: [...(u.actionRestrictions ?? [])],
    }));
    const orders = new Set();
    for (const u of understudies) {
      if (orders.has(u.order)) throw new ApiError(400, "duplicate_understudy_order", { order: u.order });
      orders.add(u.order);
      const person = this.#get("people", u.performerId, "person");
      if (person.kind !== "performer") throw new ApiError(400, "not_a_performer", { personId: u.performerId });
    }
    const roleId = body.roleId ?? `role_${this.s.idSeq + 1}`;
    const roleVersion = {
      id: this.#id("role", body),
      showId,
      roleId,
      roleName: require_(body, "roleName"),
      leadPerformerId: require_(body, "leadPerformerId"),
      understudies: understudies.sort((a, b) => a.order - b.order),
      actionRestrictions: [...(body.actionRestrictions ?? [])],
      validFrom,
      validTo,
    };
    this.store.mutate("role_version_created", roleVersion);
    return roleVersion;
  }

  recordReceipt(body) {
    const roleVersion = this.#get("roleVersions", require_(body, "roleVersionId"), "role_version");
    const performerId = require_(body, "performerId");
    this.#get("people", performerId, "person");
    const status = body.status ?? "passed";
    if (!["passed", "failed"].includes(status)) throw new ApiError(400, "bad_receipt_status", { status });
    if (!body.segmentId && !body.action) throw new ApiError(400, "receipt_requires_segment_or_action");
    // 迟到回执只追加事实；不触碰任何已执行/已阻断记录。
    const receipt = {
      id: this.#id("rcpt", body),
      roleVersionId: roleVersion.id,
      performerId,
      segmentId: body.segmentId ?? null,
      action: body.action ?? null,
      status,
      at: this.at(body),
    };
    this.store.mutate("receipt_recorded", receipt);
    return receipt;
  }

  /* ----------------------------- 场次与放行 ----------------------------- */

  createPerformance(body) {
    const showId = require_(body, "showId");
    this.#get("shows", showId, "show");
    const startAt = require_(body, "startAt");
    const endAt = body.endAt ?? new Date(ts(startAt) + WINDOW_MS).toISOString();
    if (ts(endAt) <= ts(startAt)) throw new ApiError(400, "bad_performance_window");
    const performance = {
      id: this.#id("perf", body),
      showId,
      startAt,
      endAt,
      release: null,
      startedAt: null,
      activeRoleAuthorizations: {},
      switches: [],
    };
    this.store.mutate("performance_created", performance);
    return performance;
  }

  releasePackage(performanceId, body) {
    const performance = this.#get("performances", performanceId, "performance");
    const pkg = this.#get("cuePackages", require_(body, "packageId"), "cue_package");
    if (pkg.showId !== performance.showId) throw new ApiError(400, "package_show_mismatch");
    if (performance.release) throw new ApiError(409, "already_released", { packageId: performance.release.packageId });
    const frozen = {
      performanceId,
      packageId: pkg.id,
      version: pkg.version,
      at: this.at(body),
      cues: JSON.parse(JSON.stringify(pkg.cues)),
    };
    this.store.mutate("package_released", frozen);
    return { ...frozen, cueCount: frozen.cues.length };
  }

  /* ----------------------------- 换角申请 ----------------------------- */

  createChangeRequest(performanceId, body) {
    const performance = this.#get("performances", performanceId, "performance");
    if (!performance.release) throw new ApiError(409, "no_release");
    const roleVersion = this.#get("roleVersions", require_(body, "roleVersionId"), "role_version");
    if (roleVersion.showId !== performance.showId) throw new ApiError(400, "role_show_mismatch");
    const replacementPerformerId = require_(body, "replacementPerformerId");
    const listed = roleVersion.understudies.find((u) => u.performerId === replacementPerformerId);
    if (!listed) throw new ApiError(400, "not_listed_understudy", { performerId: replacementPerformerId });
    const reason = require_(body, "reason");

    // 冻结当前放行版（快照进申请，之后任何变化都不影响本场判断）。
    const frozenCues = JSON.parse(JSON.stringify(performance.release.cues));
    const impacted = impactedCueClosure({ cues: frozenCues }, roleVersion.roleId);
    const request = {
      id: this.#id("req", body),
      performanceId,
      roleVersionId: roleVersion.id,
      roleId: roleVersion.roleId,
      replacementPerformerId,
      reason,
      notes: body.notes ?? null,
      status: "frozen",
      frozenPackageId: performance.release.packageId,
      frozenPackageVersion: performance.release.version,
      frozenAt: this.at(body),
      impactedCueIds: impacted.map((c) => c.id),
      signatures: {},
      authorizationId: null,
      supersededBy: null,
    };

    // 同角色已有待办申请：新申请唯一有效，旧申请作废（人只能沿一条链交接）。
    for (const prior of Object.values(this.s.requests)) {
      if (
        prior.performanceId === performanceId &&
        prior.roleId === roleVersion.roleId &&
        ["frozen", "ready"].includes(prior.status)
      ) {
        this.store.mutate("request_superseded", { requestId: prior.id, byRequestId: request.id });
      }
    }
    this.store.mutate("request_created", request);
    return this.requestReport(request.id);
  }

  withdrawRequest(requestId, body = {}) {
    const request = this.#get("requests", requestId, "change_request");
    if (["authorized", "superseded", "withdrawn"].includes(request.status)) {
      throw new ApiError(409, "request_not_open", { status: request.status });
    }
    this.store.mutate("request_withdrawn", { requestId, at: this.at(body) });
    return this.requestReport(requestId);
  }

  #cueById(request, cueId) {
    const cue = this.s.performances[request.performanceId].release.cues.find((c) => c.id === cueId);
    if (!cue) throw new ApiError(404, "not_found", { entity: "cue", id: cueId });
    return cue;
  }

  #assertOpen(request) {
    if (request.status === "superseded") throw new ApiError(409, "request_superseded");
    if (request.status === "withdrawn") throw new ApiError(409, "request_withdrawn");
    if (request.status === "authorized") throw new ApiError(409, "request_authorized");
  }

  recordReconfirmation(requestId, body) {
    const request = this.#get("requests", requestId, "change_request");
    this.#assertOpen(request);
    const cueId = require_(body, "cueId");
    if (!request.impactedCueIds.includes(cueId)) {
      throw new ApiError(400, "cue_not_impacted", { cueId });
    }
    const cue = this.#cueById(request, cueId);
    const decision = require_(body, "decision");
    if (!["confirmed", "adjusted", "blocked"].includes(decision)) {
      throw new ApiError(400, "bad_decision", { decision });
    }
    const person = this.#get("people", require_(body, "personId"), "person");
    // 重确认由对应执行组人员录入（组主体或所属专业匹配的组员）；
    // 监督与替演另有签署席，不得在此代录，否则无人能避开自签复核。
    if (person.groupType !== cue.type) {
      throw new ApiError(403, "wrong_execution_group", { expected: cue.type, actual: person.groupType });
    }
    const reconfirmation = {
      id: this.#id("rcf", body),
      requestId,
      performanceId: request.performanceId,
      cueId,
      cueType: cue.type,
      decision,
      detail: body.detail ?? null,
      personId: person.id,
      at: this.at(body),
    };
    this.store.mutate("reconfirmation_recorded", reconfirmation);
    this.#refreshReady(request);
    return this.requestReport(requestId);
  }

  signRequest(requestId, body) {
    const request = this.#get("requests", requestId, "change_request");
    this.#assertOpen(request);
    const role = require_(body, "role");
    const frozenCues = this.s.performances[request.performanceId].release.cues;
    const validKeys = requiredSignatures(request, frozenCues.filter((c) => request.impactedCueIds.includes(c.id)));
    if (!validKeys.includes(role)) throw new ApiError(400, "not_a_signing_seat", { role, validKeys });
    const person = this.#get("people", require_(body, "personId"), "person");

    // 按职责对号入座。
    if (role === "understudy") {
      if (person.id !== request.replacementPerformerId) throw new ApiError(403, "must_be_understudy");
      if (person.kind !== "performer") throw new ApiError(403, "must_be_performer");
    } else if (role === "stage_manager") {
      if (person.kind !== "stage_manager") throw new ApiError(403, "must_be_stage_manager");
    } else {
      const cueType = role.slice("group:".length);
      const belongsToGroup =
        (person.kind === "group" && person.groupType === cueType) ||
        (person.kind === "performer" && person.groupType === cueType);
      if (!belongsToGroup) {
        throw new ApiError(403, "must_be_execution_group", { expected: cueType });
      }
      // 任何人不能代签自己的复核：该专业口令的复核录入人不得再坐执行组签署席。
      const ownReviews = Object.values(this.s.reconfirmations)
        .filter((r) => r.requestId === requestId && r.cueType === cueType && r.personId === person.id);
      if (ownReviews.length > 0) throw new ApiError(403, "cannot_countersign_own_review");
    }
    // 一个人不能占两个签署席。
    for (const [key, sig] of Object.entries(request.signatures)) {
      if (sig.personId === person.id) throw new ApiError(403, "person_already_signed", { seat: key });
    }
    if (request.signatures[role]) throw new ApiError(409, "seat_already_signed", { role });

    this.store.mutate("request_signed", {
      requestId,
      performanceId: request.performanceId,
      key: role,
      personId: person.id,
      at: this.at(body),
    });
    this.#refreshReady(requestId);
    return this.requestReport(requestId);
  }

  #reconfirmationMap(request) {
    const map = new Map();
    for (const r of Object.values(this.s.reconfirmations)) {
      if (r.requestId === request.id) map.set(r.cueId, r);
    }
    return map;
  }

  #refreshReady(requestOrId) {
    const request =
      typeof requestOrId === "string" ? this.s.requests[requestOrId] : requestOrId;
    if (!request || !["frozen", "ready"].includes(request.status)) return;
    const reconf = this.#reconfirmationMap(request);
    const allDecided = request.impactedCueIds.every((id) => reconf.has(id));
    const anyBlocked = [...reconf.values()].some((r) => r.decision === "blocked");
    const frozenCues = this.s.performances[request.performanceId].release.cues;
    const impacted = frozenCues.filter((c) => request.impactedCueIds.includes(c.id));
    const allSigned = missingSignatures(request, impacted).length === 0;
    const ready = allDecided && !anyBlocked && allSigned;
    if (ready && request.status === "frozen") {
      this.store.mutate("request_readied", { requestId: request.id, performanceId: request.performanceId });
    } else if (!ready && request.status === "ready") {
      // 齐备后若判定被改回阻断，状态必须回退，授权门禁随之关闭（已完成签署保留）。
      this.store.mutate("request_unreadied", { requestId: request.id, performanceId: request.performanceId });
    }
  }

  requestReport(requestId) {
    const request = this.#get("requests", requestId, "change_request");
    const performance = this.s.performances[request.performanceId];
    const frozenCues = performance.release.cues;
    const impacted = frozenCues.filter((c) => request.impactedCueIds.includes(c.id));
    const reconf = this.#reconfirmationMap(request);
    const roleVersion = this.s.roleVersions[request.roleVersionId];
    const cueReports = impacted.map((cue) => {
      const qualification = checkQualification(
        this.s,
        roleVersion,
        request.replacementPerformerId,
        cue,
        this.store.now(),
      );
      return {
        cueId: cue.id,
        cueType: cue.type,
        highRisk: isHighRisk(cue),
        reconfirmation: reconf.get(cue.id)
          ? { decision: reconf.get(cue.id).decision, personId: reconf.get(cue.id).personId, at: reconf.get(cue.id).at }
          : null,
        qualification,
      };
    });
    return {
      ...request,
      impactedCues: cueReports,
      requiredSignatures: requiredSignatures(request, impacted),
      missingSignatures: missingSignatures(request, impacted),
    };
  }

  /* ------------------------------- 租约 ------------------------------- */

  #desiredLeases(request, performance) {
    const desired = new Map();
    desired.set(`performer:${request.replacementPerformerId}`, {
      resourceKind: "performer",
      resourceId: request.replacementPerformerId,
      roleId: request.roleId,
    });
    // 高风险设备（升降台、烟火装置等）须随本场授权唯一占用；普通道具不进租约。
    for (const cue of performance.release.cues) {
      if (!request.impactedCueIds.includes(cue.id) || !isHighRisk(cue)) continue;
      for (const equipmentId of cue.equipmentIds) {
        desired.set(`equipment:${equipmentId}`, {
          resourceKind: "equipment",
          resourceId: equipmentId,
          roleId: request.roleId,
        });
      }
    }
    return [...desired.values()];
  }

  acquireLease(body) {
    const performance = this.#get("performances", require_(body, "performanceId"), "performance");
    const resourceKind = require_(body, "resourceKind");
    const resourceId = require_(body, "resourceId");
    const roleId = require_(body, "roleId");
    const startAt = body.startAt ?? performance.startAt;
    const endAt = body.endAt ?? performance.endAt;
    return this.#grantLease(performance, { resourceKind, resourceId, roleId }, startAt, endAt, body);
  }

  #grantLease(performance, spec, startAt, endAt, body = {}) {
    const conflict = findLeaseConflict(
      this.s,
      spec.resourceKind,
      spec.resourceId,
      startAt,
      endAt,
      performance.id,
      spec.roleId,
    );
    if (conflict?.kind === "same_holder") return conflict.lease;
    if (conflict) {
      throw new ApiError(409, "lease_conflict", {
        resourceKind: spec.resourceKind,
        resourceId: spec.resourceId,
        holder: {
          leaseId: conflict.lease.id,
          performanceId: conflict.lease.performanceId,
          roleId: conflict.lease.roleId,
        },
      });
    }
    const lease = {
      id: this.#id("lease", body),
      performanceId: performance.id,
      roleId: spec.roleId,
      resourceKind: spec.resourceKind,
      resourceId: spec.resourceId,
      startAt,
      endAt,
      status: "granted",
      grantedAt: this.at(body),
      releasedAt: null,
    };
    this.store.mutate("lease_granted", lease);
    return lease;
  }

  releaseLease(leaseId, body = {}) {
    const lease = this.#get("leases", leaseId, "lease");
    if (lease.status !== "granted") throw new ApiError(409, "lease_not_active", { status: lease.status });
    this.store.mutate("lease_released", { leaseId, at: this.at(body) });
    return this.s.leases[leaseId];
  }

  listLeases(query) {
    return Object.values(this.s.leases).filter(
      (l) =>
        (!query.resourceKind || l.resourceKind === query.resourceKind) &&
        (!query.resourceId || l.resourceId === query.resourceId),
    );
  }

  /* ----------------------------- 本场授权 ----------------------------- */

  authorize(requestId, body = {}) {
    const request = this.#get("requests", requestId, "change_request");
    this.#assertOpen(request);
    if (request.status !== "ready") {
      const report = this.requestReport(requestId);
      throw new ApiError(409, "request_not_ready", {
        missingSignatures: report.missingSignatures,
        undecidedCues: report.impactedCues.filter((c) => !c.reconfirmation).map((c) => c.cueId),
        blockedCues: report.impactedCues
          .filter((c) => c.reconfirmation?.decision === "blocked")
          .map((c) => c.cueId),
      });
    }
    const performance = this.s.performances[request.performanceId];
    const roleVersion = this.s.roleVersions[request.roleVersionId];
    const now = this.at(body);
    if (ts(now) > ts(roleVersion.validTo)) throw new ApiError(403, "role_version_expired");
    if (ts(now) >= ts(performance.endAt)) throw new ApiError(409, "performance_ended");

    // 先做全部冲突检查，再落任何事件：两个场次抢同一替演/设备时，租约给出唯一赢家。
    const desired = this.#desiredLeases(request, performance);
    for (const spec of desired) {
      const conflict = findLeaseConflict(
        this.s,
        spec.resourceKind,
        spec.resourceId,
        performance.startAt,
        performance.endAt,
        performance.id,
        spec.roleId,
      );
      if (conflict?.kind === "conflict") {
        throw new ApiError(409, "lease_conflict", {
          resourceKind: spec.resourceKind,
          resourceId: spec.resourceId,
          holder: {
            leaseId: conflict.lease.id,
            performanceId: conflict.lease.performanceId,
            roleId: conflict.lease.roleId,
          },
        });
      }
    }

    const leaseIds = [];
    for (const spec of desired) {
      const lease = this.#grantLease(performance, spec, performance.startAt, performance.endAt, body);
      leaseIds.push(lease.id);
    }

    const reconf = this.#reconfirmationMap(request);
    const authorization = {
      id: this.#id("auth", body),
      performanceId: performance.id,
      requestId,
      roleVersionId: roleVersion.id,
      roleId: request.roleId,
      performerId: request.replacementPerformerId,
      scopeCueIds: [...request.impactedCueIds],
      cueBasis: Object.fromEntries(
        request.impactedCueIds.map((cueId) => [cueId, reconf.get(cueId).decision]),
      ),
      leaseIds,
      status: "active",
      validFrom: now,
      validUntil: roleVersion.validTo < performance.endAt ? roleVersion.validTo : performance.endAt,
      createdAt: now,
    };
    this.store.mutate("authorization_created", authorization);
    this.store.mutate("request_authorized", { requestId, authorizationId: authorization.id });
    return authorization;
  }

  /* ------------------------------- 开演 ------------------------------- */

  startPerformance(performanceId, body = {}) {
    const performance = this.#get("performances", performanceId, "performance");
    if (performance.startedAt) throw new ApiError(409, "already_started", { at: performance.startedAt });
    if (!performance.release) throw new ApiError(409, "no_release");
    const at = this.at(body);
    // 开演瞬间固化本场角色→授权映射；之后换角只能走预先验证的安全点。
    const active = {};
    for (const auth of Object.values(this.s.authorizations)) {
      if (auth.performanceId === performanceId && auth.status === "active" && ts(auth.validUntil) > ts(at)) {
        active[auth.roleId] = auth.id;
      }
    }
    this.store.mutate("performance_started", { performanceId, at, activeRoleAuthorizations: active });
    return this.s.performances[performanceId];
  }

  declareSafetyPoint(performanceId, body) {
    const performance = this.#get("performances", performanceId, "performance");
    // 安全点必须在开演前申报并验证；开演后不得临时增设。
    if (performance.startedAt) throw new ApiError(409, "performance_already_started");
    const cueId = require_(body, "cueId");
    const releaseCue = performance.release?.cues.find((c) => c.id === cueId);
    if (!releaseCue) throw new ApiError(400, "cue_not_in_release", { cueId });
    const point = {
      id: this.#id("safe", body),
      performanceId,
      cueId,
      label: body.label ?? `安全点@${cueId}`,
      declaredAt: this.at(body),
      usedBySwitchId: null,
    };
    this.store.mutate("safety_point_declared", point);
    return point;
  }

  switchAtSafetyPoint(performanceId, body) {
    const performance = this.#get("performances", performanceId, "performance");
    if (!performance.startedAt) throw new ApiError(409, "not_started");
    const point = this.#get("safetyPoints", require_(body, "safetyPointId"), "safety_point");
    if (point.performanceId !== performanceId) throw new ApiError(400, "safety_point_wrong_performance");
    if (ts(point.declaredAt) > ts(performance.startedAt)) {
      throw new ApiError(409, "safety_point_not_preverified", { safetyPointId: point.id });
    }
    if (point.usedBySwitchId) throw new ApiError(409, "safety_point_used", { switchId: point.usedBySwitchId });

    const reached = this.s.executions.some(
      (e) => e.performanceId === performanceId && e.cueId === point.cueId && e.outcome.startsWith("executed"),
    );
    if (!reached) throw new ApiError(409, "safety_point_not_reached", { cueId: point.cueId });

    const items = require_(body, "items");
    if (!Array.isArray(items) || items.length === 0) throw new ApiError(400, "bad_switch_items");
    const now = this.at(body);
    const activations = [];
    for (const item of items) {
      const auth = this.#get("authorizations", require_(item, "authorizationId"), "authorization");
      if (auth.performanceId !== performanceId) throw new ApiError(400, "authorization_wrong_performance");
      if (auth.roleId !== require_(item, "roleId")) throw new ApiError(400, "role_authorization_mismatch");
      // 授权本身仍须有效（签署、租约、有效期均已在授权与执行环节把关）。
      if (auth.status !== "active" || ts(auth.validUntil) <= ts(now)) {
        throw new ApiError(409, "authorization_not_usable", { authorizationId: auth.id, status: auth.status });
      }
      activations.push({ roleId: auth.roleId, authorizationId: auth.id });
    }
    const switchRecord = {
      id: this.#id("sw", body),
      performanceId,
      safetyPointId: point.id,
      // 被替换的授权留痕，供复盘还原人员变更链。
      deactivations: [],
      activations,
      releasedLeaseIds: [],
      at: now,
    };
    for (const activation of activations) {
      const oldAuthId = performance.activeRoleAuthorizations[activation.roleId];
      if (oldAuthId && oldAuthId !== activation.authorizationId) {
        switchRecord.deactivations.push(oldAuthId);
        const oldAuth = this.s.authorizations[oldAuthId];
        const newAuth = this.s.authorizations[activation.authorizationId];
        // 被替下演员的人员租约随换人释放；高风险设备租约本场继续持有。
        for (const leaseId of oldAuth.leaseIds) {
          const lease = this.s.leases[leaseId];
          if (lease && lease.status === "granted" && lease.resourceKind === "performer") {
            this.store.mutate("lease_released", { leaseId, at: now, reason: `switch:${switchRecord.id}` });
            switchRecord.releasedLeaseIds.push(leaseId);
          }
        }
        this.store.mutate("authorization_status_changed", {
          authorizationId: oldAuthId,
          status: "exhausted",
          reason: `superseded_by_switch:${switchRecord.id}`,
        });
        this.store.mutate("request_superseded", {
          requestId: oldAuth.requestId,
          byRequestId: newAuth.requestId,
        });
      }
    }
    this.store.mutate("switch_executed", switchRecord);
    return switchRecord;
  }

  /* ----------------------------- 紧急人工跳过 ----------------------------- */

  createBypass(body) {
    const performance = this.#get("performances", require_(body, "performanceId"), "performance");
    const reason = require_(body, "reason");
    if (String(reason).trim().length === 0) throw new ApiError(400, "reason_required");
    const person = this.#get("people", require_(body, "responsiblePersonId"), "person");
    if (person.kind !== "stage_manager") throw new ApiError(403, "bypass_requires_stage_manager");
    let cueId = body.cueId ?? null;
    if (cueId && !performance.release.cues.some((c) => c.id === cueId)) {
      throw new ApiError(400, "cue_not_in_release", { cueId });
    }
    const bypass = {
      id: this.#id("byp", body),
      performanceId: performance.id,
      cueId,
      reason,
      responsiblePersonId: person.id,
      at: this.at(body),
      disposition: "unused",
      usedByExecutionId: null,
    };
    this.store.mutate("bypass_recorded", bypass);
    return bypass;
  }

  /* ------------------------------- 执行门禁 ------------------------------- */

  #executedCueIds(performanceId) {
    return new Set(
      this.s.executions
        .filter((e) => e.performanceId === performanceId && e.outcome.startsWith("executed"))
        .map((e) => e.cueId),
    );
  }

  executeCue(body) {
    const performance = this.#get("performances", require_(body, "performanceId"), "performance");
    if (!performance.release) throw new ApiError(409, "no_release");
    if (!performance.startedAt) throw new ApiError(409, "not_started");
    const cueId = require_(body, "cueId");
    const cue = performance.release.cues.find((c) => c.id === cueId);
    if (!cue) throw new ApiError(404, "not_found", { entity: "cue", id: cueId });
    const now = this.at(body);

    // 紧急跳过单先校验：一次性使用，原因与责任人在签发时已留痕。
    let bypass = null;
    if (body.bypassId) {
      bypass = this.#get("bypasses", body.bypassId, "bypass");
      if (bypass.disposition === "used") throw new ApiError(409, "bypass_already_used");
      if (bypass.performanceId !== performance.id) throw new ApiError(400, "bypass_wrong_performance");
      if (bypass.cueId && bypass.cueId !== cueId) throw new ApiError(400, "bypass_wrong_cue");
    }

    const executed = this.#executedCueIds(performance.id);
    if (executed.has(cueId)) throw new ApiError(409, "already_executed", { cueId });

    const reasons = [];
    const basisAuthorizationIds = [];

    for (const dep of cue.dependsOn) {
      if (!executed.has(dep)) reasons.push(`dependency_not_executed:${dep}`);
    }

    // 解析该口令涉及角色的当前生效授权（开演映射 + 安全点切换）。
    const activeAuths = [];
    for (const roleId of cue.roles) {
      const authId = performance.activeRoleAuthorizations[roleId];
      if (!authId) continue; // 未换角角色由放行版基线覆盖
      const auth = this.s.authorizations[authId];
      if (!auth || auth.status !== "active" || ts(auth.validUntil) <= ts(now)) {
        reasons.push(`authorization_invalid:${roleId}`);
        continue;
      }
      activeAuths.push(auth);
      basisAuthorizationIds.push(auth.id);
      if (!auth.scopeCueIds.includes(cueId)) reasons.push(`outside_authorization_scope:${roleId}`);
      const basis = auth.cueBasis[cueId];
      if (basis === "blocked") reasons.push(`blocked_reconfirmation:${roleId}`);
      else if (!basis) reasons.push(`missing_reconfirmation:${roleId}`);
      const roleVersion = this.s.roleVersions[auth.roleVersionId];
      const qualification = checkQualification(this.s, roleVersion, auth.performerId, cue, now);
      if (!qualification.eligible) {
        for (const reason of qualification.reasons) reasons.push(`${roleId}:${reason}`);
      }
    }

    // 租约校验：替演本人与高风险设备必须仍由本场持有。
    for (const auth of activeAuths) {
      const performerLease = Object.values(this.s.leases).find(
        (l) =>
          l.id &&
          auth.leaseIds.includes(l.id) &&
          l.resourceKind === "performer" &&
          l.resourceId === auth.performerId &&
          l.status === "granted" &&
          ts(l.startAt) <= ts(now) &&
          ts(now) < ts(l.endAt),
      );
      if (!performerLease) reasons.push("performer_lease_inactive");
    }
    if (isHighRisk(cue)) {
      for (const equipmentId of cue.equipmentIds) {
        const lease = Object.values(this.s.leases).find(
          (l) =>
            l.status === "granted" &&
            l.resourceKind === "equipment" &&
            l.resourceId === equipmentId &&
            l.performanceId === performance.id &&
            ts(l.startAt) <= ts(now) &&
            ts(now) < ts(l.endAt),
        );
        if (!lease) reasons.push(`equipment_lease_missing:${equipmentId}`);
      }
    }

    // 紧急人工跳过的原因与责任人在签发时留痕；此处仅记录一次性使用。
    const record = {
      id: this.#id("exe", body),
      performanceId: performance.id,
      cueId,
      cueType: cue.type,
      at: now,
      actorPersonId: body.actorPersonId ?? null,
      authorizationIds: basisAuthorizationIds,
      bypassId: bypass?.id ?? null,
      outcome: reasons.length === 0 ? "executed" : bypass ? "executed_with_bypass" : "blocked",
      reasons,
    };
    this.store.mutate("cue_attempt_recorded", record);

    if (record.outcome === "blocked") {
      throw new ApiError(403, "cue_blocked", { attempt: record });
    }
    return record;
  }

  /* ------------------------------- 复盘 ------------------------------- */

  getPerformance(performanceId) {
    const performance = this.#get("performances", performanceId, "performance");
    const activeAuthorizations = {};
    for (const [roleId, authId] of Object.entries(performance.activeRoleAuthorizations)) {
      const auth = this.s.authorizations[authId];
      activeAuthorizations[roleId] = auth
        ? {
            authorizationId: auth.id,
            performerId: auth.performerId,
            requestId: auth.requestId,
            status: auth.status,
            validUntil: auth.validUntil,
          }
        : { authorizationId: authId, missing: true };
    }
    return {
      id: performance.id,
      showId: performance.showId,
      startAt: performance.startAt,
      endAt: performance.endAt,
      release: performance.release
        ? { packageId: performance.release.packageId, version: performance.release.version, at: performance.release.at }
        : null,
      startedAt: performance.startedAt,
      activeAuthorizations,
      switchCount: (performance.switches ?? []).length,
    };
  }

  performanceTimeline(performanceId) {
    const performance = this.#get("performances", performanceId, "performance");
    const requestIds = new Set(
      Object.values(this.s.requests)
        .filter((r) => r.performanceId === performanceId)
        .map((r) => r.id),
    );
    const leaseIds = new Set(
      Object.values(this.s.leases)
        .filter((l) => l.performanceId === performanceId)
        .map((l) => l.id),
    );
    const REQUEST_EVENTS = new Set([
      "request_superseded",
      "request_signed",
      "request_readied",
      "request_unreadied",
      "request_authorized",
      "request_withdrawn",
    ]);
    // 按追加序号（真实发生顺序）而非客户端时间戳重放。
    const timeline = [];
    for (const event of this.s.events) {
      const p = event.payload;
      if (p.performanceId === performanceId) {
        timeline.push({ seq: event.seq, at: event.at, type: event.type, payload: p });
      } else if (REQUEST_EVENTS.has(event.type) && requestIds.has(p.requestId)) {
        timeline.push({ seq: event.seq, at: event.at, type: event.type, payload: p });
      } else if (event.type === "lease_released" && leaseIds.has(p.leaseId)) {
        timeline.push({ seq: event.seq, at: event.at, type: event.type, payload: p });
      }
    }

    // 散场复盘汇总：人员变更链、最终重确认结论、被阻断动作与每条口令的最终执行依据。
    const personnelChanges = (performance.switches ?? []).map((sw) => ({
      switchId: sw.id,
      at: sw.at,
      safetyPointId: sw.safetyPointId,
      activations: sw.activations,
      deactivatedAuthorizations: sw.deactivations,
    }));
    const blockedActions = this.s.executions
      .filter((e) => e.performanceId === performanceId && e.outcome === "blocked")
      .map((e) => ({ cueId: e.cueId, cueType: e.cueType, at: e.at, reasons: e.reasons }));
    const executedActions = this.s.executions
      .filter((e) => e.performanceId === performanceId && e.outcome.startsWith("executed"))
      .map((e) => ({
        cueId: e.cueId,
        outcome: e.outcome,
        at: e.at,
        authorizationIds: e.authorizationIds,
        bypassId: e.bypassId,
      }));
    const finalReconfirmations = {};
    for (const requestId of requestIds) {
      for (const r of Object.values(this.s.reconfirmations)) {
        if (r.requestId === requestId) {
          // 同口令多次判定时保留最新一条（事件顺序即真实顺序）。
          finalReconfirmations[r.cueId] = {
            decision: r.decision,
            personId: r.personId,
            at: r.at,
            requestId,
          };
        }
      }
    }
    const bypassesUsed = Object.values(this.s.bypasses)
      .filter((b) => b.performanceId === performanceId && b.disposition === "used")
      .map((b) => ({
        id: b.id,
        cueId: b.cueId,
        reason: b.reason,
        responsiblePersonId: b.responsiblePersonId,
        at: b.at,
        usedByExecutionId: b.usedByExecutionId,
      }));

    return {
      performanceId,
      release: performance.release
        ? {
            packageId: performance.release.packageId,
            version: performance.release.version,
            frozenAt: performance.release.at,
          }
        : null,
      startedAt: performance.startedAt,
      activeRoleAuthorizations: performance.activeRoleAuthorizations,
      summary: {
        personnelChanges,
        finalReconfirmations,
        blockedActions,
        executedActions,
        bypassesUsed,
      },
      timeline,
    };
  }
}
