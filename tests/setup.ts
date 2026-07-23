// Texture render nodes call checkSRGBSupport() during build, which reaches for
// `document.createElement("canvas").getContext(...)`. In headless node there is no
// document; a stub whose canvas yields no GL context makes checkSRGBSupport return
// false (the non-sRGB path) without pulling in a real WebGL implementation.
interface DocumentStub {
  createElement(): { getContext(): undefined };
}

const globalWithDocument = globalThis as typeof globalThis & { document?: DocumentStub };
globalWithDocument.document ??= {
  createElement: () => ({ getContext: () => undefined }),
};
