/**
 * One content library's assets as the live objects the preview hands the runtime, by name: made
 * when an asset arrives, remade when it changes, disposed when it goes. The runtime never disposes
 * an asset, so the cache owns them.
 */
export class LibraryCache<A extends { readonly name: string }, R> {
  private readonly entries = new Map<string, { readonly asset: A; readonly resource: R }>();

  /**
   * @param make Makes an asset's resource.
   * @param dispose Releases a resource that is replaced or gone.
   * @param changed Whether `next` needs a new resource where `previous` had one; by default any
   * other asset object does.
   */
  constructor(
    private readonly make: (asset: A) => R,
    private readonly dispose: (resource: R) => void,
    private readonly changed: (previous: A, next: A) => boolean = (previous, next) =>
      previous !== next,
  ) {}

  /** Reconciles the cache with the library's assets: add new, replace changed, drop gone. */
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

  /** The resource of asset `name`, if the library holds it. */
  public get(name: string): R | undefined {
    return this.entries.get(name)?.resource;
  }

  /** Every resource, by its asset's name. */
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
