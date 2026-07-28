export type Handler<T> = (payload: T) => void;

export class Emitter<EventMap extends Record<string, unknown>> {
  private handlers = new Map<keyof EventMap, Set<Handler<never>>>();

  on<K extends keyof EventMap>(key: K, cb: Handler<EventMap[K]>): () => void {
    let set = this.handlers.get(key);
    if (!set) {
      set = new Set();
      this.handlers.set(key, set);
    }
    set.add(cb as Handler<never>);
    return () => {
      set.delete(cb as Handler<never>);
    };
  }

  emit<K extends keyof EventMap>(key: K, payload: EventMap[K]): void {
    this.handlers.get(key)?.forEach((cb) => (cb as Handler<EventMap[K]>)(payload));
  }

  clear(): void {
    this.handlers.clear();
  }
}
