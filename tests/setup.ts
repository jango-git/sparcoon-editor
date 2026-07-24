// Texture render nodes call checkSRGBSupport() during build, which reaches for
// `document.createElement("canvas").getContext(...)`. In headless node there is no
// document; a stub whose canvas yields no GL context makes checkSRGBSupport return
// false (the non-sRGB path) without pulling in a real WebGL implementation.
// TransportStore also registers a `visibilitychange` listener (tab-backgrounding guard); the
// stub's addEventListener/removeEventListener are no-ops so construction doesn't throw in tests.
interface DocumentStub {
  createElement(): { getContext(): undefined };
  addEventListener(): void;
  removeEventListener(): void;
}

const globalWithDocument = globalThis as typeof globalThis & { document?: DocumentStub };
globalWithDocument.document ??= {
  createElement: () => ({ getContext: () => undefined }),
  addEventListener: () => {},
  removeEventListener: () => {},
};
