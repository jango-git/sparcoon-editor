/**
 * One content library's assets as the live objects the preview hands the runtime, by name: made
 * when an asset arrives, remade when it changes, disposed when it goes. The runtime never disposes
 * an asset, so the cache owns them.
 */
export class LibraryCache<A extends { readonly name: string }, R> {
  private readonly entries = new Map<string, { readonly asset: A; readonly resource: R }>();

  /** @param changed Whether `next` needs a new resource. By default any other asset object does. */
  constructor(
    private readonly make: (asset: A) => R,
    private readonly dispose: (resource: R) => void,
    private readonly changed: (previous: A, next: A) => boolean = (previous, next) =>
      previous !== next,
  ) {}

  public sync(assets: readonly A[]): void {
    const live = new Set(assets.map((asset) => asset.name));
    for (const [name, entry] of this.entries) {
      if (!live.has(name)) {
        this.dispose(entry.resource);
        this.entries.delete(name);
      }
    }
    for (const asset of assets) {
      const existing = this.entries.get(asset.name);
      if (existing === undefined || this.changed(existing.asset, asset)) {
        if (existing !== undefined) {
          this.dispose(existing.resource);
        }
        this.entries.set(asset.name, { asset, resource: this.make(asset) });
      }
    }
  }

  public get(name: string): R | undefined {
    return this.entries.get(name)?.resource;
  }

  public all(): Record<string, R> {
    const resources: Record<string, R> = {};
    for (const [name, entry] of this.entries) {
      resources[name] = entry.resource;
    }
    return resources;
  }

  public destroy(): void {
    for (const entry of this.entries.values()) {
      this.dispose(entry.resource);
    }
    this.entries.clear();
  }
}

/**
 * A {@link LibraryCache} whose resources decode asynchronously. `get` gives `undefined` until an
 * asset's decode lands and when it gave nothing. A decode that lands after its asset changed or went
 * is disposed at once. `onLoaded` fires after each decode that is kept.
 */
export class AsyncLibraryCache<A extends { readonly name: string }, R> {
  private readonly cache: LibraryCache<A, { resource: R | undefined; dropped: boolean }>;

  constructor(
    decode: (asset: A) => Promise<R | undefined>,
    dispose: (resource: R) => void,
    changed: (previous: A, next: A) => boolean,
    onLoaded: () => void,
  ) {
    this.cache = new LibraryCache(
      (asset) => {
        const slot: { resource: R | undefined; dropped: boolean } = {
          resource: undefined,
          dropped: false,
        };
        void decode(asset).then((resource) => {
          if (resource === undefined) {
            return;
          }
          if (slot.dropped) {
            dispose(resource);
            return;
          }
          slot.resource = resource;
          onLoaded();
        });
        return slot;
      },
      (slot) => {
        slot.dropped = true;
        if (slot.resource !== undefined) {
          dispose(slot.resource);
        }
      },
      changed,
    );
  }

  public sync(assets: readonly A[]): void {
    this.cache.sync(assets);
  }

  public get(name: string): R | undefined {
    return this.cache.get(name)?.resource;
  }

  public destroy(): void {
    this.cache.destroy();
  }
}
