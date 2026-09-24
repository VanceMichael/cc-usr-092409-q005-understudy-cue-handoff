import fs from "node:fs";
import path from "node:path";

const SNAPSHOT_EVERY = 20;

/**
 * 事件溯源存储：所有状态变更先落追加日志（events.jsonl，崩溃不丢），
 * 定期写快照（snapshot.json，tmp+rename 原子替换）。重启时先载快照再
 * 重放其后的事件，未过期授权、待签交接与资源租约随之恢复。
 *
 * 事件 seq 严格等于其在日志中的行号（从 1 起），idSeq 仅用于生成 ID，
 * 两者分离，保证快照后的 slice 重放永远对齐。
 */
export class Store {
  #dir;
  #now;
  #state;

  constructor({ dir = null, now = () => new Date().toISOString() } = {}) {
    this.#dir = dir;
    this.#now = now;
    this.#state = freshState();
    if (dir) this.#load();
  }

  get state() {
    return this.#state;
  }

  now() {
    return this.#now();
  }

  nextId(prefix) {
    this.#state.idSeq += 1;
    return `${prefix}_${this.#state.idSeq}`;
  }

  mutate(type, payload) {
    const event = {
      seq: this.#state.events.length + 1,
      idSeq: this.#state.idSeq,
      type,
      at: this.#now(),
      payload,
    };
    this.#state.events.push(event);
    if (this.#dir) appendEvent(this.#dir, event);
    applyEvent(this.#state, event);
    if (this.#dir && event.seq % SNAPSHOT_EVERY === 0) this.#saveSnapshot();
    return event;
  }

  #load() {
    fs.mkdirSync(this.#dir, { recursive: true });
    const eventsPath = path.join(this.#dir, "events.jsonl");
    const snapshotPath = path.join(this.#dir, "snapshot.json");
    const events = fs.existsSync(eventsPath)
      ? fs
          .readFileSync(eventsPath, "utf8")
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line))
      : [];
    const snapshot = fs.existsSync(snapshotPath)
      ? JSON.parse(fs.readFileSync(snapshotPath, "utf8"))
      : null;

    if (snapshot && snapshot.eventCount <= events.length) {
      this.#state = { ...snapshot.state, events: [] };
      for (const event of events.slice(snapshot.eventCount)) applyEvent(this.#state, event);
    } else {
      this.#state = freshState();
      for (const event of events) applyEvent(this.#state, event);
    }
    // idSeq 的自增只体现在事件戳记里（不产生独立事件），重放后据此恢复。
    this.#state.idSeq = Math.max(
      this.#state.idSeq,
      ...events.map((event) => event.idSeq ?? 0),
    );
    this.#state.events = events;
  }

  #saveSnapshot() {
    const { events, ...persisted } = this.#state;
    const tmp = path.join(this.#dir, "snapshot.json.tmp");
    fs.writeFileSync(
      tmp,
      JSON.stringify({ eventCount: events.length, state: persisted }),
    );
    fs.renameSync(tmp, path.join(this.#dir, "snapshot.json"));
  }
}

function appendEvent(dir, event) {
  fs.appendFileSync(path.join(dir, "events.jsonl"), JSON.stringify(event) + "\n");
}

export function freshState() {
  return {
    idSeq: 0,
    events: [],
    shows: {},
    people: {},
    cuePackages: {},
    roleVersions: {},
    rehearsalReceipts: {},
    performances: {},
    requests: {},
    reconfirmations: {},
    authorizations: {},
    leases: {},
    safetyPoints: {},
    bypasses: {},
    executions: [],
  };
}

// 由 domain.js 注入 reducer，避免 store 依赖领域规则。
let applyEvent = () => {
  throw new Error("applyEvent 未注册");
};

export function registerReducer(reducer) {
  applyEvent = reducer;
}
