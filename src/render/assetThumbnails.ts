/**
 * Still-image previews for the content sheet's two kinds with no native browser preview: an HDR
 * radiance file can't be decoded by an `<img>`, and a mesh asset is bare vertex arrays with no
 * baked image at all. Both are rendered once to an offscreen canvas and cached as a PNG data URL,
 * keyed by asset identity - mirrors {@link TextureRegistry}'s "resolve, don't recompute" cache
 * shape, but as plain functions since neither needs the app-lifecycle `sync`/`destroy` a live
 * render-pipeline registry does.
 */

import {
  FloatType,
  Mesh,
  MeshNormalMaterial,
  PerspectiveCamera,
  Scene,
  Sphere,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
} from "three";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import type { EnvironmentAsset, MeshAsset } from "../model/editorState";
import { downsampleEquirect } from "./environmentTexture";
import { buildGeometryFromArrays } from "./meshGeometryBaking";

const HDRI_THUMBNAIL_WIDTH = 64;
const HDRI_THUMBNAIL_HEIGHT = 32;
const MESH_THUMBNAIL_SIZE = 96;
/** Camera pulled back this many bounding-sphere radii past the tight framing distance. */
const MESH_FRAME_MARGIN = 1.35;
const MESH_CAMERA_FOV_DEGREES = 35;

interface EnvironmentThumbnailEntry {
  readonly dataUrl: string;
  thumbnailUrl?: string;
}

const environmentThumbnailCache = new Map<string, EnvironmentThumbnailEntry>();
// FloatType, not the RGBELoader default (HalfFloatType): downsampleEquirect reads `image.data` as
// a plain Float32Array, which a half-float bit pattern would not numerically be.
const hdriLoader = new RGBELoader().setDataType(FloatType);

/**
 * Tone-mapped PNG thumbnails for the given HDRI library, keyed by asset name. A newly seen or
 * changed asset starts an async decode and is absent from the returned map until it lands, at
 * which point `onReady` fires so the caller can re-list and pick up the cache.
 */
export function environmentThumbnails(
  assets: readonly EnvironmentAsset[],
  onReady: () => void,
): ReadonlyMap<string, string> {
  pruneStale(environmentThumbnailCache, assets);
  const resolved = new Map<string, string>();
  for (const asset of assets) {
    const existing = environmentThumbnailCache.get(asset.name);
    if (existing?.dataUrl === asset.dataUrl) {
      if (existing.thumbnailUrl !== undefined) {
        resolved.set(asset.name, existing.thumbnailUrl);
      }
      continue;
    }
    const entry: EnvironmentThumbnailEntry = { dataUrl: asset.dataUrl };
    environmentThumbnailCache.set(asset.name, entry);
    decodeEnvironmentThumbnail(asset.name, entry, onReady);
  }
  return resolved;
}

function decodeEnvironmentThumbnail(
  name: string,
  entry: EnvironmentThumbnailEntry,
  onReady: () => void,
): void {
  hdriLoader.load(
    entry.dataUrl,
    (texture) => {
      // The entry may have been evicted or replaced by a re-upload while this decode was in flight.
      if (environmentThumbnailCache.get(name) !== entry) {
        texture.dispose();
        return;
      }
      const source = texture.image as unknown as {
        data: Float32Array;
        width: number;
        height: number;
      };
      const resized = downsampleEquirect(source, HDRI_THUMBNAIL_WIDTH, HDRI_THUMBNAIL_HEIGHT);
      texture.dispose();
      entry.thumbnailUrl = renderTonemappedPng(
        resized,
        HDRI_THUMBNAIL_WIDTH,
        HDRI_THUMBNAIL_HEIGHT,
      );
      onReady();
    },
    undefined,
    (error) => console.warn(`Failed to decode HDRI thumbnail "${name}"`, error),
  );
}

