/**
 * Still-image previews for HDR and mesh assets, which the browser cannot show natively. Rendered
 * once offscreen and cached as a PNG data URL by asset identity.
 */

import {
  type BufferGeometry,
  FloatType,
  Mesh,
  MeshNormalMaterial,
  PerspectiveCamera,
  Scene,
  Sphere,
  Vector3,
  WebGLRenderer,
} from "three";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";

import type { EnvironmentAsset, MeshAsset } from "../model/editorState";
import { downsampleEquirect, loadHdrTexture } from "./environmentTexture";
import { buildGeometryFromArrays } from "./meshGeometryBaking";

const HDRI_THUMBNAIL_WIDTH = 64;
const HDRI_THUMBNAIL_HEIGHT = 32;
const MESH_THUMBNAIL_SIZE = 96;
/** Extra camera distance, in bounding-sphere radii, beyond tight framing. */
const MESH_FRAME_MARGIN = 1.35;
const MESH_CAMERA_FOV_DEGREES = 35;

interface EnvironmentThumbnailEntry {
  readonly bytes: Uint8Array<ArrayBuffer>;
  thumbnailUrl?: string;
}

const environmentThumbnailCache = new Map<string, EnvironmentThumbnailEntry>();
// FloatType, not the RGBELoader default (HalfFloatType): downsampleEquirect reads `image.data` as
// a plain Float32Array, which a half-float bit pattern would not numerically be.
const hdriLoader = new RGBELoader().setDataType(FloatType);

/**
 * Tone-mapped PNG thumbnails by asset name. A new or changed asset decodes asynchronously and
 * `onReady` fires when it lands.
 */
export function environmentThumbnails(
  assets: readonly EnvironmentAsset[],
  onReady: () => void,
): ReadonlyMap<string, string> {
  pruneStale(environmentThumbnailCache, assets);
  const resolved = new Map<string, string>();
  for (const asset of assets) {
    const existing = environmentThumbnailCache.get(asset.name);
    if (existing?.bytes === asset.bytes) {
      if (existing.thumbnailUrl !== undefined) {
        resolved.set(asset.name, existing.thumbnailUrl);
      }
      continue;
    }
    const entry: EnvironmentThumbnailEntry = { bytes: asset.bytes };
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
  void loadHdrTexture(hdriLoader, entry.bytes).then(
    (texture) => {
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
    (error: unknown) => console.warn(`Failed to decode HDRI thumbnail "${name}"`, error),
  );
}

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

/** Reinhard tonemap (HDR to [0,1]), then linear to sRGB encode, into 8-bit RGBA. */
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

/**
 * Built on first use, not at module load, where `document.createElement("canvas")` may be a test
 * stub.
 */
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

/** PNG thumbnails by asset name, rendered synchronously. */
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

/** Renders `geometry` normal-shaded, framed by its bounding sphere. Disposes the geometry. */
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
