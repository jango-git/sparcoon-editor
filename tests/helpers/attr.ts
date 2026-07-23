import { FXBehaviorNodeStoreAttribute } from "../../src/engine/behavior/nodes/FXBehaviorNodeStoreAttribute";
import { FXBehaviorNodeReadAttribute } from "../../src/engine/behavior/nodes/FXBehaviorNodeReadAttribute";
import { FXBehaviorNodeReadAttributeComponents } from "../../src/engine/behavior/nodes/FXBehaviorNodeReadAttributeComponents";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import { attributeSlot } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import { FXRenderNodeReadAttribute } from "../../src/engine/render/nodes/FXRenderNodeReadAttribute";
import { FXRenderNodeReadAttributeComponents } from "../../src/engine/render/nodes/FXRenderNodeReadAttributeComponents";
import { FXShaderStage } from "../../src/engine/render/FXShaderStage";
import type { FXValueType } from "../../src/engine/core/socket/FXValueType";

/**
 * Test helpers for the executor-model attribute channel. In the reworked node set,
 * `velocity`/`scale`/`rotation`/`torque`/`seed` are ordinary user-declared attributes
 * (not target builtins/slots): a behavior graph writes one with `store-attribute` (bound
 * to the `attr:<name>` slot) and reads it with `read-attribute`; a render graph reads it
 * with the render `read-attribute` (-> `p_fx_<name>`). Motion is an explicit
 * `integrate-motion` node. These construct the manual attribute nodes directly, so a test
 * needn't register them.
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

/** A behavior `read-attribute` reader (default UPDATE phase). */
export function readAttr(
  name: string,
  type: FXValueType,
  phase: FXBehaviorPhase = FXBehaviorPhase.UPDATE,
): FXBehaviorNodeReadAttribute {
  return new FXBehaviorNodeReadAttribute(name, type, phase);
}

/** A render `read-attribute` reader (default FRAGMENT stage). */
export function readAttrRender(
  name: string,
  type: FXValueType,
  stage: FXShaderStage = FXShaderStage.FRAGMENT,
): FXRenderNodeReadAttribute {
  return new FXRenderNodeReadAttribute(name, type, stage);
}

/** A behavior `read-attribute-components` reader (default UPDATE phase). */
export function readAttrComponents(
  name: string,
  type: FXValueType,
  phase: FXBehaviorPhase = FXBehaviorPhase.UPDATE,
): FXBehaviorNodeReadAttributeComponents {
  return new FXBehaviorNodeReadAttributeComponents(name, type, phase);
}

/** A render `read-attribute-components` reader (default FRAGMENT stage). */
export function readAttrComponentsRender(
  name: string,
  type: FXValueType,
  stage: FXShaderStage = FXShaderStage.FRAGMENT,
): FXRenderNodeReadAttributeComponents {
  return new FXRenderNodeReadAttributeComponents(name, type, stage);
}
