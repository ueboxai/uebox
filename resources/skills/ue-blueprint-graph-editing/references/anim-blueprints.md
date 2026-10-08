# Animation Blueprints: AnimGraph, state machines, transition rules

## Contents

- One tool set, addressed by path
- Creating the asset
- Pose graphs: AnimGraph, inside a state, an animation layer
- The state machine page
- Transition rules
- Reading back and rewriting
- When something goes wrong

## One tool set, addressed by path

An Animation Blueprint is a book of nested pages, and every page is written with the same
`blueprint_apply_graph` and read with the same `blueprint_get_graph`. `graph_name` takes the
page's path:

| graph_name | the page |
|---|---|
| `AnimGraph` | the pose pipeline that ends in Output Pose |
| `AnimGraph/Locomotion` | the state machine named Locomotion |
| `AnimGraph/Locomotion/Idle` | inside the Idle state |
| `AnimGraph/Locomotion/Idle->Walk` | the rule for Idle → Walk |
| `AnimGraph/Locomotion/Idle->Walk/CustomBlend` | that transition's custom blend (only when its LogicType is `TLT_Custom`) |

`blueprint_describe` lists every page by path. Every write and read reports the path of what
it made (`sub_graph` on a StateMachine node or a state, `rule_graph` on a transition) — that
is where you write next. The event graph (`EventGraph`) is an ordinary Blueprint graph: that
is where Speed / IsInAir variables get updated from the pawn.

## Creating the asset

```
blueprint_create { name: "ABP_Hero", parent_class: "AnimInstance", skeleton: "SK_Mannequin" }
```

`skeleton` is a Skeleton or a Skeletal Mesh using it, by path or name. Without it the call
fails and lists the project's skeletons. Every animation you put in this Blueprint must be
for that skeleton.

## Pose graphs: AnimGraph, inside a state, an animation layer

Nodes connect pose to pose. A node's pose output is `Pose`; the page's own output is
`OutputPose` (already on every page — you reuse it, you never create one) and its input is
`Result`.

```json
{
  "blueprint_path": "/Game/ABP_Hero",
  "graph_name": "AnimGraph",
  "nodes": [
    { "id": "loco", "class": "StateMachine", "member_name": "Locomotion" },
    { "id": "slot", "class": "Slot", "settings": { "SlotName": "DefaultSlot" } },
    { "id": "out", "class": "OutputPose" }
  ],
  "connections": [
    { "from": "loco.Pose", "to": "slot.Source" },
    { "from": "slot.Pose", "to": "out.Result" }
  ]
}
```

| class | member_name |
|---|---|
| `SequencePlayer`, `SequenceEvaluator`, `BlendSpacePlayer`, `BlendSpaceEvaluator`, `AimOffset` | the animation asset (path or name) |
| `StateMachine` | its name — an existing state machine with that name is reused, never rebuilt |
| `SaveCachedPose` / `UseCachedPose` | the cache name |
| `BlendPosesByEnum` | the enum; one input per entry is added |
| `BlendPosesByBool`, `BlendPosesByInt`, `LayeredBlendPerBone`, `TwoWayBlend`, `Slot`, `Inertialization`, … | none |

Any other animation node is its class name without `AnimGraphNode_` (`TwoBoneIK`,
`ModifyBone`, `LinkedAnimLayer`). `blueprint_search_nodes` with `blueprint_path` returns them
under `anim_nodes`, each with the fields its `settings` accepts.

**`settings`** holds what the details panel shows, by property name:
`{ "PlayRate": 1.2, "bLoopAnimation": false }`, `{ "LayerSetup": [{ "BranchFilters": [{ "BoneName": "spine_01", "BlendDepth": 0 }] }] }`.
A setting whose pin is showing goes on the pin.

