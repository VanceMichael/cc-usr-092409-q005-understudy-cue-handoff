import fs from "node:fs";
import path from "node:path";
import {
  CUE_TYPES,
  DEPARTMENTS,
  HIGH_RISK_CUE_TYPES,
  computeAffectedCues,
  signatureEligibility,
  staffRoleValid,
} from "./domain.js";
import { newId, parseInstant } from "./util.js";

const EVENT_LOG_FILE = "events.jsonl";

const roleKey = (showId, roleId) => `${showId}${roleId}`;
const cueKey = (showId, cueId) => `${showId}${cueId}`;

function success(result) {
  return { ok: true, result };
}

function failure(status, code, message, details) {
  return { ok: false, status, code, message, details };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}

// 事件溯源存储：每次变更先把事件追加到磁盘，再应用到内存状态。
// 进程重启后重放事件日志即可恢复未过期授权、待签交接与资源租约。
export class Store {
  constructor({ dataDir, now } = {}) {
    if (!dataDir) throw new Error("dataDir is required");
    this.dataDir = dataDir;
    this.now = now ?? (() => new Date());
    this.seq = 0;
    this.events = [];
    this.people = new Map();
    this.shows = new Map();
    this.roles = new Map();
    this.cues = new Map();
    this.safetyPoints = new Map();
    this.castChanges = new Map();
    this.authorizations = new Map();
    this.leases = new Map();
    this.receipts = new Map();
    this._load();
  }

