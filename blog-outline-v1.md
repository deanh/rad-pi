# Blog Post Outline: Radicle as Agent Infrastructure

**Target audience**: Tech leads / staff+ engineers who work with AI coding agents.
Radicle-curious (heard of it, think it sounds interesting) but not deep users.

**Tone**: Conversational, grounded, no hype. Show the thinking, acknowledge what's early.

**Scope**: Introduces rad-skill and rad-pi. Mentions Plan COBs and Context COBs
enough to explain what the plugins do. Part 2 goes deep on those.

---

## 1. Most agent workflows are single-player

**Core claim**: The current generation of agent tooling assumes one developer,
one machine, N agents, shared filesystem. This works, but has a ceiling.

Points to make:

- Agents are doing real engineering work — not autocomplete. Multi-agent
  parallel execution, planning, code review. This is happening now.
- But the infrastructure is single-player:
  - **Knowledge persistence is ad-hoc**: CLAUDE.md, .cursorrules, .context
    files, local RAG pipelines. Everyone is reinventing session memory as
    markdown checked into git. These are single-machine solutions — they
    don't replicate, they don't have structure, they mix knowledge with code.
  - **Coordination is implicit**: Agents share state via the filesystem.
    Worktree conflicts when running parallel agents. No principled way for
    agent B to know what agent A learned.
  - **Platform APIs weren't designed for this**: GitHub, Linear, etc. are
    human-facing tools with APIs bolted on. You can't extend their object
    model. Your agents coordinate through primitives designed for people
    clicking buttons.
- Question to pose: What would multi-player agent infrastructure look like —
  where peers (people, agents, or both) coordinate through replicated
  primitives, not filesystem conventions?

---

## 2. Radicle for the Radicle-curious

**Goal**: 60-second orientation. Not a tutorial — just enough to understand
what follows.

Points to make:

- Git-native, peer-to-peer code collaboration. Issues, patches, identity —
  all stored as git refs, replicated via gossip. No central server.
- Local-first: you have a full copy of everything. Reads are free.
- **Collaborative Objects (COBs)**: The key primitive for this post.
  - Typed, extensible objects that replicate alongside code
  - CRDTs built on git commits — multiple peers write concurrently, sync is
    a non-destructive union of their commit graphs (deterministic reduction
    in topological/causal order)
  - Three built-in types: issues, patches, identity
  - Custom types via reverse domain notation (e.g., `me.hdh.plan`,
    `me.hdh.context`). The protocol replicates them exactly like built-ins.
- Peers can be people, agents, or people using agents. The protocol doesn't
  distinguish.

---

## 3. Why these primitives fit agent workflows

**Core claim**: Radicle's design decisions — made for decentralized human
collaboration — turn out to map unusually well to agent coordination.

Points to make:

- **Agents already think in git.** COBs are git refs. No translation layer,
  no API tokens, no rate limits. The agent's natural medium.

- **Local-first = no coordination bottleneck.** Every peer has everything.
  Agents don't block on network for state. Compare to: API calls to GitHub
  for every issue read, webhook delivery delays, auth token management.

- **Concurrent writes without coordination.** CRDT semantics mean multiple
  agents can update the same COB in parallel — different worktrees, different
  machines, whatever. Sync resolves it via deterministic graph union. No
  locking, no optimistic concurrency against a server.

- **Extensible object model.** This is the big unlock. You can define COB
  types for concerns that platforms don't support:
  - Plans with task dependencies and file-level conflict tracking
  - Session observations with structured constraints and learnings
  - Whatever your workflow needs — the protocol replicates it
  - Contrast: on GitHub, you'd stuff this into issue metadata, PR
    descriptions, or external databases. None of it replicates.

- **Knowledge as a first-class replicated object.** Not .md files committed
  to the repo. Structured, typed, stored separately from code, replicated
  across peers. What the agent learned — not just what it committed.

---

## 4. The agent as on-ramp

**Core claim**: Agents can lower the barrier to powerful but complex tools.
Radicle is a case study — and this is what led to building the plugins.

Points to make:

- Radicle is powerful but has a learning curve. The CLI is extensive. The
  concepts (RIDs, NIDs, DIDs, delegates, seeding) take time to internalize.
