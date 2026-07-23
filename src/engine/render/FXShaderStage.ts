/** Shader stage a node, input, output or emitted statement belongs to. The compiler is
 *  stage-aware so one graph can drive both programs, promoting crossing values to varyings. */
export enum FXShaderStage {
  VERTEX = "vertex",
  FRAGMENT = "fragment",
}
