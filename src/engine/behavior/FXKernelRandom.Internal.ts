import { FXCompilerErrorException } from "../core/compiler/FXCompilerError";
import type { FXExpr } from "../core/ir/FXExpr";
import { litInt, ref } from "../core/ir/FXExprBuilder";
import { childrenOf, withChildren } from "../core/ir/visit.Internal";
import { FX_VALUE_TYPES } from "../core/socket/FXValueType";
import { FX_SEEDED_RANDOM } from "./FXBehaviorFunctions.Internal";
import type { FXKernelLocal } from "./FXCompiledKernel";
import type { FXKernelTarget } from "./FXParticleBehaviorTarget";
import { FX_PARTICLE_ID_INPUT, FX_SEED_INPUT } from "./FXParticleBehaviorTarget";

/**
 * Gives each `rand()` of a phase its own draw index and hashes it with the particle id and the
 * update seed (`fxRandom`), so runs repeat and the value is fresh every tick. Indices follow the
 * order of the locals, which keeps draws apart and the calls pure.
 *
 * @throws When the phase draws but `target` provides no particle id or seed to hash.
 */
export function seedRandomDraws(
  locals: readonly FXKernelLocal[],
  target: FXKernelTarget,
): FXKernelLocal[] {
  const particleId = ref("targetInput", FX_PARTICLE_ID_INPUT, FX_VALUE_TYPES.float);
  const seed = ref("targetInput", FX_SEED_INPUT.name, FX_SEED_INPUT.type);
  let draws = 0;
  const seeded = (expr: FXExpr): FXExpr => {
    if (expr.kind === "call" && expr.fn === "rand") {
      if (draws === 0) {
        requireHashedInputs(target);
      }
      const draw = litInt(draws);
      draws += 1;
      return {
        kind: "call",
        type: expr.type,
        fn: FX_SEEDED_RANDOM,
        args: [particleId, seed, draw],
      };
    }
    const children = childrenOf(expr);
    return children.length === 0 ? expr : withChildren(expr, children.map(seeded));
  };
  return locals.map((local) => ({ name: local.name, expr: seeded(local.expr) }));
}

function requireHashedInputs(target: FXKernelTarget): void {
  for (const name of [FX_PARTICLE_ID_INPUT, FX_SEED_INPUT.name]) {
    if (!target.inputs.some((input) => input.name === name)) {
      throw new FXCompilerErrorException({
        code: "unknown-target-input",
        message: `seedRandomDraws: target "${target.name}" provides no builtin "${name}", which a random draw hashes`,
      });
    }
  }
}
