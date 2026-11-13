import {
  FX_CORE_LIFECYCLE,
  FX_CORE_LIFECYCLE_STRIDE,
  FX_CORE_POSITION,
  FX_LIFETIME,
  type FXAttributeDecl,
  type FXBehaviorArtifact,
  type FXBufferLayout,
  type FXRenderArtifact,
  type FXRenderProgram,
  type FXShaderStageSource,
} from "sparcoon";

import {
  particleReadsOf,
  surfaceReadsOf,
} from "../../src/engine/render/target/FXParticleRenderTarget";
import { type FieldBuffers, overSlots } from "./slots";

/**
 * Hand-written artifact builders for the runtime executor tests. They stand in for the
 * (editor-owned) module emitter: a test constructs the two artifacts directly and drives
 * them through `FXEmitter.fromArtifacts`, so the runtime loop is exercised without any
 * graph/compiler.
 */

/** The output slots the vertex stage computes; every other slot is the fragment stage's. */
const VERTEX_OUTPUT_SLOTS: ReadonlySet<string> = new Set([
  "particleTransform",
  "vertexTransform",
  "width",
]);

/** A hand-written stage: its code, and what it reads of each particle - every identifier it
 *  names, through the compiler's own target-input mapping. */
function stage(
  body: readonly string[],
  outputs: readonly string[],
  uniformDeclarations: readonly string[],
): FXShaderStageSource {
  const identifiers = new Set([...body, ...outputs].join("\n").match(/\b[A-Za-z_]\w*\b/g));
  return {
    // As the compiler declares them: in each stage whose code reads them.
    uniformDeclarations: uniformDeclarations.filter((declaration) =>
      identifiers.has(/(\w+);$/.exec(declaration)?.[1] ?? ""),
    ),
    helperFunctions: [],
    body,
    particleReads: particleReadsOf([...identifiers]),
  };
}

/** A hand-written program over `outputs`, with what each stage reads recorded as the compiler does. */
function program(
  outputs: Readonly<Record<string, string>>,
  vertexBody: readonly string[],
  fragmentBody: readonly string[],
  uniformDeclarations: readonly string[],
): FXRenderProgram {
  const outputsOf = (vertex: boolean): string[] =>
    Object.keys(outputs)
      .filter((slot) => VERTEX_OUTPUT_SLOTS.has(slot) === vertex)
      .map((slot) => outputs[slot] ?? "");
  return {
    varyings: [],
    vertex: stage(vertexBody, outputsOf(true), uniformDeclarations),
    fragment: {
      ...stage(fragmentBody, outputsOf(false), uniformDeclarations),
      // Every identifier it names, through the compiler's own target-input mapping, as above.
      surfaceReads: surfaceReadsOf([
        ...new Set([...fragmentBody, ...outputsOf(false)].join("\n").match(/\b[A-Za-z_]\w*\b/g)),
      ]),
    },
    outputs,
  };
}

/** The slots a shadow program carries over from the color program's, as the compiler's target does. */
const SHADOW_CARRIED_SLOTS = ["alphaThreshold", "particleTransform", "vertexTransform"];

/** A minimal unlit render artifact (flat white albedo), with its shadow program. Override any field. */
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
  const outputs = over.outputs ?? { albedo: "vec4(1.0)" };
  const vertexBody = over.vertexBody ?? [];
  const fragmentBody = over.fragmentBody ?? [];
  const declarations = over.uniformDeclarations ?? [];
  const shadowOutputs = {
    alpha: `(${outputs["albedo"] ?? "vec4(1.0)"}).a`,
    ...Object.fromEntries(
      SHADOW_CARRIED_SLOTS.filter((slot) => slot in outputs).map((slot) => [slot, outputs[slot]]),
    ),
  };
  return {
    lightingIntrinsics: [],
    sceneDepth: false,
    color: program(outputs, vertexBody, fragmentBody, declarations),
    shadow: program(shadowOutputs, vertexBody, fragmentBody, declarations),
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
 * buffer and writes each declared attribute's value; its `update` is a no-op.
 * `noSpawn: true` yields an update-only (non-particle) host - no `spawn` function, so
 * `canSpawn` is false.
 */
export function behaviorArtifact(
  spec: {
    lifetime?: number;
    attributes?: readonly SeedAttr[];
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
  const seed = overSlots(buffers, (fields: FieldBuffers, start: number, count: number): void => {
    const lifecycle = fields[FX_CORE_LIFECYCLE];
    for (let i = start; i < start + count; i++) {
      lifecycle[i * FX_CORE_LIFECYCLE_STRIDE + FX_LIFETIME] = lifetime;
    }
    for (const attr of attributes) {
      const buf = fields[attr.name];
      for (let i = start; i < start + count; i++) {
        const value = attr.valueFn ? attr.valueFn(i) : (attr.value ?? []);
        for (let c = 0; c < attr.components; c++) {
          buf[i * attr.components + c] = value[c] ?? 0;
        }
      }
    }
  });
  return {
    buffers,
    bindings: {},
    update: (): void => undefined,
    ...(spec.noSpawn === true ? {} : { spawn: seed }),
  };
}
