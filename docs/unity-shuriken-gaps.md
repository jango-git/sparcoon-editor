# Unity Shuriken: what Sparcoon does not cover yet

Notes from a study of importing Unity particle effects into Sparcoon projects. The motivation:
effects for mobile ads often arrive from clients as Unity assets, and converting them beats
rebuilding them by hand.

The study targets **Shuriken** (`ParticleSystem` components in `.prefab` / `.unity` files). Mobile
games rarely use VFX Graph, since it needs compute shaders, so VFX Graph import is out of scope.

Nothing here is implemented or scheduled. It is a map of the gaps, kept so the next decision starts
from it.

## Coverage in short

Most of Shuriken maps onto the existing node library:

- **Main:** start values, MinMaxCurve and gradient modes, duration, looping, delay, gravity,
  simulation space and scaling.
- **Emission:** constant rate, bursts, Rate over Distance (a Play event counted over distance;
  with Rate over Time as well, two Play events).
- **Shape:** the primitive shapes, and arc and direction through math.
- **Over-lifetime and by-speed modules**, plus inherit velocity and custom data.
- **Interaction:** plane and primitive collisions, death sub-emitters.
- **Texture Sheet Animation:** frame over time, start frame, random row, blending.
- **Trails** in particle mode.
- **Renderer modes:** billboard, stretched, horizontal, vertical, mesh, pivot, sorting, shadows.
- **Standard particle shaders:** alpha, additive, premultiplied, cutout, lit, soft particles.
- **The prefab:** its hierarchy and its animated transforms and parameters.

Velocity is not a builtin: it is a particle attribute the author declares, and forces take it in
and give it back (`gravity`, `drag`, `turbulence`). A converter writes it the same way.

What is left is listed below, grouped by what closing it would take.

## Gaps that need runtime, sink or render-type work

These cannot be closed by a converter template or a new node.

