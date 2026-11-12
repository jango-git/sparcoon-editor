import { type BufferGeometry, PerspectiveCamera, Scene, Texture, type WebGLRenderer } from "three";

import { SceneEmitters } from "../../src/render/sceneEmitters";

export interface PreviewOptions {
  /** What the stub renderer claims; the headless suite never has a real WebGL context. */
  readonly webgl2?: boolean;
  /** The custom mesh-geometry resolver, by mesh-asset name. */
  readonly meshGeometries?: () => Readonly<Record<string, BufferGeometry>>;
}

const created: SceneEmitters[] = [];

/**
 * A live preview on the baseline tier over a fresh scene, with the caret parked at 0. The renderer
 * is a shape stub covering the only property ever read (`capabilities.isWebGL2`) - this headless
 * suite's no-real-WebGL policy (tests/setup.ts). Release it with {@link destroyPreviews}.
 */
export function createPreview(options: PreviewOptions = {}): SceneEmitters {
  const renderer = {
    capabilities: { isWebGL2: options.webgl2 ?? false },
  } as unknown as WebGLRenderer;
  const emitters = new SceneEmitters(
    new Scene(),
    () => new Texture(),
    new PerspectiveCamera(),
    renderer,
    "baseline",
    () => 0,
    options.meshGeometries ?? ((): Readonly<Record<string, BufferGeometry>> => ({})),
  );
  created.push(emitters);
  return emitters;
}

/** Destroys every preview {@link createPreview} made since the last call (an `afterEach` hook). */
export function destroyPreviews(): void {
  for (const emitters of created.splice(0)) {
    emitters.destroy();
  }
}
