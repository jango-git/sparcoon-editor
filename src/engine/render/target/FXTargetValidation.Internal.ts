import type { FXCompilerError } from "../../core/compiler/FXCompilerError";
import {
  IDENTIFIER_PATTERN,
  isRecord,
  isValueTypeShape,
  shapeError,
  valueTypeError,
} from "../../core/compiler/targetLint.Internal";
import { FXShaderStage } from "../FXShaderStage";
import type { FXTarget } from "./FXTarget";

/** GLSL ES keywords (plus `main`) that pass the identifier regex but produce a broken shader
 *  when printed as a read. Deliberately no blanket `gl_` ban: `gl_FragCoord` is a legitimate read. */
const GLSL_KEYWORDS: ReadonlySet<string> = new Set([
  "float",
  "int",
  "uint",
  "bool",
  "void",
  "vec2",
  "vec3",
  "vec4",
  "ivec2",
  "ivec3",
  "ivec4",
  "bvec2",
  "bvec3",
  "bvec4",
  "mat2",
  "mat3",
  "mat4",
  "sampler2D",
  "sampler3D",
  "samplerCube",
  "struct",
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "default",
  "return",
  "break",
  "continue",
  "discard",
  "in",
  "out",
  "inout",
  "uniform",
  "varying",
  "attribute",
  "const",
  "true",
  "false",
  "precision",
  "highp",
  "mediump",
  "lowp",
  "layout",
  "flat",
  "centroid",
  "invariant",
  "main",
]);

/** The counter-suffixed shape of compiler-generated shader-scope declarations: `u_<hint>_<n>`
 *  uniforms and `v_<hint>_<n>` varyings. A target input matching one could be silently shadowed,
 *  so these two prefixes are reserved; generated locals (arbitrary node-type prefixes) are not. */
const GENERATED_IDENTIFIER = /^[uv]_.*_\d+$/;

/** The stages a render target may legally reference. */
const LEGAL_STAGES: readonly FXShaderStage[] = [FXShaderStage.VERTEX, FXShaderStage.FRAGMENT];

/** Structurally lints a render {@link FXTarget} - the host's own data, so the library validates
 *  it rather than letting a typo surface as a broken Three shader. Checks identifier legality,
 *  keyword/reserved-namespace collisions, name uniqueness, canonical types, and known stages. */
export function validateRenderTarget(target: FXTarget): FXCompilerError[] {
  // The target may be a hand-authored host literal, so its shape is not guaranteed by the type
  // system at runtime; a structural violation returns immediately as `invalid-target`.
  const shapeErrors = renderTargetShapeErrors(target);
  if (shapeErrors.length > 0) {
    return shapeErrors;
  }
  return validateRenderTargetSemantics(target);
}

/** Semantic lint of a render target, assuming its shape is already valid - see
 *  {@link renderTargetShapeErrors}. Split out so {@link FXCompilerBaseline} doesn't pay for the shape
 *  check twice per validate. */