**Hidden pins appear when you use them.** Wire to `PlayRate` on a SequencePlayer, or to
`BlendPose_3` on a BlendPosesByInt that has two inputs, and the pin is exposed or the inputs
are added — the same as ticking "expose as pin" or "add pin" in the editor. Driving a node
from a variable is just a connection from a `VariableGet`.

## The state machine page

States are nodes, a connection is a transition. Nothing else goes on this page.

```json
{
  "blueprint_path": "/Game/ABP_Hero",
  "graph_name": "AnimGraph/Locomotion",
  "nodes": [
    { "id": "idle", "class": "State", "member_name": "Idle" },
    { "id": "walk", "class": "State", "member_name": "Walk" },
    { "id": "air", "class": "Conduit", "member_name": "ToAir" }
  ],
  "connections": [
    { "from": "Entry", "to": "idle" },
    { "from": "idle", "to": "walk", "settings": { "CrossfadeDuration": 0.15 } },
    { "from": "walk", "to": "idle" }
  ]
}
```

- `class` is `State`, `Conduit` or `StateAlias`. `member_name` is the name and is required.
  A state that already has that name is reused — so resending a page never duplicates it.
- A connection end is an id from this call, an existing state's name, or `Entry` (where the
  machine starts).
- A transition between two states that are already connected is updated in place, not added
  again. Its `settings`: `CrossfadeDuration`, `BlendMode`, `PriorityOrder`, `LogicType`,
  `bAutomaticRuleBasedOnSequencePlayerInState` (leave when the animation ends — no rule
  needed).
- `StateAlias` takes `aliased_states: ["Walk", "Run"]` or `global_alias: true`.
- `clear_existing` deletes states and transitions you did not mention.

Then write what plays inside each state on its own page (`AnimGraph/Locomotion/Idle`) and
each rule on its own page.

## Transition rules

A rule page is an ordinary Blueprint graph that ends in a bool: wire it into `Result`'s
`bCanEnterTransition`.

```json
{
  "graph_name": "AnimGraph/Locomotion/Idle->Walk",
  "nodes": [
    { "id": "speed", "class": "VariableGet", "member_name": "Speed" },
    { "id": "gt", "class": "Function", "member_name": "KismetMathLibrary.Greater_DoubleDouble",
      "pin_defaults": { "B": "10" } },
    { "id": "res", "class": "Result" }
  ],
  "connections": [
    { "from": "speed.Speed", "to": "gt.A" },
    { "from": "gt.ReturnValue", "to": "res.bCanEnterTransition" }
  ]
}
```

To read how far the animation in the state being left has played, use `TransitionGetter`
with `member_name` one of `TimeRemaining`, `TimeRemainingRatio`, `CurrentTime`,
`CurrentTimeRatio`, `Length`. Its output pin is `Output`. If that state has more than one
animation player, name it: `TimeRemainingRatio:Run_Fwd` (the error lists the choices).
`ElapsedStateTime`, `StateWeight` and `TransitionDuration` need no target;
`BlendWeight:Walk` reads another state's weight.

## Reading back and rewriting

`blueprint_get_graph` returns the same shape you write: animation nodes and states carry
`write_as`, `member_name` and `settings` (only values that differ from the defaults); a state
machine page returns its transitions as `connections` with their `settings` and `rule_graph`.
Edit and send it back. Settings you leave out return to their defaults.

## When something goes wrong

- **Every write is all-or-nothing**, state machine pages included. On failure nothing changed;
  fix the listed errors and resend the whole set.
- **"Graph not found"** names the level where the path broke and lists what is there.
- **A node that "cannot go" on a page**: animation nodes go in AnimGraph, inside a state or in
  a layer; `SaveCachedPose` only in the top-level AnimGraph; a transition rule takes Blueprint
  nodes and `TransitionGetter`, not poses.
- **Compile diagnostics** carry `graph` — the page the problem is on — next to your node id.
  "will never be taken" means that transition's rule page has nothing wired to
  `bCanEnterTransition` yet.