  _load() {
    const file = path.join(this.dataDir, EVENT_LOG_FILE);
    if (!fs.existsSync(file)) return;
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      const event = JSON.parse(line);
      this.seq = Math.max(this.seq, event.seq);
      this._apply(event);
      this.events.push(event);
    }
  }

  _commit(events) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const at = this.now().toISOString();
    const stamped = events.map((event, index) => ({
      ...event,
      seq: this.seq + 1 + index,
      at,
    }));
    const file = path.join(this.dataDir, EVENT_LOG_FILE);
    fs.appendFileSync(file, stamped.map((event) => JSON.stringify(event)).join("\n") + "\n");
    for (const event of stamped) {
      this.seq = event.seq;
      this._apply(event);
      this.events.push(event);
    }
    return stamped;
  }

  _apply(event) {
    switch (event.type) {
      case "person_registered": {
        this.people.set(event.person.id, structuredClone(event.person));
        break;
      }
      case "show_created": {
        this.shows.set(event.show.id, {
          ...structuredClone(event.show),
          status: "scheduled",
          openedAt: null,
          openedSeq: null,
          closedAt: null,
        });
        break;
      }
      case "role_version_created": {
        const role = this._ensureRole(event.showId, event.roleId);
        role.versions.set(event.version.version, {
          ...structuredClone(event.version),
          status: "draft",
        });
        break;
      }
      case "role_version_released": {
        const role = this.roles.get(roleKey(event.showId, event.roleId));
        if (role.releasedVersion !== null) {
          role.versions.get(role.releasedVersion).status = "superseded";
        }
        role.releasedVersion = event.version;
        role.versions.get(event.version).status = "released";
        break;
      }
      case "cue_created": {
        this.cues.set(cueKey(event.showId, event.cue.id), structuredClone(event.cue));
        break;
      }
      case "safety_point_created": {
        this.safetyPoints.set(event.point.id, {
          ...structuredClone(event.point),
          createdSeq: event.seq,
        });
        break;
      }
      case "cast_change_requested": {
        const request = structuredClone(event.request);
        request.status = "open";
        request.signatures = [];
        this.castChanges.set(request.id, request);
        const role = this.roles.get(roleKey(request.showId, request.roleId));
        role.frozenBy = request.id;
        role.versions.get(role.releasedVersion).status = "frozen";
        for (const cueId of request.affectedCues) {
          const cue = this.cues.get(cueKey(request.showId, cueId));
          if (cue && !cue.frozenBy.includes(request.id)) cue.frozenBy.push(request.id);
        }
        break;
      }
      case "cast_change_cancelled": {
        const request = this.castChanges.get(event.castChangeId);
        request.status = "cancelled";
        this._unfreeze(request);
        break;
      }
      case "signature_added": {
        const request = this.castChanges.get(event.castChangeId);
        request.signatures.push({
          duty: event.duty,
          signerId: event.signerId,
          confirmedCueIds: event.confirmedCueIds ?? [],
          at: event.at,
        });
        break;
      }
      case "authorization_issued": {
        const authorization = structuredClone(event.authorization);
        authorization.status = "active";
        this.authorizations.set(authorization.id, authorization);
        const request = this.castChanges.get(authorization.castChangeId);
        request.status = "authorized";
        this._unfreeze(request);
        break;
      }
      case "authorization_revoked": {
        const prior = this.authorizations.get(event.authorizationId);
        if (prior) prior.status = "revoked";
        break;
      }
      case "lease_acquired": {
        this.leases.set(event.lease.id, {
          ...structuredClone(event.lease),
          status: "active",
        });
        break;
      }
      case "lease_released": {
        const lease = this.leases.get(event.leaseId);
        if (lease) lease.status = "released";
        break;
      }
      case "show_opened": {
        const show = this.shows.get(event.showId);
        show.status = "open";
        show.openedAt = event.openedAt;
        show.openedSeq = event.seq;
        break;
      }
      case "show_closed": {
        const show = this.shows.get(event.showId);
        show.status = "closed";
        show.closedAt = event.closedAt;
        break;
      }
      case "rehearsal_receipt_recorded": {
        if (!this.receipts.has(event.showId)) this.receipts.set(event.showId, []);
        this.receipts.get(event.showId).push(structuredClone(event.receipt));
        break;
      }
      // 纯审计事件不改动内存状态：cast_change_rejected、signature_rejected、
      // show_open_blocked、cue_executed、execution_blocked、cue_skipped。
      default:
        break;
    }
  }

  _ensureRole(showId, roleId) {
    const key = roleKey(showId, roleId);
    if (!this.roles.has(key)) {
      this.roles.set(key, { showId, roleId, versions: new Map(), releasedVersion: null, frozenBy: null });
    }
    return this.roles.get(key);
  }

  _unfreeze(request) {
    const role = this.roles.get(roleKey(request.showId, request.roleId));
    if (role && role.frozenBy === request.id) {
      role.frozenBy = null;
      role.versions.get(role.releasedVersion).status = "released";
    }
    for (const cueId of request.affectedCues) {
      const cue = this.cues.get(cueKey(request.showId, cueId));
      if (cue) cue.frozenBy = cue.frozenBy.filter((id) => id !== request.id);
    }
  }

  _showCues(showId) {
    return [...this.cues.values()].filter((cue) => cue.showId === showId);
  }

  _showRoles(showId) {
    return [...this.roles.values()].filter((role) => role.showId === showId);
  }

  _executedCueIds(showId) {
    return new Set(
      this.events
        .filter((event) => event.type === "cue_executed" && event.showId === showId)
        .map((event) => event.cueId),
    );
  }

  _activeLease(resourceId) {
    for (const lease of this.leases.values()) {
      if (
        lease.resourceId === resourceId &&
        lease.status === "active" &&
        Date.parse(lease.expiresAt) > this.now().getTime()
      ) {
        return lease;
      }
    }
    return null;
  }

  _activeAuthorization(showId, roleId) {
    let found = null;
    for (const authorization of this.authorizations.values()) {
      if (
        authorization.showId === showId &&
        authorization.roleId === roleId &&
        authorization.status === "active" &&
        Date.parse(authorization.validUntil) > this.now().getTime()
      ) {
        found = authorization;
      }
    }
    return found;
  }

  _effectivePerson(showId, roleId) {
    const authorization = this._activeAuthorization(showId, roleId);
    if (authorization) return authorization.personId;
    const role = this.roles.get(roleKey(showId, roleId));
    if (!role || role.releasedVersion === null) return null;
    return role.versions.get(role.releasedVersion).actorId;
  }

  _rehearsalPasses(showId, roleId, personId, version) {
    const passes = new Set(version.rehearsalPasses?.[personId] ?? []);
    for (const receipt of this.receipts.get(showId) ?? []) {
      if (receipt.roleId === roleId && receipt.personId === personId) passes.add(receipt.segmentId);
    }
    return passes;
  }

  // ---------- 人员与场次 ----------

  registerPerson(personId, staffRoles) {
    if (!isNonEmptyString(personId)) {
      return failure(400, "invalid_request", "人员 id 必须是非空字符串");
    }
    if (!Array.isArray(staffRoles) || staffRoles.length === 0 || !staffRoles.every(staffRoleValid)) {
      return failure(400, "invalid_request", "staffRoles 必须全部是合法岗位", {
        allowed: ["actor", "understudy", "supervisor", ...DEPARTMENTS.map((d) => `crew:${d}`)],
      });
    }
    const person = { id: personId, staffRoles: [...new Set(staffRoles)] };
    this._commit([{ type: "person_registered", person }]);
    return success({ person });
  }

  getPerson(personId) {
    const person = this.people.get(personId);
    if (!person) return failure(404, "person_not_found", "人员不存在");
    return success({ person });
  }

  createShow(body) {
    const startsAt = parseInstant(body?.startsAt);
    const endsAt = parseInstant(body?.endsAt);
    if (!startsAt || !endsAt) {
      return failure(400, "invalid_request", "startsAt/endsAt 必须是带时区的 RFC 3339 时间");
    }
    if (startsAt >= endsAt) {
      return failure(400, "invalid_request", "startsAt 必须早于 endsAt");
    }
    if (body?.name !== undefined && typeof body.name !== "string") {
      return failure(400, "invalid_request", "name 必须是字符串");
    }
    const id = body?.id ?? newId("show");
    if (!isNonEmptyString(id)) return failure(400, "invalid_request", "id 必须是非空字符串");
    if (this.shows.has(id)) return failure(409, "show_exists", "场次 id 已存在");
    const show = { id, name: body?.name ?? null, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
    this._commit([{ type: "show_created", showId: id, show }]);
    return success({ show: this.shows.get(id) });
  }

  // ---------- 角色版本 ----------

  createRoleVersion(showId, roleId, body) {
    const show = this.shows.get(showId);
    if (!show) return failure(404, "show_not_found", "场次不存在");
    if (show.status === "closed") return failure(409, "show_closed", "场次已散场");
    if (!isNonEmptyString(roleId)) return failure(400, "invalid_request", "roleId 必须是非空字符串");
    if (!isNonEmptyString(body?.actorId) || !this.people.has(body.actorId)) {
      return failure(400, "invalid_request", "actorId 必须是已登记人员");
    }
    if (!isStringArray(body?.understudies)) {
      return failure(400, "invalid_request", "understudies 必须是非空字符串数组（替演顺位）");
    }
    const understudies = [...new Set(body.understudies)];
    for (const id of understudies) {
      if (!this.people.has(id)) return failure(400, "invalid_request", `替演 ${id} 未登记`);
      if (id === body.actorId) return failure(400, "invalid_request", "主演不能同时出现在替演顺位中");
    }
    const rehearsalPasses = body?.rehearsalPasses ?? {};
    if (typeof rehearsalPasses !== "object" || rehearsalPasses === null || Array.isArray(rehearsalPasses)) {
      return failure(400, "invalid_request", "rehearsalPasses 必须是 {人员id: [片段id]} 映射");
    }
    for (const [personId, segments] of Object.entries(rehearsalPasses)) {
      if (!this.people.has(personId)) return failure(400, "invalid_request", `排练记录人员 ${personId} 未登记`);
      if (!isStringArray(segments) && !(Array.isArray(segments) && segments.length === 0)) {
        return failure(400, "invalid_request", "rehearsalPasses 的值必须是字符串数组");
      }
    }
    const restrictions = body?.restrictions ?? [];
    if (!Array.isArray(restrictions)) {
      return failure(400, "invalid_request", "restrictions 必须是数组");
    }
    for (const restriction of restrictions) {
      if (!isNonEmptyString(restriction?.personId) || !this.people.has(restriction.personId)) {
        return failure(400, "invalid_request", "动作限制的 personId 必须是已登记人员");
      }
      const deniedCueTypes = restriction.deniedCueTypes ?? [];
      const deniedCueIds = restriction.deniedCueIds ?? [];
      if (!isStringArray(deniedCueTypes) && deniedCueTypes.length !== 0) {
        return failure(400, "invalid_request", "deniedCueTypes 必须是字符串数组");
      }
      if (!deniedCueTypes.every((type) => CUE_TYPES.includes(type))) {
        return failure(400, "invalid_request", "deniedCueTypes 含未知口令类型", { allowed: CUE_TYPES });
      }
      if (!isStringArray(deniedCueIds) && deniedCueIds.length !== 0) {
        return failure(400, "invalid_request", "deniedCueIds 必须是字符串数组");
      }
    }
    const validFrom = parseInstant(body?.validFrom);
    const validUntil = parseInstant(body?.validUntil);
    if (!validFrom || !validUntil) {
      return failure(400, "invalid_request", "validFrom/validUntil 必须是带时区的 RFC 3339 时间");
    }
    if (validFrom >= validUntil) {
      return failure(400, "invalid_request", "validFrom 必须早于 validUntil");
    }
    const role = this._ensureRole(showId, roleId);
    const version = {
      version: role.versions.size + 1,
      actorId: body.actorId,
      understudies,
      rehearsalPasses,
      restrictions: restrictions.map((restriction) => ({
        personId: restriction.personId,
        deniedCueTypes: restriction.deniedCueTypes ?? [],
        deniedCueIds: restriction.deniedCueIds ?? [],
        note: typeof restriction.note === "string" ? restriction.note : null,
      })),
      validFrom: validFrom.toISOString(),
      validUntil: validUntil.toISOString(),
    };
    this._commit([{ type: "role_version_created", showId, roleId, version }]);
    return success({ roleId, version: this.roles.get(roleKey(showId, roleId)).versions.get(version.version) });
  }

  releaseRoleVersion(showId, roleId, versionNumber) {
    const show = this.shows.get(showId);
    if (!show) return failure(404, "show_not_found", "场次不存在");
    if (show.status === "closed") return failure(409, "show_closed", "场次已散场");
    const role = this.roles.get(roleKey(showId, roleId));
    const version = role?.versions.get(versionNumber);
    if (!version) return failure(404, "version_not_found", "角色版本不存在");
    if (role.frozenBy) {
      return failure(409, "role_frozen", "角色放行版已冻结，需先处理进行中的换角申请", {
        castChangeId: role.frozenBy,
      });
    }
    this._commit([{ type: "role_version_released", showId, roleId, version: versionNumber }]);
    return success({ roleId, releasedVersion: versionNumber });
  }

  // ---------- 口令与安全点 ----------

  createCue(showId, body) {
    const show = this.shows.get(showId);
    if (!show) return failure(404, "show_not_found", "场次不存在");
    if (show.status !== "scheduled") {
      return failure(409, "show_already_open", "开演后不能再改动口令包");
    }
    if (!CUE_TYPES.includes(body?.type)) {
      return failure(400, "invalid_request", "未知口令类型", { allowed: CUE_TYPES });
    }
    const departments = body?.departments ?? [];
    if (!Array.isArray(departments) || !departments.every((d) => DEPARTMENTS.includes(d))) {
      return failure(400, "invalid_request", "departments 含未知执行口", { allowed: DEPARTMENTS });
    }
    const roleIds = body?.roleIds ?? [];
    if (!Array.isArray(roleIds)) return failure(400, "invalid_request", "roleIds 必须是数组");
    for (const roleId of roleIds) {
      if (!this.roles.has(roleKey(showId, roleId))) {
        return failure(400, "invalid_request", `角色 ${roleId} 不存在`);
      }
    }
    const dependsOn = body?.dependsOn ?? [];
    if (!Array.isArray(dependsOn)) return failure(400, "invalid_request", "dependsOn 必须是数组");
    const id = body?.id ?? newId("cue");
    if (!isNonEmptyString(id)) return failure(400, "invalid_request", "id 必须是非空字符串");
    if (this.cues.has(cueKey(showId, id))) return failure(409, "cue_exists", "口令 id 已存在");
    for (const dependency of dependsOn) {
      if (dependency === id) return failure(400, "invalid_request", "口令不能依赖自身");
      if (!this.cues.has(cueKey(showId, dependency))) {
        return failure(400, "invalid_request", `依赖的口令 ${dependency} 不存在`);
      }
    }
    const requiredSegments = body?.requiredSegments ?? [];
    const highRiskEquipment = body?.highRiskEquipment ?? [];
    if (!isStringArray(requiredSegments) && requiredSegments.length !== 0) {
      return failure(400, "invalid_request", "requiredSegments 必须是字符串数组");
    }
    if (!isStringArray(highRiskEquipment) && highRiskEquipment.length !== 0) {
      return failure(400, "invalid_request", "highRiskEquipment 必须是字符串数组");
    }
    const risk = body?.risk ?? (HIGH_RISK_CUE_TYPES.has(body.type) ? "high" : "normal");
    if (!["high", "normal"].includes(risk)) {
      return failure(400, "invalid_request", "risk 必须是 high 或 normal");
    }
    const cue = {
      id,
      showId,
      type: body.type,
      departments: [...new Set(departments)],
      roleIds: [...new Set(roleIds)],
      dependsOn: [...new Set(dependsOn)],
      requiredSegments,
      highRiskEquipment: [...new Set(highRiskEquipment)],
      risk,
      frozenBy: [],
    };
    this._commit([{ type: "cue_created", showId, cue }]);
    return success({ cue });
  }

  createSafetyPoint(showId, body) {
    const show = this.shows.get(showId);
    if (!show) return failure(404, "show_not_found", "场次不存在");
    if (show.status !== "scheduled") {
      return failure(409, "show_already_open", "安全点必须在开演前预先验证，开演后不能新增");
    }
    if (!isNonEmptyString(body?.afterCueId) || !this.cues.has(cueKey(showId, body.afterCueId))) {
      return failure(400, "invalid_request", "afterCueId 必须是本场已存在的口令");
    }
    const validator = this.people.get(body?.validatedBy);
    if (!validator || !validator.staffRoles.includes("supervisor")) {
      return failure(400, "invalid_request", "安全点必须由具备监督职责的人预先验证");
    }
    const point = {
      id: newId("sp"),
      showId,
      afterCueId: body.afterCueId,
      validatedBy: body.validatedBy,
      validatedAt: this.now().toISOString(),
    };
    this._commit([{ type: "safety_point_created", showId, point }]);
    return success({ point });
  }

  // ---------- 临时换角 ----------

  requestCastChange(showId, body) {
    const show = this.shows.get(showId);
    if (!show) return failure(404, "show_not_found", "场次不存在");
    const { roleId, fromPersonId, toPersonId, requestedBy, safetyPointId } = body ?? {};
    for (const [field, value] of Object.entries({ roleId, fromPersonId, toPersonId, requestedBy })) {
      if (!isNonEmptyString(value)) {
        return failure(400, "invalid_request", `${field} 必须是非空字符串`);
      }
    }
    if (body?.reason !== undefined && typeof body.reason !== "string") {
      return failure(400, "invalid_request", "reason 必须是字符串");
    }
    for (const personId of [fromPersonId, toPersonId, requestedBy]) {
      if (!this.people.has(personId)) {
        return failure(400, "invalid_request", `人员 ${personId} 未登记`);
      }
    }
    const reject = (reason, details) => {
      this._commit([{
        type: "cast_change_rejected",
        showId,
        roleId,
        fromPersonId,
        toPersonId,
        requestedBy,
        reason,
        details: details ?? null,
      }]);
      return failure(409, reason, REJECT_MESSAGES[reason] ?? "换角申请被拒绝", details);
    };

    if (show.status === "closed") return reject("show_closed");
    const role = this.roles.get(roleKey(showId, roleId));
    if (!role || role.releasedVersion === null) return reject("no_released_version");
    if (role.frozenBy) return reject("cast_change_pending", { castChangeId: role.frozenBy });
    const version = role.versions.get(role.releasedVersion);
    const nowMs = this.now().getTime();
    if (Date.parse(version.validFrom) > nowMs || Date.parse(version.validUntil) <= nowMs) {
      return reject("version_expired", { validFrom: version.validFrom, validUntil: version.validUntil });
    }
    const effective = this._effectivePerson(showId, roleId);
    if (fromPersonId !== effective) {
      return reject("from_person_mismatch", { effectivePersonId: effective });
    }
    if (toPersonId === effective) return reject("no_op_change");
    if (!version.understudies.includes(toPersonId)) {
      return reject("not_in_understudy_order", { understudies: version.understudies });
    }

    let safetyPoint = null;
    if (show.status === "open") {
      // 开演后人员再次变化只能从预先验证的安全点切换。
      if (!isNonEmptyString(safetyPointId)) return reject("safety_point_required");
      safetyPoint = this.safetyPoints.get(safetyPointId);
      if (!safetyPoint || safetyPoint.showId !== showId) return reject("safety_point_invalid");
      // 安全点必须在开演事件之前完成预先验证（按事件真实顺序判定）。
      if (safetyPoint.createdSeq >= show.openedSeq) {
        return reject("safety_point_not_prevalidated");
      }
      if (this._executedCueIds(showId).has(safetyPoint.afterCueId)) {
        return reject("safety_point_passed", { afterCueId: safetyPoint.afterCueId });
      }
    }

    const affected = computeAffectedCues(this._showCues(showId), roleId);
    const directCues = affected.cueIds.filter((cueId) =>
      this.cues.get(cueKey(showId, cueId)).roleIds.includes(roleId),
    );

    // 替演必须通过直接参与口令所需的全部排练片段。
    const passes = this._rehearsalPasses(showId, roleId, toPersonId, version);
    const gaps = [];
    for (const cueId of directCues) {
      const cue = this.cues.get(cueKey(showId, cueId));
      const missing = cue.requiredSegments.filter((segment) => !passes.has(segment));
      if (missing.length > 0) gaps.push({ cueId, missingSegments: missing });
    }
    if (gaps.length > 0) return reject("missing_rehearsal", { gaps });

    // 动作限制不得与直接参与的口令冲突。
    const restrictions = version.restrictions.filter((r) => r.personId === toPersonId);
    const conflicts = [];
    for (const cueId of directCues) {
      const cue = this.cues.get(cueKey(showId, cueId));
      for (const restriction of restrictions) {
        if (restriction.deniedCueTypes.includes(cue.type) || restriction.deniedCueIds.includes(cue.id)) {
          conflicts.push({ cueId, cueType: cue.type, note: restriction.note });
        }
      }
    }
    if (conflicts.length > 0) return reject("restriction_conflict", { conflicts });

    // 替演人员租约：两个场次同时借用同一替演时给出唯一结果。
    const resourceId = `person:${toPersonId}`;
    const held = this._activeLease(resourceId);
    if (held) {
      return reject("lease_conflict", { resourceId, heldByShow: held.showId });
    }

    const castChangeId = newId("cc");
    const requiredSignatures = [
      "understudy",
      ...affected.departments.map((department) => `crew:${department}`),
      "supervisor",
    ];
    const request = {
      id: castChangeId,
      showId,
      roleId,
      fromPersonId,
      toPersonId,
      reason: body?.reason ?? null,
      requestedBy,
      safetyPointId: safetyPoint?.id ?? null,
      affectedCues: affected.cueIds,
      directCues,
      requiredSignatures,
      createdAt: this.now().toISOString(),
    };
    this._commit([
      {
        type: "lease_acquired",
        showId,
        lease: {
          id: newId("lease"),
          resourceId,
          kind: "person",
          showId,
          castChangeId,
          acquiredAt: this.now().toISOString(),
          expiresAt: show.endsAt,
        },
      },
      { type: "cast_change_requested", showId, request },
    ]);
    return success({ request: this.castChanges.get(castChangeId) });
  }

  getCastChange(showId, castChangeId) {
    const request = this.castChanges.get(castChangeId);
    if (!request || request.showId !== showId) {
      return failure(404, "cast_change_not_found", "换角申请不存在");
    }
    return success({ request });
  }

  listCastChanges(showId) {
    if (!this.shows.has(showId)) return failure(404, "show_not_found", "场次不存在");
    const requests = [...this.castChanges.values()].filter((request) => request.showId === showId);
    return success({ requests });
  }

  signCastChange(showId, castChangeId, body) {
    const request = this.castChanges.get(castChangeId);
    if (!request || request.showId !== showId) {
      return failure(404, "cast_change_not_found", "换角申请不存在");
    }
    if (request.status !== "open") {
      return failure(409, "cast_change_not_open", "换角申请不在待签状态", { status: request.status });
    }
    const { duty, signerId } = body ?? {};
    if (!isNonEmptyString(duty) || !isNonEmptyString(signerId)) {
      return failure(400, "invalid_request", "duty 与 signerId 必须是非空字符串");
    }
    const eligibility = signatureEligibility({ request, duty, signerId, people: this.people });
    if (!eligibility.ok) {
      this._commit([{ type: "signature_rejected", showId, castChangeId, duty, signerId, reason: eligibility.reason }]);
      return failure(403, eligibility.reason, "签署人不具备该职责资格或涉及自我复核", {
        reason: eligibility.reason,
      });
    }
    let confirmedCueIds = [];
    if (duty.startsWith("crew:")) {
      const department = duty.slice("crew:".length);
      if (!Array.isArray(body?.confirmedCueIds)) {
        return failure(400, "invalid_request", "执行组签署必须携带 confirmedCueIds 重确认口令清单");
      }
      const expected = request.affectedCues.filter((cueId) =>
        this.cues.get(cueKey(showId, cueId)).departments.includes(department),
      );
      const unknown = body.confirmedCueIds.filter((cueId) => !request.affectedCues.includes(cueId));
      if (unknown.length > 0) {
        return failure(400, "invalid_request", "confirmedCueIds 含不在影响范围内的口令", { unknown });
      }
      const missing = expected.filter((cueId) => !body.confirmedCueIds.includes(cueId));
      if (missing.length > 0) {
        return failure(400, "incomplete_confirmation", "该执行口受影响口令未全部重确认", { missing });
      }
      confirmedCueIds = [...new Set(body.confirmedCueIds)];
    }
    const events = [{ type: "signature_added", showId, castChangeId, duty, signerId, confirmedCueIds }];
    const signedDuties = new Set([...request.signatures.map((s) => s.duty), duty]);
    let authorization = null;
    if (request.requiredSignatures.every((required) => signedDuties.has(required))) {
      const prior = this._activeAuthorization(showId, request.roleId);
      if (prior) {
        events.push({ type: "authorization_revoked", showId, authorizationId: prior.id, supersededBy: castChangeId });
      }
      const role = this.roles.get(roleKey(showId, request.roleId));
      const version = role.versions.get(role.releasedVersion);
      const show = this.shows.get(showId);
      authorization = {
        id: newId("auth"),
        showId,
        castChangeId,
        roleId: request.roleId,
        personId: request.toPersonId,
        affectedCues: request.affectedCues,
        safetyPointId: request.safetyPointId,
        issuedAt: this.now().toISOString(),
        validUntil: new Date(
          Math.min(Date.parse(version.validUntil), Date.parse(show.endsAt)),
        ).toISOString(),
      };
      events.push({ type: "authorization_issued", showId, authorization });
    }
    this._commit(events);
    return success({
      request: this.castChanges.get(castChangeId),
      authorization: authorization ? this.authorizations.get(authorization.id) : null,
    });
  }

  cancelCastChange(showId, castChangeId, body) {
    const request = this.castChanges.get(castChangeId);
    if (!request || request.showId !== showId) {
      return failure(404, "cast_change_not_found", "换角申请不存在");
    }
    if (request.status !== "open") {
      return failure(409, "cast_change_not_open", "换角申请不在待签状态", { status: request.status });
    }
    const cancelledBy = isNonEmptyString(body?.cancelledBy) ? body.cancelledBy : null;
    const lease = [...this.leases.values()].find(
      (candidate) => candidate.castChangeId === castChangeId && candidate.status === "active",
    );
    const events = [{ type: "cast_change_cancelled", showId, castChangeId, cancelledBy }];
    if (lease) {
      events.push({
        type: "lease_released",
        showId,
        leaseId: lease.id,
        resourceId: lease.resourceId,
        reason: "cast_change_cancelled",
      });
    }
    this._commit(events);
    return success({ request: this.castChanges.get(castChangeId) });
  }

  // ---------- 开演 / 散场 ----------

  _openIssues(show) {
    const issues = [];
    for (const role of this._showRoles(show.id)) {
      if (role.releasedVersion === null) {
        issues.push({ code: "missing_released_version", roleId: role.roleId });
        continue;
      }
      const version = role.versions.get(role.releasedVersion);
      const nowMs = this.now().getTime();
      if (Date.parse(version.validFrom) > nowMs || Date.parse(version.validUntil) <= nowMs) {
        issues.push({ code: "version_expired", roleId: role.roleId });
      }
      if (role.frozenBy) {
        issues.push({ code: "cast_change_pending", roleId: role.roleId, castChangeId: role.frozenBy });
      }
    }
    for (const cue of this._showCues(show.id)) {
      for (const equipment of cue.highRiskEquipment) {
        const resourceId = `equipment:${equipment}`;
        const held = this._activeLease(resourceId);
        if (held && held.showId !== show.id) {
          issues.push({ code: "equipment_lease_conflict", resourceId, heldByShow: held.showId });
        }
      }
    }
    return issues;
  }

  getReadiness(showId) {
    const show = this.shows.get(showId);
    if (!show) return failure(404, "show_not_found", "场次不存在");
    const issues = this._openIssues(show);
    return success({ showId, status: show.status, ready: issues.length === 0, issues });
  }

  openShow(showId) {
    const show = this.shows.get(showId);
    if (!show) return failure(404, "show_not_found", "场次不存在");
    if (show.status !== "scheduled") {
      return failure(409, "invalid_state", "场次不在待开演状态", { status: show.status });
    }
    const issues = this._openIssues(show);
    if (issues.length > 0) {
      this._commit([{ type: "show_open_blocked", showId, issues }]);
      return failure(409, "show_not_ready", "存在阻断开演的问题", { issues });
    }
    const equipmentResources = [
      ...new Set(this._showCues(showId).flatMap((cue) => cue.highRiskEquipment)),
    ];
    const openedAt = this.now().toISOString();
    this._commit([
      { type: "show_opened", showId, openedAt },
      ...equipmentResources.map((equipment) => ({
        type: "lease_acquired",
        showId,
        lease: {
          id: newId("lease"),
          resourceId: `equipment:${equipment}`,
          kind: "equipment",
          showId,
          castChangeId: null,
          acquiredAt: openedAt,
          expiresAt: show.endsAt,
        },
      })),
    ]);
    return success({ show: this.shows.get(showId) });
  }

  closeShow(showId) {
    const show = this.shows.get(showId);
    if (!show) return failure(404, "show_not_found", "场次不存在");
    if (show.status !== "open") {
      return failure(409, "invalid_state", "只有开演中的场次可以散场", { status: show.status });
    }
    const closedAt = this.now().toISOString();
    const releases = [...this.leases.values()]
      .filter((lease) => lease.showId === showId && lease.status === "active")
      .map((lease) => ({
        type: "lease_released",
        showId,
        leaseId: lease.id,
        resourceId: lease.resourceId,
        reason: "show_closed",
      }));
    this._commit([{ type: "show_closed", showId, closedAt }, ...releases]);
    return success({ show: this.shows.get(showId) });
  }

  // ---------- 执行 / 跳过 / 排练回执 ----------

  executeCue(showId, body) {
    const show = this.shows.get(showId);
    if (!show) return failure(404, "show_not_found", "场次不存在");
    const { cueId, executedBy } = body ?? {};
    if (!isNonEmptyString(cueId)) return failure(400, "invalid_request", "cueId 必须是非空字符串");
    const cue = this.cues.get(cueKey(showId, cueId));
    if (!cue) return failure(404, "cue_not_found", "口令不存在");
    if (!isNonEmptyString(executedBy) || !this.people.has(executedBy)) {
      return failure(400, "invalid_request", "executedBy 必须是已登记人员");
    }
    const block = (reason, details) => {
      this._commit([{ type: "execution_blocked", showId, cueId, executedBy, reason, details: details ?? null }]);
      return failure(409, reason, BLOCK_MESSAGES[reason] ?? "口令执行被阻断", details);
    };
    if (show.status !== "open") return block("show_not_open", { status: show.status });
    if (cue.frozenBy.length > 0) return block("cue_frozen", { castChangeIds: cue.frozenBy });

    let basis = { type: "no_role" };
    if (cue.roleIds.length > 0) {
      const matchedRoleId = cue.roleIds.find((roleId) => this._effectivePerson(showId, roleId) === executedBy);
      if (!matchedRoleId) {
        return block("executor_not_authorized", {
          effective: cue.roleIds.map((roleId) => ({ roleId, personId: this._effectivePerson(showId, roleId) })),
        });
      }
      const role = this.roles.get(roleKey(showId, matchedRoleId));
      const version = role.versions.get(role.releasedVersion);
      const restriction = version.restrictions.find(
        (r) =>
          r.personId === executedBy &&
          (r.deniedCueTypes.includes(cue.type) || r.deniedCueIds.includes(cue.id)),
      );
      if (restriction) return block("restriction", { note: restriction.note });
      const authorization = this._activeAuthorization(showId, matchedRoleId);
      basis =
        authorization && authorization.personId === executedBy
          ? { type: "authorization", authorizationId: authorization.id, roleId: matchedRoleId }
          : { type: "released_version", roleId: matchedRoleId, version: role.releasedVersion };
    }
    const events = this._commit([{ type: "cue_executed", showId, cueId, executedBy, basis }]);
    return success({ execution: events[0] });
  }

  skipCue(showId, body) {
    const show = this.shows.get(showId);
    if (!show) return failure(404, "show_not_found", "场次不存在");
    const { cueId, skippedBy, reason } = body ?? {};
    if (!isNonEmptyString(cueId) || !this.cues.has(cueKey(showId, cueId))) {
      return failure(404, "cue_not_found", "口令不存在");
    }
    if (show.status !== "open") {
      return failure(409, "show_not_open", "只有开演中的场次可以紧急跳过", { status: show.status });
    }
    if (!isNonEmptyString(skippedBy) || !this.people.has(skippedBy)) {
      return failure(400, "invalid_request", "skippedBy 必须是已登记人员（责任人）");
    }
    if (!isNonEmptyString(reason)) {
      return failure(400, "invalid_request", "紧急人工跳过必须填写原因");
    }
    const events = this._commit([{ type: "cue_skipped", showId, cueId, skippedBy, reason }]);
    return success({ skip: events[0] });
  }

  recordRehearsalReceipt(showId, body) {
    const show = this.shows.get(showId);
    if (!show) return failure(404, "show_not_found", "场次不存在");
    const { personId, roleId, segmentId } = body ?? {};
    if (!isNonEmptyString(personId) || !this.people.has(personId)) {
      return failure(400, "invalid_request", "personId 必须是已登记人员");
    }
    if (!isNonEmptyString(roleId) || !this.roles.has(roleKey(showId, roleId))) {
      return failure(404, "role_not_found", "角色不存在");
    }
    if (!isNonEmptyString(segmentId)) {
      return failure(400, "invalid_request", "segmentId 必须是非空字符串");
    }
    const passedAt = parseInstant(body?.passedAt);
    if (!passedAt) {
      return failure(400, "invalid_request", "passedAt 必须是带时区的 RFC 3339 时间");
    }
    // 迟到回执只登记、不改写任何已执行动作（执行记录为只追加事件）。
    const afterExecution = this._showCues(showId).some(
      (cue) => cue.requiredSegments.includes(segmentId) && this._executedCueIds(showId).has(cue.id),
    );
    const late = show.status !== "scheduled" || afterExecution;
    const receipt = {
      personId,
      roleId,
      segmentId,
      passedAt: passedAt.toISOString(),
      late,
      afterExecution,
    };
    this._commit([{ type: "rehearsal_receipt_recorded", showId, receipt }]);
    return success({ receipt });
  }

  // ---------- 查询 ----------

  getShow(showId) {
    const show = this.shows.get(showId);
    if (!show) return failure(404, "show_not_found", "场次不存在");
    return success({
      show: {
        ...show,
        roles: this._showRoles(showId).map((role) => ({
          roleId: role.roleId,
          releasedVersion: role.releasedVersion,
          frozenBy: role.frozenBy,
          effectivePersonId: this._effectivePerson(showId, role.roleId),
          versions: [...role.versions.values()],
        })),
        cues: this._showCues(showId),
        safetyPoints: [...this.safetyPoints.values()].filter((point) => point.showId === showId),
        openCastChanges: [...this.castChanges.values()]
          .filter((request) => request.showId === showId && request.status === "open")
          .map((request) => request.id),
      },
    });
  }

  listAuthorizations(showId) {
    if (!this.shows.has(showId)) return failure(404, "show_not_found", "场次不存在");
    const nowMs = this.now().getTime();
    const authorizations = [...this.authorizations.values()]
      .filter((authorization) => authorization.showId === showId)
      .map((authorization) => ({
        ...authorization,
        status:
          authorization.status === "active" && Date.parse(authorization.validUntil) <= nowMs
            ? "expired"
            : authorization.status,
      }));
    return success({ authorizations });
  }

  listLeases() {
    const nowMs = this.now().getTime();
    const leases = [...this.leases.values()].map((lease) => ({
      ...lease,
      status:
        lease.status === "active" && Date.parse(lease.expiresAt) <= nowMs ? "expired" : lease.status,
    }));
    return success({ leases });
  }

  getReview(showId) {
    const show = this.shows.get(showId);
    if (!show) return failure(404, "show_not_found", "场次不存在");
    const timeline = this.events
      .filter((event) => event.showId === showId)
      .map((event) => ({ ...event, category: categorize(event) }));
    const summary = {
      personnelChanges: timeline
        .filter((event) => event.type === "cast_change_requested")
        .map((event) => {
          const request = this.castChanges.get(event.request.id);
          const authorization = [...this.authorizations.values()].find(
            (candidate) => candidate.castChangeId === event.request.id,
          );
          return {
            castChangeId: event.request.id,
            roleId: event.request.roleId,
            fromPersonId: event.request.fromPersonId,
            toPersonId: event.request.toPersonId,
            safetyPointId: event.request.safetyPointId,
            status: request?.status ?? "unknown",
            authorizationId: authorization?.id ?? null,
            at: event.at,
          };
        }),
      reconfirmedCues: timeline
        .filter((event) => event.type === "signature_added" && event.duty.startsWith("crew:"))
        .map((event) => ({
          castChangeId: event.castChangeId,
          department: event.duty.slice("crew:".length),
          cueIds: event.confirmedCueIds,
          confirmedBy: event.signerId,
          at: event.at,
        })),
      blockedActions: timeline
        .filter((event) =>
          ["execution_blocked", "show_open_blocked", "cast_change_rejected", "signature_rejected"].includes(event.type),
        )
        .map((event) => ({
          type: event.type,
          reason: event.reason ?? event.issues,
          cueId: event.cueId ?? null,
          at: event.at,
        })),
      executions: timeline
        .filter((event) => event.type === "cue_executed")
        .map((event) => ({
          cueId: event.cueId,
          executedBy: event.executedBy,
          basis: event.basis,
          at: event.at,
        })),
      skips: timeline
        .filter((event) => event.type === "cue_skipped")
        .map((event) => ({
          cueId: event.cueId,
          skippedBy: event.skippedBy,
          reason: event.reason,
          at: event.at,
        })),
    };
    return success({ showId, status: show.status, timeline, summary });
  }
}