export function validateRenderTargetSemantics(target: FXTarget): FXCompilerError[] {
  const errors: FXCompilerError[] = [];

  const seenInputs = new Set<string>();
  for (const input of target.inputs) {
    // A target input name is printed into the shader verbatim (`REF_BY_NAME` in printGLSLBaseline),
    // so it must be a plain identifier or it only blows up inside Three's shader compiler.
    if (!IDENTIFIER_PATTERN.test(input.name)) {
      errors.push({
        code: "bad-render-input-identifier",
        message: `target "${target.name}" input "${input.name}" is not a valid GLSL identifier`,
        params: { targetName: target.name, inputName: input.name },
      });
    } else if (GLSL_KEYWORDS.has(input.name)) {
      errors.push({
        code: "render-input-is-glsl-keyword",
        message: `target "${target.name}" input "${input.name}" is a GLSL keyword`,
        params: { targetName: target.name, inputName: input.name },
      });
    } else if (GENERATED_IDENTIFIER.test(input.name)) {
      errors.push({
        code: "render-input-matches-generated-pattern",
        message: `target "${target.name}" input "${input.name}" matches the compiler-generated "u_/v_..._<digits>" identifier form, which is reserved`,
        params: { targetName: target.name, inputName: input.name },
      });
    }
    const inputTypeError = valueTypeError(target.name, input.type, `input "${input.name}"`);
    if (inputTypeError !== undefined) {
      errors.push(inputTypeError);
    }
    if (seenInputs.has(input.name)) {
      errors.push({
        code: "duplicate-target-input",
        message: `target "${target.name}" declares input "${input.name}" more than once`,
        params: { targetName: target.name, inputName: input.name },
      });
    }
    seenInputs.add(input.name);
    for (const stage of input.stages) {
      if (!LEGAL_STAGES.some((legal) => legal === stage)) {
        errors.push({
          code: "unknown-render-input-stage",
          message: `target "${target.name}" input "${input.name}" names unknown stage "${stage}"`,
          params: { targetName: target.name, inputName: input.name, stage },
        });
      }
    }
  }

  const seenOutputs = new Set<string>();
  for (const output of target.outputs) {
    if (seenOutputs.has(output.slot)) {
      errors.push({
        code: "duplicate-target-output",
        message: `target "${target.name}" declares output slot "${output.slot}" more than once`,
        params: { targetName: target.name, outputSlot: output.slot },
      });
    }
    seenOutputs.add(output.slot);
    const outputTypeError = valueTypeError(target.name, output.type, `output "${output.slot}"`);
    if (outputTypeError !== undefined) {
      errors.push(outputTypeError);
    }
    if (!LEGAL_STAGES.some((legal) => legal === output.stage)) {
      errors.push({
        code: "unknown-render-output-stage",
        message: `target "${target.name}" output "${output.slot}" names unknown stage "${output.stage}"`,
        params: { targetName: target.name, outputSlot: output.slot, stage: output.stage },
      });
    }
  }

  return errors;
}

/** Structural (shape) check of a render target. Returns errors instead of letting a malformed
 *  host literal surface as a TypeError inside `validate`/`apply`. */
export function renderTargetShapeErrors(target: unknown): FXCompilerError[] {
  if (!isRecord(target)) {
    return [shapeError("<unknown>", "target", "an object")];
  }
  const name = typeof target["name"] === "string" ? target["name"] : "<unnamed>";
  const errors: FXCompilerError[] = [];
  if (typeof target["name"] !== "string") {
    errors.push(shapeError(name, "name", "a string"));
  }

  const inputs = target["inputs"];
  if (!Array.isArray(inputs)) {
    errors.push(shapeError(name, "inputs", "an array"));
  } else {
    inputs.forEach((input: unknown, index: number): void => {
      const path = `inputs[${index.toString()}]`;
      if (!isRecord(input)) {
        errors.push(shapeError(name, path, "an object"));
        return;
      }
      if (typeof input["name"] !== "string") {
        errors.push(shapeError(name, `${path}.name`, "a string"));
      }
      if (!isValueTypeShape(input["type"])) {
        errors.push(shapeError(name, `${path}.type`, "an FXValueType"));
      }
      if (!Array.isArray(input["stages"])) {
        errors.push(shapeError(name, `${path}.stages`, "an array"));
      }
    });
  }

  const outputs = target["outputs"];
  if (!Array.isArray(outputs)) {
    errors.push(shapeError(name, "outputs", "an array"));
  } else {
    outputs.forEach((output: unknown, index: number): void => {
      const path = `outputs[${index.toString()}]`;
      if (!isRecord(output)) {
        errors.push(shapeError(name, path, "an object"));
        return;
      }
      if (typeof output["slot"] !== "string") {
        errors.push(shapeError(name, `${path}.slot`, "a string"));
      }
      if (!isValueTypeShape(output["type"])) {
        errors.push(shapeError(name, `${path}.type`, "an FXValueType"));
      }
      if (typeof output["required"] !== "boolean") {
        errors.push(shapeError(name, `${path}.required`, "a boolean"));
      }
    });
  }

  return errors;
}
