import { validateEvent } from "./validator.js";

/** 事件存储：追加前校验信封，并按聚合强制 version 连续递增。 */
export class EventStore {
  #events = [];
  #versions = new Map();
  #byEventId = new Set();

  append(event) {
    const errors = validateEvent(event);
    if (errors.length > 0) {
      const failure = new Error(`事件校验失败：${errors.join("；")}`);
      failure.errors = errors;
      throw failure;
    }
    const key = `${event.aggregate_type}:${event.aggregate_id}`;
    const expected = (this.#versions.get(key) ?? 0) + 1;
    if (event.version !== expected) {
      throw new Error(`版本不连续：聚合 ${key} 期望 version=${expected}，收到 version=${event.version}`);
    }
    if (this.#byEventId.has(event.event_id)) {
      throw new Error(`事件编号重复：${event.event_id}`);
    }
    this.#versions.set(key, event.version);
    this.#byEventId.add(event.event_id);
    this.#events.push(structuredClone(event));
    return event;
  }

  has(eventId) {
    return this.#byEventId.has(eventId);
  }

  nextVersion(aggregateType, aggregateId) {
    return (this.#versions.get(`${aggregateType}:${aggregateId}`) ?? 0) + 1;
  }

  forAggregate(aggregateType, aggregateId) {
    return this.#events
      .filter((event) => event.aggregate_type === aggregateType && event.aggregate_id === aggregateId)
      .map((event) => structuredClone(event));
  }

  all() {
    return this.#events.map((event) => structuredClone(event));
  }
}
