import { registerOwnedComputed, trackSignalRead, trackSignalWrite } from "./runtime-hooks";

export type SignalSetter<T> = (next: T | ((current: T) => T)) => void;

export interface ReadonlySignal<T> {
  (): T;
  <U>(map: (value: T) => U): ReadonlySignal<U>;
  readonly value: T;
  subscribe(listener: () => void): () => void;
  peek(): T;
}

export interface Signal<T>
  extends ReadonlySignal<T> {
  value: T;
  set: SignalSetter<T>;
  update(map: (current: T) => T): void;
}

export type SignalTuple<T> = Signal<T> & readonly [Signal<T>, SignalSetter<T>];

interface ReactiveComputation {
  markDirty(): void;
  registerDependency(signal: BaseSignal<unknown>): void;
  /**
   * Stamped during BaseSignal.notify() iteration. A dependent's markDirty()
   * may synchronously unsubscribe + re-subscribe itself (effects clear and
   * re-register their deps inside run()), which moves the entry to the
   * Set's tail and would cause for-of to re-visit it indefinitely. Comparing
   * the stamp against the current notify epoch deduplicates without
   * allocating a snapshot array.
   */
  lastNotifyEpoch: number;
}

let activeComputation: ReactiveComputation | null = null;
let notifyEpoch = 0;

abstract class BaseSignal<T> {
  protected listeners = new Set<() => void>();
  protected dependents = new Set<ReactiveComputation>();

  abstract get value(): T;
  abstract peek(): T;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  protected trackDependency(): void {
    trackSignalRead(this);
    if (activeComputation) {
      this.dependents.add(activeComputation);
      activeComputation.registerDependency(this);
    }
  }

  protected notify(): void {
    trackSignalWrite(this);

    // Listeners path is rare in this codebase — keep the simple snapshot.
    // A re-entrant subscribe()/unsubscribe() would otherwise corrupt iteration
    // order, and listeners are plain functions with no field to stamp.
    if (this.listeners.size > 0) {
      for (const listener of [...this.listeners]) {
        listener();
      }
    }

    // Hot path: epoch-stamped dedup so an effect that re-registers itself
    // inside markDirty() does not get re-visited. Avoids per-call array
    // allocation, which previously dominated `set value` cost (perf shows
    // 8.5%+ of total CPU under load with many windows).
    const epoch = ++notifyEpoch;
    for (const dependent of this.dependents) {
      if (dependent.lastNotifyEpoch === epoch) {
        continue;
      }
      dependent.lastNotifyEpoch = epoch;
      dependent.markDirty();
    }
  }

  removeDependent(computation: ReactiveComputation): void {
    this.dependents.delete(computation);
  }
}

class WritableSignal<T> extends BaseSignal<T> {
  #value: T;

  constructor(initialValue: T) {
    super();
    this.#value = initialValue;
  }

  get value(): T {
    this.trackDependency();
    return this.#value;
  }

  peek(): T {
    return this.#value;
  }

  set value(nextValue: T) {
    if (Object.is(this.#value, nextValue)) {
      return;
    }
    this.#value = nextValue;
    this.notify();
  }
}

class ComputedSignal<T> extends BaseSignal<T> implements ReactiveComputation {
  #compute: () => T;
  #cached!: T;
  #initialized = false;
  #dirty = true;
  #disposed = false;
  #dependencies = new Set<BaseSignal<unknown>>();
  lastNotifyEpoch = 0;

  constructor(compute: () => T) {
    super();
    this.#compute = compute;
    // Register with the current composition owner so the runtime can detach
    // us from our sources on the next composition pass. Without this, every
    // composition leaves behind a fresh ComputedSignal as a permanent
    // dependent of every BaseSignal it touched, and every signal write fans
    // out to the ever-growing graveyard.
    registerOwnedComputed(this);
  }

  get value(): T {
    this.trackDependency();
    this.recomputeIfNeeded();
    return this.#cached;
  }

  peek(): T {
    this.recomputeIfNeeded();
    return this.#cached;
  }

  markDirty(): void {
    if (this.#disposed) {
      return;
    }
    if (!this.#dirty) {
      this.#dirty = true;
      this.notify();
    }
  }

  registerDependency(signal: BaseSignal<unknown>): void {
    this.#dependencies.add(signal);
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const dependency of this.#dependencies) {
      dependency.removeDependent(this);
    }
    this.#dependencies.clear();
  }

  private recomputeIfNeeded(): void {
    if (this.#disposed) {
      return;
    }
    if (!this.#dirty && this.#initialized) {
      return;
    }

    for (const dependency of this.#dependencies) {
      dependency.removeDependent(this);
    }
    this.#dependencies.clear();

    const previous = activeComputation;
    activeComputation = this;
    try {
      const nextValue = this.#compute();
      const changed = !this.#initialized || !Object.is(this.#cached, nextValue);
      this.#cached = nextValue;
      this.#initialized = true;
      this.#dirty = false;
      if (changed) {
        const listeners = Array.from(this.listeners);
        for (const listener of listeners) {
          listener();
        }
      }
    } finally {
      activeComputation = previous;
    }
  }
}