/** Draws a tonemapped linear-float RGBA buffer to a canvas and reads it back as a PNG data URL. */
function renderTonemappedPng(data: Float32Array, width: number, height: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d") ?? undefined;
  if (context === undefined) {
    return "";
  }
  const image = context.createImageData(width, height);
  image.data.set(tonemapToImageBytes(data));
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * Reinhard-tonemaps (unbounded HDR -> [0,1]) then linear-to-sRGB gamma encodes an RGBA float
 * buffer into 8-bit channel bytes, ready for `ImageData`. Exported (not just `renderTonemappedPng`)
 * so this half of thumbnail generation - the only part with no canvas/DOM dependency - is unit
 * testable.
 */
export function tonemapToImageBytes(data: Float32Array): Uint8ClampedArray {
  const bytes = new Uint8ClampedArray(data.length);
  for (let index = 0; index < data.length; index += 4) {
    bytes[index] = toSrgbByte(data[index] ?? 0);
    bytes[index + 1] = toSrgbByte(data[index + 1] ?? 0);
    bytes[index + 2] = toSrgbByte(data[index + 2] ?? 0);
    bytes[index + 3] = 255;
  }
  return bytes;
}

function toSrgbByte(linear: number): number {
  const tonemapped = Math.max(0, linear) / (1 + Math.max(0, linear));
  const srgb =
    tonemapped <= 0.0031308 ? tonemapped * 12.92 : 1.055 * tonemapped ** (1 / 2.4) - 0.055;
  return Math.round(srgb * 255);
}

interface MeshThumbnailEntry {
  readonly geometry: MeshAsset["geometry"];
  readonly thumbnailUrl: string;
}

const meshThumbnailCache = new Map<string, MeshThumbnailEntry>();

interface MeshRig {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly material: MeshNormalMaterial;
}

let meshRig: MeshRig | undefined;

/** Builds the shared offscreen renderer/scene/camera lazily, on first thumbnail request - never
 * at module load, where `document.createElement("canvas")` may be a headless-test stub. */
function getMeshRig(): MeshRig {
  if (meshRig !== undefined) {
    return meshRig;
  }
  const renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(MESH_THUMBNAIL_SIZE, MESH_THUMBNAIL_SIZE, false);
  renderer.setClearColor(0x000000, 0);
  meshRig = {
    renderer,
    scene: new Scene(),
    camera: new PerspectiveCamera(MESH_CAMERA_FOV_DEGREES, 1, 0.01, 100),
    material: new MeshNormalMaterial(),
  };
  return meshRig;
}

/** Rendered PNG thumbnails for the given mesh library, keyed by asset name. Synchronous - one
 * offscreen render per asset is cheap enough to run inline, unlike the HDRI decode. */
export function meshThumbnails(assets: readonly MeshAsset[]): ReadonlyMap<string, string> {
  pruneStale(meshThumbnailCache, assets);
  const resolved = new Map<string, string>();
  for (const asset of assets) {
    resolved.set(asset.name, resolveMeshThumbnail(asset));
  }
  return resolved;
}

function resolveMeshThumbnail(asset: MeshAsset): string {
  const existing = meshThumbnailCache.get(asset.name);
  if (existing?.geometry === asset.geometry) {
    return existing.thumbnailUrl;
  }
  const thumbnailUrl = renderMeshThumbnail(buildGeometryFromArrays(asset.geometry));
  meshThumbnailCache.set(asset.name, { geometry: asset.geometry, thumbnailUrl });
  return thumbnailUrl;
}

/** Renders `geometry` (normal-shaded, since a baked asset carries no material) into the shared
 * offscreen rig, framed by its bounding sphere; disposes the geometry, which this function owns. */
function renderMeshThumbnail(geometry: BufferGeometry): string {
  const { renderer, scene, camera, material } = getMeshRig();
  geometry.computeBoundingSphere();
  frameCamera(camera, geometry.boundingSphere ?? new Sphere(new Vector3(), 1));
  const mesh = new Mesh(geometry, material);
  scene.add(mesh);
  renderer.render(scene, camera);
  const thumbnailUrl = renderer.domElement.toDataURL("image/png");
  scene.remove(mesh);
  geometry.dispose();
  return thumbnailUrl;
}

/** Points the camera at `sphere`, pulled back far enough on a fixed diagonal to frame it whole. */
function frameCamera(camera: PerspectiveCamera, sphere: Sphere): void {
  const radius = sphere.radius > 0 ? sphere.radius : 1;
  const halfFovRadians = (camera.fov * Math.PI) / 360;
  const distance = (radius / Math.sin(halfFovRadians)) * MESH_FRAME_MARGIN;
  const direction = new Vector3(1, 1.2, 1.6).normalize();
  camera.position.copy(sphere.center).addScaledVector(direction, distance);
  camera.near = Math.max(distance - radius * 2, 0.01);
  camera.far = distance + radius * 2;
  camera.lookAt(sphere.center);
  camera.updateProjectionMatrix();
}

/** Drops cache entries for assets no longer in the library (a removed or renamed upload). */
function pruneStale<Entry>(
  cache: Map<string, Entry>,
  assets: readonly { readonly name: string }[],
): void {
  const live = new Set(assets.map((asset) => asset.name));
  for (const name of cache.keys()) {
    if (!live.has(name)) {
      cache.delete(name);
    }
  }
}
