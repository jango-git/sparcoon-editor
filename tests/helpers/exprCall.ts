import { createCall } from "../../src/engine/core/ir/FXExprBuilder";
import { FX_FUNCTIONS, signaturesFrom } from "../../src/engine/core/ir/FXFunctions.Internal";

/**
 * `call` bound to the core function signatures, for tests that build IR directly. Mirrors what a
 * render compile's builder carries; `createBuilders`/`createCall` replaced the former ambient
 * `registerCallSignatures` global.
 */
export const call = createCall(signaturesFrom(FX_FUNCTIONS));
