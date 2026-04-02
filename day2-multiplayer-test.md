# Day 2: Run the Multiplayer Test

## Goal
Run an end-to-end multiplayer coding task using the bootstrapped nodes: one issue, two agents, two patches, shared context via Radicle.

## Prerequisites
- Day 1 complete: three bootstrapped nodes, Radicle mesh verified, repo seeded everywhere
- LLM API keys set on all nodes
- Private IPs, NIDs, and RID recorded

## Verify Tooling

Quick sanity check on each worker (N2, N3). The bootstrap already installed everything, so this is just confirmation:

```bash
cd ~/lab-project
pi -p "Run: rad issue list && rad-plan --help && rad-context --help. Report what you see."
```

If anything is missing, re-run `bootstrap-rad-agent.sh`.

## Set Up the Project (N1)

### Add AGENTS.md to the repo
The rad-pi package includes project templates. Create one for the lab project:

```bash
cd ~/lab-project
pi -p "Create an AGENTS.md for this project. It uses Radicle for distributed
  collaboration. Agents should use rad CLI for issues and patches, and log
  decisions as issue comments."
git add AGENTS.md && git commit -m "add AGENTS.md for Pi"
git push rad
```

### Create the parent issue

```bash
rad issue open \
  --title "Build a CLI greeting tool" \
  --description "Create a Node.js CLI tool with two components:
    1. A greeting module (src/greet.js) — exports a greet(name) function
    2. A CLI entry point (src/cli.js) — parses args and calls the greeter
    Subtasks assigned to separate agents."
```

### Create subtask issues

```bash
mkdir -p src
echo '{}' > package.json
git add . && git commit -m "add project skeleton"
git push rad

rad issue open \
  --title "Subtask A: Create greeting module" \
  --description "Create src/greet.js that exports a greet(name) function.
    Returns a greeting string. Include at least 3 variations.
    Parent: <PARENT_ISSUE_ID>"

rad issue open \
  --title "Subtask B: Create CLI entry point" \
  --description "Create src/cli.js that parses a --name argument and calls
    greet() from src/greet.js. Print result to stdout.
    Parent: <PARENT_ISSUE_ID>"
```

## Dispatch Work to Agents

From N1, SSH to each worker and kick off Pi in print mode:

**N2 — Subtask A:**
```bash
ssh radlab@<N2_PRIVATE_IP> "cd ~/lab-project && pi -p '
  Read Radicle issue <SUBTASK_A_ID> with: rad issue show <SUBTASK_A_ID>
  Implement what it asks. Commit your changes.
  Log your design decisions as a comment:
    rad issue comment <SUBTASK_A_ID> --message \"<your decisions>\"
  Submit your work as a patch: git push rad HEAD:refs/patches
'"
```

**N3 — Subtask B:**
```bash
ssh radlab@<N3_PRIVATE_IP> "cd ~/lab-project && pi -p '
  Read Radicle issue <SUBTASK_B_ID> with: rad issue show <SUBTASK_B_ID>
  Implement what it asks. Commit your changes.
  Log your design decisions as a comment:
    rad issue comment <SUBTASK_B_ID> --message \"<your decisions>\"
  Submit your work as a patch: git push rad HEAD:refs/patches
'"
```

For longer tasks where you want to watch or steer, SSH in and run interactively:
```bash
ssh radlab@<N2_PRIVATE_IP>
cd ~/lab-project
pi "Pick up Radicle issue <SUBTASK_A_ID> and implement it..."
```

## Observe

While agents work, monitor from N1:

```bash
# Watch for incoming patches
watch -n 10 'rad patch list'

# Watch for issue comments (decision logs from agents)
rad issue show <SUBTASK_A_ID>
rad issue show <SUBTASK_B_ID>

# Check node connectivity
rad node status
```

**What to pay attention to:**
- Do agent decision-log comments propagate to N1 in near-real-time?
- Can N3 see N2's issue comments while working (and vice versa)?
- Do patches arrive cleanly on the orchestrator?
- Any merge conflicts between the two patches?

## Review and Merge (N1)

```bash
rad patch show <PATCH_A_ID>
rad patch show <PATCH_B_ID>

# Check out and test
rad patch checkout <PATCH_A_ID>
# inspect, run, verify

rad patch checkout <PATCH_B_ID>
# inspect, run, verify

# Merge as delegate
rad patch merge <PATCH_A_ID>
rad patch merge <PATCH_B_ID>
```

## Checkpoint & Observations

Record findings against the hypothesis:

- [ ] **Peer isolation:** Agents submitted independent patches without conflicts
- [ ] **COBs as shared context:** Issue comments served as decision logs visible across nodes
- [ ] **Gossip latency:** Time from comment/patch creation to visibility on other nodes: ___
- [ ] **Agent autonomy:** How much hand-holding did Pi need beyond the initial prompt?
- [ ] **Print mode viability:** Did `-p` mode complete the task, or do longer tasks need interactive?
- [ ] **Bootstrap reliability:** Did all nodes come up identically from the script?
- [ ] **Failure modes:** What broke?

## What's Next

With the basic loop validated:
- **Context COB:** Use rad-context for structured learnings beyond issue comments
- **Plan COB:** Use rad-plan to break down issues into tracked implementation plans
- **Auto-assignment:** Cron or loop that polls `rad issue list` and dispatches Pi via print/RPC
- **RPC orchestrator:** Use Pi's SDK from N1 to programmatically spawn and monitor worker sessions
- **Delegate consensus:** Configure multiple delegates, test automated patch evaluation
- **Scale:** More workers, more parallel subtasks
- **Cross-region:** Workers in different DO regions, measure gossip under real latency
- **Ephemeral nodes:** Script that provisions a DO droplet, runs bootstrap, does work, tears down

## Cost Notes

Infrastructure: ~$72/mo for three droplets. LLM API: ~$30-50/day active testing with Sonnet; much less with Haiku on workers. Tear down when not testing or snapshot and restore.
