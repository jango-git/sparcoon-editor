import {
  FX_CORE_LIFECYCLE,
  FX_CORE_LIFECYCLE_STRIDE,
  FX_CORE_POSITION,
  FX_LIFETIME,
  type FXAttributeDecl,
  type FXBehaviorArtifact,
  type FXBufferLayout,
  type FXKernelBuffers,
  type FXRenderArtifact,
} from "sparcoon";

/**
 * Hand-written artifact builders for the runtime executor tests. They stand in for the
 * (editor-owned) module emitter: a test constructs the two artifacts directly and drives
 * them through `FXEmitter.fromArtifacts`, so the runtime loop is exercised without any
 * graph/compiler.
 */

/** A minimal unlit render artifact (flat white albedo). Override any field. */
export function unlitArtifact(
  over: {
    attributeReads?: readonly FXAttributeDecl[];
    outputs?: Record<string, string>;
    uniformDeclarations?: readonly string[];
    uniforms?: FXRenderArtifact["uniforms"];
    vertexBody?: readonly string[];
    fragmentBody?: readonly string[];
  } = {},
): FXRenderArtifact {
  return {
    lightingIntrinsics: [],
    uniformDeclarations: over.uniformDeclarations ?? [],
    vertex: { varyingDeclarations: [], helperFunctions: [], body: over.vertexBody ?? [] },
    fragment: { varyingDeclarations: [], helperFunctions: [], body: over.fragmentBody ?? [] },
    outputs: over.outputs ?? { albedo: "vec4(1.0)" },
    uniforms: over.uniforms ?? {},
    attributeReads: over.attributeReads ?? [],
  };
}

/** One attribute the behavior artifact seeds at spawn (fixed or per-particle value). */
export interface SeedAttr {
  name: string;
  components: 1 | 2 | 3 | 4;
  value?: readonly number[];
  valueFn?: (index: number) => readonly number[];
}

/**
 * A behavior artifact whose `spawn` seeds a fixed `lifetime` into the core `lifecycle`
 * buffer and writes each declared attribute's value. `update` defaults to a no-op.
 * `noSpawn: true` yields an update-only (non-particle) host - no `spawn` function, so
 * `canSpawn` is false.
 */
export function behaviorArtifact(
  spec: {
    lifetime?: number;
    attributes?: readonly SeedAttr[];
    update?: FXBehaviorArtifact["update"];
    updateWrittenBuffers?: readonly string[];
    noSpawn?: boolean;
  } = {},
): FXBehaviorArtifact {
  const attributes = spec.attributes ?? [];
  const lifetime = spec.lifetime ?? 5;

  const buffers: FXBufferLayout[] = [
    { name: FX_CORE_POSITION, stride: 3 },
    { name: FX_CORE_LIFECYCLE, stride: FX_CORE_LIFECYCLE_STRIDE },
    ...attributes.map((a) => ({ name: a.name, stride: a.components })),
  ];
  const attributeWrites: FXAttributeDecl[] = attributes.map((a) => ({
    name: a.name,
    components: a.components,
  }));

  const spawnPart =
    spec.noSpawn === true
      ? {}
      : {
          spawnWrittenBuffers: [FX_CORE_LIFECYCLE, ...attributes.map((a) => a.name)],
          spawn(buffers2: FXKernelBuffers, start: number, count: number): void {
            const lifecycle = buffers2[FX_CORE_LIFECYCLE];
            for (let i = start; i < start + count; i++) {
              lifecycle[i * FX_CORE_LIFECYCLE_STRIDE + FX_LIFETIME] = lifetime;
            }
            for (const attr of attributes) {
              const buf = buffers2[attr.name];
              for (let i = start; i < start + count; i++) {
                const value = attr.valueFn ? attr.valueFn(i) : (attr.value ?? []);
                for (let c = 0; c < attr.components; c++) {
                  buf[i * attr.components + c] = value[c] ?? 0;
                }
              }
            }
          },
        };

  return {
    buffers,
    attributeWrites,
    bindings: {},
    updateWrittenBuffers: spec.updateWrittenBuffers ?? [],
    update: spec.update ?? ((): void => undefined),
    ...spawnPart,
  };
}