class EffectHandle implements ReactiveComputation {
  #effect: () => void;
  #dependencies = new Set<BaseSignal<unknown>>();
  #disposed = false;
  lastNotifyEpoch = 0;

  constructor(effect: () => void) {
    this.#effect = effect;
    this.run();
  }

  markDirty(): void {
    if (!this.#disposed) {
      this.run();
    }
  }

  registerDependency(signal: BaseSignal<unknown>): void {
    this.#dependencies.add(signal);
  }

  dispose(): void {
    this.#disposed = true;
    for (const dependency of this.#dependencies) {
      dependency.removeDependent(this);
    }
    this.#dependencies.clear();
  }

  private run(): void {
    for (const dependency of this.#dependencies) {
      dependency.removeDependent(this);
    }
    this.#dependencies.clear();

    const previous = activeComputation;
    activeComputation = this;
    try {
      this.#effect();
    } finally {
      activeComputation = previous;
    }
  }
}

export function signal<T>(initialValue: T): SignalTuple<T> {
  return createWritableSignalFacade(new WritableSignal(initialValue));
}

export function computed<T>(compute: () => T): ReadonlySignal<T> {
  return createReadonlySignalFacade(new ComputedSignal(compute));
}

export function effect(run: () => void): () => void {
  const handle = new EffectHandle(run);
  return () => handle.dispose();
}

export function isSignal<T>(value: unknown): value is ReadonlySignal<T> {
  return (
    (typeof value === "function" || typeof value === "object") &&
    value !== null &&
    "value" in value &&
    typeof (value as ReadonlySignal<T>).subscribe === "function"
  );
}

export function read<T>(value: T | ReadonlySignal<T>): T {
  return isSignal<T>(value) ? value.value : value;
}

function createMappedSignalProxy<T, U>(
  source: BaseSignal<T>,
  mapFn: (value: T) => U,
): ReadonlySignal<U> {
  // Thin proxy that re-applies `mapFn` on every read. Does NOT create an
  // intermediate ComputedSignal: such a wrapper would register itself as a
  // permanent dependent of `source` on first read, and `source.dependents` is
  // never trimmed for unread computeds. Across composition passes the user's
  // arrow-callback form (`signal(x => ...)`) produced a fresh ComputedSignal
  // each call, accumulating without bound and turning every signal write into
  // an O(leaked-dependents) cascade. Anchoring the dep edge at `source` via
  // the outer reader keeps the graph short-lived and GC-friendly.
  const mapped = ((nestedMap?: unknown) => {
    if (typeof nestedMap === "function") {
      return createMappedSignalProxy(source, (value: T) =>
        (nestedMap as (mapped: U) => unknown)(mapFn(value)),
      );
    }
    return mapFn(source.value);
  }) as ReadonlySignal<U>;

  Object.defineProperty(mapped, "value", {
    get() {
      return mapFn(source.value);
    },
    enumerable: true,
    configurable: true,
  });

  // subscribe forwards to source: listeners fire on any source change rather
  // than on changes in the mapped output. Downstream computeds memoize on
  // their own output so the cascade still short-circuits when mapFn yields the
  // same value.
  mapped.subscribe = source.subscribe.bind(source);
  mapped.peek = () => mapFn(source.peek());

  return mapped;
}

function createReadonlySignalFacade<T>(
  source: BaseSignal<T>,
): ReadonlySignal<T> {
  const facade = ((map?: unknown) => {
    if (typeof map === "function") {
      return createMappedSignalProxy(source, map as (value: T) => unknown);
    }
    return source.value;
  }) as ReadonlySignal<T>;

  Object.defineProperty(facade, "value", {
    get() {
      return source.value;
    },
    enumerable: true,
    configurable: true,
  });

  facade.subscribe = source.subscribe.bind(source);
  facade.peek = source.peek.bind(source);

  return facade;
}

function createWritableSignalFacade<T>(
  source: WritableSignal<T>,
): SignalTuple<T> {
  const facade = createReadonlySignalFacade(source) as SignalTuple<T>;

  Object.defineProperty(facade, "value", {
    get() {
      return source.value;
    },
    set(nextValue: T) {
      source.value = nextValue;
    },
    enumerable: true,
    configurable: true,
  });

  const set: SignalSetter<T> = (next) => {
    source.value =
      typeof next === "function"
        ? (next as (current: T) => T)(source.peek())
        : next;
  };

  facade.set = set;
  facade.update = (map) => {
    source.value = map(source.peek());
  };
  Object.defineProperty(facade, 0, {
    value: facade,
    enumerable: false,
  });
  Object.defineProperty(facade, 1, {
    value: set,
    enumerable: false,
  });
  Object.defineProperty(facade, "length", {
    value: 2,
    enumerable: false,
  });
  facade[Symbol.iterator] = function* iterator(): IterableIterator<Signal<T> | SignalSetter<T>> {
    yield facade;
    yield set;
  };

  return facade;
}