| Unity feature | What is missing |
|---|---|
| Sub Emitters: **birth**, **collision**, **trigger**, **manual** | Only death reactions exist. |
| Sub Emitters: **inherit** color / size / rotation / lifetime | A spawn origin carries only position and velocity. |
| Collision **Lifetime Loss** | The update can only kill (`kill`, e.g. from a collider's `contact`), not shorten a life. |
| **Triggers** | Only the kill action: a graph can kill a particle inside or outside a volume, nothing else. |
| Burst **probability** | Not supported. |
| Shape **Mesh / Skinned Mesh / Sprite** | No spawning from a mesh surface. |
| Shape **Texture** (color or discard by texture at spawn) | Behavior graphs do not sample textures. |
| Trails **Ribbon mode** | A new render type (see below). |
| Trails **texture mode** Tile / Distribute per Segment / Repeat per Segment | The trail graph has no trail length in world units and no segment index. |
| Trails **Generate Lighting Data** | Lighting nodes are not offered in trail graphs. |
| **Multiply / Subtractive** framebuffer blending | Render modes go only from over to additive. |
| Renderer **Sprite Masking** | Not supported. |
| **Lights** module, **Distortion** shaders | Out of Sparcoon's scope by design: the host owns lights and post-processing. |

### Ribbon trails

**Particle mode (what Sparcoon has).** Every particle drags its own trail made of its recorded past
positions. Those points never move after recording.

**Ribbon mode.** There are no per-particle trails. One ribbon runs through all live particles of the
system in birth order, so every vertex is a live particle:

- the vertex moves under forces and noise;
- it has its own color and width;
- it dies on its own.

Options:

- **Ribbon Count** splits the particles round-robin into N ribbons.
- **Split Sub Emitter Ribbons** gives each sub-emitter instance its own ribbon.
- **Attach Ribbons to Transform** pins the start of the ribbon to the emitter.

**Typical uses:** lightning, beams, magic streams, ropes, sword swooshes.

**Today:**

- A swoosh is approximated by one long-lived particle that follows the emitter (`world-matrix` in
  the update) with a regular trail.
- A ribbon whose points move on their own (lightning, a wiggling beam) cannot be built.

**A possible implementation.** The capacity ring stores particles in birth order, so neighbouring
slots are neighbours in age.

- **Segments.** Segment *i* joins particles *i* and *i+1*: a camera-facing quad built in the vertex
  shader from the two positions.
- **Breaks.** The ribbon breaks at dead slots and at the seam between the youngest and the oldest
  particle.
- **Ribbon Count.** It becomes a stride of N slots.
- **GPU path.** It needs the neighbour's position from the particle buffer, through a texture or an
  offset attribute.
- **Size.** It is comparable to the existing trail, without the history recording.

## Small additions that change existing nodes

Each one is a parameter, an input or an output on an existing node. Each is cheap when it is used,
but has a trap that would make every existing graph pay for it. **The rule:** with the feature off,
the compiled code of the existing presets must stay byte-identical, which a snapshot test can pin
down.

| Addition | What it gives | The trap and how to avoid it |
|---|---|---|
| **Arc** on `spawn-disc`, `spawn-cone`, `spawn-torus`, `spawn-cylinder` (structural param) | Shape arc. | The Random mode is free. Loop, Ping-Pong and Burst Spread need new spawn data (index within the burst, burst size, emission time) in the spawn ABI. Hand it over only to graphs that read it, the way `lightingIntrinsics` and `sceneDepth` work, or ship Random first. |
| **Hemisphere** flag on `spawn-sphere` | Hemisphere shape. | None: a structural flag, so off means the same code. |
| **Normal** output on the `spawn-*` shapes | Align to Direction. Randomize and Spherize Direction then follow with `mix`. | A node outputs all of its outputs. If the normal goes through `local()` and is always printed, every existing spawn shape gets more expensive, worst of all surface `spawn-box`, whose face choice the normal shares. Build it as a lazy expression that is printed only when the output is wired. |
| **Min / Max** inputs on `random` (defaults 0 / 1) | Unity's "Random Between Two Constants" in one node. | `random` is in almost every preset. Plain literal defaults put `mix(0, 1, r)` in every JS kernel. At the defaults the node must emit the bare `r` at build time. |
| **Screen Size Clamp** (new render node) | Renderer Min / Max Particle Size. Nothing else can build this today: no node gives the projection or the viewport size. | It needs a viewport-size uniform. Updating that uniform in every material every frame would charge every effect, so make it an artifact capability like `sceneDepth`, present only when the graph uses the node. |

## Closed with existing nodes (no new node)

These looked like gaps at first. A converter template covers each of them.

| Unity feature | Existing nodes |
|---|---|
| Shape **Edge** | `spawn-box` in volume mode with size `(L, 0, 0)`, or `spawn-cylinder` with radius 0 and the right `axis`. |
| Shape **Rectangle** | `spawn-box` with one zero size. |
| Renderer **Flip** | `random` stored into an attribute, read in render with `custom-attribute`, into `tile-uv` with tiles −1 and offset 1. |
| **Limit Velocity** | `drag` for damping. The speed clamp is `normalize(v) * min(length(v), max)`. If anything, a generic vector Clamp Length operation is missing, not a velocity-specific node. |
| **Color / Size / Rotation by Speed** | `length` of the velocity attribute, then `remap`, then `ramp` / `color-ramp`. |
| **Camera Fading** | `camera-distance` + `smoothstep`. |
| **External Forces** (Wind Zone) | `gravity` + `turbulence`, with the pulse from `time` + `sin`. A dedicated wind node would merge three responsibilities. |

## Approximations a converter has to live with

- **Noise** module: `turbulence`, `curl-noise` and `noise` give the same character and parameters,
  but not Unity's exact pattern.
- **Prewarm**: available as `prewarm()` in the runtime API, not stored in a project.
- **Rate over Time as a curve**: split into consecutive Play events.
- **Several meshes with weights** in the Renderer: split into one emitter per mesh.
- **Sort modes** Oldest / Youngest First: only distance sorting exists, CPU only and not with a
  trail.
- **Sorting Fudge, Order in Layer**: the host's `renderOrder`.
- **Trail Minimum Vertex Distance**: trails record by time (Point Interval).
- **World collision**: only primitive colliders, when the scene's colliders are known.
- **Texture Sheet Sprites mode**: an atlas on the runtime side plus `flipbook-frame`.
- **Bloom**: Unity effects are often tuned for HDR bloom, which is the host's job. Mobile games use
  it less, so additive particles stay close.
