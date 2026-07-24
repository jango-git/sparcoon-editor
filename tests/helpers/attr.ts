import { FXBehaviorNodeStoreAttribute } from "../../src/engine/behavior/nodes/FXBehaviorNodeStoreAttribute";
import { FXBehaviorNodeCustomAttribute } from "../../src/engine/behavior/nodes/FXBehaviorNodeCustomAttribute";
import { FXBehaviorNodeCustomAttributeSplit } from "../../src/engine/behavior/nodes/FXBehaviorNodeCustomAttributeSplit";
import { FXBehaviorNodeBuiltinAttribute } from "../../src/engine/behavior/nodes/FXBehaviorNodeBuiltinAttribute";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import { attributeSlot } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import { FXRenderNodeCustomAttribute } from "../../src/engine/render/nodes/FXRenderNodeCustomAttribute";
import { FXRenderNodeCustomAttributeSplit } from "../../src/engine/render/nodes/FXRenderNodeCustomAttributeSplit";
import { FXRenderNodeBuiltinAttribute } from "../../src/engine/render/nodes/FXRenderNodeBuiltinAttribute";
import { FXShaderStage } from "../../src/engine/render/FXShaderStage";
import type { FXValueType } from "../../src/engine/core/socket/FXValueType";

/**
 * Test helpers for the executor-model attribute channel. In the reworked node set,
 * `velocity`/`scale`/`rotation`/`torque`/`seed` are ordinary user-declared attributes
 * (not target builtins/slots): a behavior graph writes one with `store-attribute` (bound
 * to the `attr:<name>` slot) and reads it with `custom-attribute`; a render graph reads
 * it with the render `custom-attribute` (-> `p_fx_<name>`). A core builtin
 * (position/age/lifetime/id) reads through the separate `builtin-attribute` node instead.
 * Motion is an explicit `integrate-motion` node. These construct the manual attribute nodes
 * directly, so a test needn't register them.
 */

/** Re-exported so a graph can bind a store-attribute output to `attr:<name>`. */
export { attributeSlot };

/** A behavior `store-attribute` writer (default UPDATE phase). */
export function storeAttr(
  name: string,
  type: FXValueType,
  phase: FXBehaviorPhase = FXBehaviorPhase.UPDATE,
): FXBehaviorNodeStoreAttribute {
  return new FXBehaviorNodeStoreAttribute(name, type, phase);
}

/** A behavior `custom-attribute` reader (default UPDATE phase). */
export function readAttr(
  name: string,
  type: FXValueType,
  phase: FXBehaviorPhase = FXBehaviorPhase.UPDATE,
): FXBehaviorNodeCustomAttribute {
  return new FXBehaviorNodeCustomAttribute(name, type, phase);
}

/** A render `custom-attribute` reader (default FRAGMENT stage). */
export function readAttrRender(
  name: string,
  type: FXValueType,
  stage: FXShaderStage = FXShaderStage.FRAGMENT,
): FXRenderNodeCustomAttribute {
  return new FXRenderNodeCustomAttribute(name, type, stage);
}

/** A behavior `custom-attribute-split` reader (default UPDATE phase). */
export function readAttrComponents(
  name: string,
  type: FXValueType,
  phase: FXBehaviorPhase = FXBehaviorPhase.UPDATE,
): FXBehaviorNodeCustomAttributeSplit {
  return new FXBehaviorNodeCustomAttributeSplit(name, type, phase);
}

/** A render `custom-attribute-split` reader (default FRAGMENT stage). */
export function readAttrComponentsRender(
  name: string,
  type: FXValueType,
  stage: FXShaderStage = FXShaderStage.FRAGMENT,
): FXRenderNodeCustomAttributeSplit {
  return new FXRenderNodeCustomAttributeSplit(name, type, stage);
}

/** A behavior `builtin-attribute` reader (all four host builtins at once). */
export function readBuiltinAttr(): FXBehaviorNodeBuiltinAttribute {
  return new FXBehaviorNodeBuiltinAttribute();
}

/** A render `builtin-attribute` reader (all four host builtins at once). */
export function readBuiltinAttrRender(): FXRenderNodeBuiltinAttribute {
  return new FXRenderNodeBuiltinAttribute();
}