const REJECT_MESSAGES = {
  show_closed: "场次已散场",
  no_released_version: "角色没有放行版",
  cast_change_pending: "角色已有进行中的换角申请",
  version_expired: "放行版不在有效期内",
  from_person_mismatch: "fromPersonId 与当前实际出演人员不一致",
  no_op_change: "接任人员与当前出演人员相同",
  not_in_understudy_order: "接任人员不在替演顺位中",
  safety_point_required: "开演后人员变化必须指定预先验证的安全点",
  safety_point_invalid: "安全点不存在或不属于本场次",
  safety_point_not_prevalidated: "安全点不是在开演前预先验证的",
  safety_point_passed: "安全点锚定口令已执行，无法再从该点切换",
  missing_rehearsal: "替演缺少必需排练片段的通过记录",
  restriction_conflict: "替演动作限制与受影响口令冲突",
  lease_conflict: "该替演已被其他场次租用",
};

const BLOCK_MESSAGES = {
  show_not_open: "场次未开演",
  cue_frozen: "口令已被换角申请冻结",
  executor_not_authorized: "执行人不是该口令角色的当前授权人员",
  restriction: "执行人动作限制禁止该口令",
};

function categorize(event) {
  switch (event.type) {
    case "cast_change_requested":
    case "cast_change_cancelled":
    case "authorization_issued":
    case "authorization_revoked":
      return "personnel";
    case "signature_added":
      return event.duty.startsWith("crew:") ? "reconfirmation" : "personnel";
    case "cast_change_rejected":
    case "signature_rejected":
    case "execution_blocked":
    case "show_open_blocked":
      return "blocked";
    case "cue_executed":
      return "execution";
    case "cue_skipped":
      return "skip";
    case "lease_acquired":
    case "lease_released":
      return "lease";
    case "show_opened":
    case "show_closed":
      return "lifecycle";
    case "rehearsal_receipt_recorded":
      return "qualification";
    default:
      return "setup";
  }
}