- **Personal anecdote**: "I onboarded to Radicle by building rad-skill —
  I refined the user guide into a skill so I didn't have to remember the
  commands." Honest, relatable, demonstrates the point without overclaiming.
- The skills encode deep CLI and workflow knowledge. The agent absorbs that
  complexity so the developer doesn't have to memorize commands.
- This is a broader pattern worth noting: if agents are good at using a
  tool, the tool's learning curve matters less. The agent becomes the
  interface.
- **Honest acknowledgment**: Radicle's ecosystem is small. This is early.
  But the primitives are genuinely different from what platforms offer, and
  that's worth exploring even at this stage.
- Transition: once the agent understands Radicle, you can build real
  workflows on top of it. That's what we did.

---

## 5. What we built on top

**Goal**: Introduce rad-skill and rad-pi. Show what's possible now that the
agent handles the complexity. Brief — save details for part 2.

### Two plugins, two philosophies

Frame: These aren't wrappers around the same thing. The runtimes are
genuinely different, and that shapes the workflow.

**rad-skill (Claude Code)**
- CC has an opinionated workflow. Its plan -> reflect -> execute cycle is
  deeply baked in (speculatively: this may be reinforced via RL in
  post-training — CC is notably good at this loop).
- rad-skill works *with* that: slash commands that bridge CC's task system
  to Radicle's issues and patches
  - `/rad-import`: Import a Radicle issue, decompose into CC tasks
  - `/rad-sync`: Sync completed tasks back to Radicle (rollup logic —
    issues only close when 100% of linked tasks complete)
  - `/rad-status`: Unified dashboard of repo state
  - `/rad-issue`: Create well-researched issues using specialist agents
  - `/rad-context`: Create/browse Context COBs
- Agents: plan-manager (coordinates dispatch) and worker (executes a single
  task in an isolated worktree)
- Emphasis: meeting the developer inside CC's existing workflow

**rad-pi (pi)**
- pi is more "YOLO-mode" — less opinionated, but gives you programmatic
  hooks and direct runtime control
- TypeScript extensions enable tighter automation:
  - Automatic context extraction on compaction and session shutdown (the
    runtime enforces this, not the model)
  - Full orchestrator engine: worktree lifecycle, worker spawning,
    cherry-picking, file conflict detection, context feedback loops
- Emphasis: building a prescribed, automated pipeline. The runtime enforces
  the workflow rather than relying on the model to follow conventions.
- Fits Radicle's independent philosophy — you control the whole pipeline

**The shared layer**
- Both use the same three skills as knowledge base:
  - `radicle`: Core CLI and workflow knowledge
  - `rad-plans`: Plan COB knowledge
  - `rad-contexts`: Context COB knowledge
- Both coordinate through the same COB types
- Both support the same multi-agent worker protocol

### The core loop (brief)

Import issue -> break into tasks -> work (single-agent or multi-agent
parallel) -> sync results back to Radicle -> knowledge captured in
Context COBs

That's it for this post. Part 2 goes into Plan COBs (intent — what should
happen) and Context COBs (observation — what actually happened, what was
learned).

---

## 6. What's next

- Part 2: Plan COBs and Context COBs in depth
  - Plans capture intent (what should happen, task dependencies, affected
    files)
  - Contexts capture observation (what actually happened, what was learned,
    constraints, friction)
  - How they work together in multi-agent orchestration
- The bigger idea: infrastructure where agent coordination and knowledge are
  first-class replicated objects — not ephemeral session state, not markdown
  in a repo, not locked in a platform

---

## Key phrases / framings to keep handy

- "Single-player vs. multi-player" — the central framing
- "CRDTs built on git commits" — precise COB characterization
- "The protocol doesn't distinguish between people and agents"
- "Knowledge as a first-class replicated object"
- "The agent as on-ramp" — agents absorb tool complexity
- "Structured, typed, separate from code, replicated across peers"
- "What the agent learned, not just what it committed"

## Things to avoid

- "Decentralization good, platforms bad" — this isn't ideological
- Overclaiming on adoption or maturity — be honest about ecosystem size
- Deep technical walkthrough of COB internals — save for part 2
- Making it sound like GitHub can't work — it can, this is about what's
  different and what you gain
- Hype language: "revolutionary", "game-changing", etc.
