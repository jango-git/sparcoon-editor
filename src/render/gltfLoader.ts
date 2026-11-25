/**
 * The glTF loader every upload goes through: plain and meshopt-compressed (`EXT_meshopt_compression`)
 * files. Draco and KTX2 need decoders served beside the editor, so files using them do not load.
 */

import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export function createGltfLoader(): GLTFLoader {
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
}
