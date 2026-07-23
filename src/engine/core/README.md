# core / render / behavior - graph engine + backends

A `three`-independent node graph and compiler, split so an external editor can
reuse the engine for particle materials **and** for VFX meshes. Nothing in `core/`
imports `three`; host-specific concerns live in the backend layers.

## Layout

- **`core/`** - the backend-agnostic engine.
  - `socket/` - the type system (`FXValueType`) and port descriptors
    (`FXSocketSpec`, `FXSocketRef`).
  - `ir/` - the shared expression IR (`FXExpr`, `FXExprBuilder`) and its builtin
    function table.
  - `nodes/` - `defineNode`, the declarative node-definition helper shared by
    both backends, plus the param/socket spec types.
  - `FXGraphNode` - base node parameterized by its compiler context
    (`FXGraphNode<TContext>`): typed input/output sockets + `build(context)`. No
    render or behavior concepts on the base.
  - `FXGraph` - pure structure: nodes by id, connections, output-slot bindings.
    Editor-is-master: whole snapshots come in via `ingest`; no edit verbs.
  - `compiler/` - shared machinery both backends reuse: `FXCompilerContext`
    (the only API a node sees), `FXGraphTraversal` (reachability + topo-sort),
    `FXValidation`, `FXStructuralHash` (the recompile gate),
    `collectAttributeRequests`/`collectLightingRequirements`/`collectGraphStats`
    (cross-cutting graph queries), `placement`/`targetLint` (behavior-phase
    placement rules).
  - `codegen/` - backend-agnostic passes both emitters share: common-subexpression
    elimination, scalarization, unique-name allocation, and the GLSL/JS printers.
  - `live/` - the live-editing orchestrator. `FXLiveGraph` decides per snapshot,
    via the structural-hash gate, whether to rebind values, recompile, or hold
    the last-good artifact; `FXGraphReconciler`/`FXNodeRegistry` handle instance
    reconciliation and deserializing a snapshot into live node instances;
    `FXLiveBackend`/`FXTargetLiveBackend` are the seam each concrete backend
    implements.

- **`render/`** - the GLSL render backend. `FXRenderNode`/`FXShaderStage`,
  `compiler/` (`FXRenderContext`, `FXCompiledShader` IR,
  `FXCompilePipeline`/`FXCompiler`), `target/` (`FXTarget` + the two concrete
  render targets, `FX_PARTICLE_TARGET` and `FX_MESH_TARGET`), `nodes/`
  (concrete render nodes, three-coupled), `live/FXRenderLiveBackend`. Material
  construction itself (a three `ShaderMaterial` built from the compiled GLSL)
  lives outside this repo, in the `sparcoon` runtime package.

- **`behavior/`** - the CPU behavior backend. `FXBehaviorNode`/`FXBehaviorPhase`,
  kernel-compile machinery (`FXKernelContext`, `FXKernelBuild`,
  `FXKernelValidation`, `FXKernelTargetSignature`/`Validation`),
  `FXCompiledKernel` (IR), `FXParticleBehaviorTarget` (spawn + update targets),
  `FXParticleBehaviorKernel` (SSA -> a JS function via `new Function`),
  `live/FXBehaviorLiveBackend`. The compiled kernel functions are handed to the
  runtime's simulation holder (`FXSimulationHolder`, in `sparcoon`), not driven
  by anything in this package.

- **`nodes-std/`** - the standard node library built on `defineNode`: `shared/`
  (constant/math/color/curve-bake/noise, usable from either backend),
  `behavior/` (spawn, integrate, forces, collision), `render/` (content,
  effects, lighting, matrix, transform, source). `index.ts` aggregates all of
  it into the registry the editor's palette and the live node registry build
  from.

- **`builder/`** - `FXGraphBuilder`, a fluent, programmatic API for
  constructing a graph in the same wire format (`FXGraphSnapshotData`) the
  editor emits. Used by tests and tooling; the editor itself always goes
  through a snapshot.

- **`emit/`** - two siblings that both compile a render + behavior graph pair:
  `compileToArtifacts` produces in-memory artifact objects (real `new
Function` kernels) for the editor's live preview, and `emitEffectModule`
  serializes the same compiled output to an ESM module string for shipping.

## Boundary

```
FXGraph -+- render:   FXCompiler      --> FXCompiledShader --> GLSL strings  --\
         +- behavior: compileBehavior --> FXCompiledKernel --> JS kernel src --+--> emit/ --> artifact JSON
```

Both backends share `core/` traversal, validation, codegen and the structural
hash; they differ only in context, IR shape and what they emit (GLSL strings
vs. JS kernel source over the packed particle state). This is why
`stage`/`phase` live on the backend node bases, not on `FXGraphNode`. `emit/`
assembles both sides' output into the artifact JSON the runtime package
(`sparcoon`) consumes.

## Status

Working end-to-end and covered by the `tests/` suite (`core/`, `render/`,
`behavior/`, `nodes/`, `builder/`). The live-editing orchestrator (snapshot ->
hash-gate -> rebind/recompile/hold, with a node registry for snapshot
deserialization) is implemented. `nodes-std/` is a real standard library now,
not the small initial set this doc used to describe: render nodes cover
content, effects, lighting (incl. Lambert/ambient shading), matrix, transform
and source; behavior nodes cover spawn, integrate, forces and collision.
