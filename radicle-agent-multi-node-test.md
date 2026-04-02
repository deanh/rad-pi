# **Phase 1: Stand Up the Radicle Mesh**

## **Goal**

Three DigitalOcean droplets running Radicle nodes in a private network, with a shared test repository propagating issues and patches across all nodes.

## **Infrastructure Setup**

### **1\. Create the VPC**

In the DO console: **Networking → VPC → Create VPC**.

* Name: `radicle-lab`  
* Region: Pick one (e.g. `nyc1`) — all droplets go here  
* IP range: use the default (e.g. `10.124.0.0/20`)

### **2\. Provision Three Droplets**

Create three droplets in the `radicle-lab` VPC. Use the DO API or console:

| Node | Hostname | Role | Size |
| ----- | ----- | ----- | ----- |
| N1 | `rad-orchestrator` | Seed node, human seat | s-2vcpu-4gb ($24/mo) |
| N2 | `rad-worker-1` | Agent worker | s-2vcpu-4gb ($24/mo) |
| N3 | `rad-worker-2` | Agent worker | s-2vcpu-4gb ($24/mo) |

* **Image:** Ubuntu 24.04  
* **Auth:** SSH key (same key for all three, simplifies hopping)  
* **VPC:** `radicle-lab`  
* **Enable monitoring** for resource visibility

### **3\. Basic Hardening (all three nodes)**

```shell
# Run on each droplet after SSH in as root
apt update && apt upgrade -y
adduser radlab --disabled-password
usermod -aG sudo radlab
cp -r /root/.ssh /home/radlab/.ssh
chown -R radlab:radlab /home/radlab/.ssh

# Firewall: allow SSH + Radicle gossip (8776) from VPC only
ufw allow OpenSSH
ufw allow from 10.124.0.0/20 to any port 8776
ufw enable
```

From here on, work as `radlab` user.

## **Bootstrap All Three Nodes**

Before configuring the mesh, run `bootstrap-rad-agent.sh` on each node to install the full stack (Radicle, rad-plan, rad-context, Pi agent, rad-pi package).

**Pre-flight:** Edit `bootstrap-rad-agent.sh` and set the `RAD_PLAN_REPO` and `RAD_CONTEXT_REPO` variables to their real Git URLs before distributing.

Copy the script to each droplet and run:

```shell
# From your local machine:
scp bootstrap-rad-agent.sh radlab@<DROPLET_IP>:~/

# Then SSH in and run:
chmod +x bootstrap-rad-agent.sh
./bootstrap-rad-agent.sh --alias rad-orchestrator   # on N1
./bootstrap-rad-agent.sh --alias rad-worker-1       # on N2
./bootstrap-rad-agent.sh --alias rad-worker-2       # on N3
```

The script installs:
- **Radicle** — `rad` CLI and node
- **rad-plan / rad-context** — custom COB types for plans and session learnings
- **Pi agent** — `@mariozechner/pi-coding-agent` (installed globally via npm)
- **rad-pi** — Radicle skills and extensions for Pi (installed via `pi install rad-pi`)

It also creates the Radicle identity and records the Node ID (NID).

Verify on each node: `rad --version && rad self && pi --version`

Record each node's **Node ID (NID)** — you'll need all three.

## **Start Nodes & Connect the Mesh**

### **Start the Radicle node on all three:**

```shell
rad node start
```

### **Connect N2 and N3 to N1:**

On N2 and N3, connect to N1 using its **private VPC IP** and NID:

```shell
rad node connect <N1_NID>@<N1_PRIVATE_IP>:8776
```

## **Create the Test Repository (N1 only)**

With the mesh live, create the repo so it can immediately propagate:

```shell
mkdir ~/lab-project && cd ~/lab-project
git init
echo "# Multiplayer Agent Lab" > README.md
git add . && git commit -m "init"
rad init --name "multiplayer-lab" --description "Testing distributed agentic workflows"
```

Record the **Repository ID (RID)** from the output (starts with `rad:`).

### **Seed the repo from N2 and N3:**

```shell
rad seed <RID>
# Wait a moment for sync
rad ls  # Should show multiplayer-lab
```

## **Verify Gossip Propagation**

### **Test 1: Issue propagation**

On **N1**:

```shell
cd ~/lab-project
rad issue open --title "Test issue: verify mesh propagation" \
  --description "If you can read this on N2 and N3, gossip works."
```

On **N2** and **N3**:

```shell
rad issue list --rid <RID>
# Should show the test issue
```

### **Test 2: Patch propagation**

On **N2**, clone and submit a patch:

```shell
rad clone <RID>
cd lab-project
git checkout -b test-n2
echo "N2 was here" >> README.md
git add . && git commit -m "N2 contribution"
git push rad HEAD:refs/patches
```

On **N1**:

```shell
rad patch list
# Should show N2's patch
```

### **Test 3: Comment propagation (shared context)**

On **N3**, comment on the test issue:

```shell
rad issue comment <ISSUE_ID> --message "N3 confirms: mesh is live"
```

Verify comment appears on N1 and N2 via `rad issue show <ISSUE_ID>`.

## **Checkpoint**

Before moving to Phase 2, confirm:

* \[ \] All three nodes are running and connected (`rad node status`)  
* \[ \] Repository is seeded on all three nodes  
* \[ \] Issues created on any node appear on all others  
* \[ \] Patches submitted from a worker appear on the orchestrator  
* \[ \] Comments propagate across all nodes  
* \[ \] Note the convergence time for each test (seconds? minutes?)

Record the private IPs, NIDs, and RID somewhere accessible.

# **Phase 2: Run the Multiplayer Agent Test**

## **Goal**

Use Pi agent with the rad-pi extension (already installed in Phase 1) to run an end-to-end multiplayer coding task: one issue, two agents, two patches, with context COBs capturing agent learnings.

## **Prerequisites**

* Phase 1 complete: three droplets bootstrapped, Radicle mesh verified, repo seeded everywhere  
* Anthropic API key (or alternative provider key)

## **Configure LLM Provider**

On each node, set your API key:

```shell
export ANTHROPIC_API_KEY="sk-ant-..."
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.bashrc
```

**Recommended model allocation:**
- **N1 (orchestrator):** Claude Sonnet — handles planning, review  
- **N2, N3 (workers):** Claude Haiku or a comparable cheaper model — executes scoped subtasks

To select the model on a per-node basis, use the `--model` flag when launching Pi:

```shell
# On N1 (orchestrator)
pi --model claude-sonnet-4-20250514

# On N2/N3 (workers)
pi --model claude-haiku-4-20250514
```

## **Verify Skills**

```shell
# Quick headless check on any node:
cd ~/lab-project
pi -p "List your available skills"
# Should include: radicle, rad-plans, rad-contexts
```

### **Smoke Test**

```shell
# On N2, verify Pi can talk to Radicle:
cd ~/lab-project
pi -p "List open Radicle issues in this repository"
```

The agent should invoke `rad issue list` and return results. If it doesn't, check that the `radlab` user's PATH includes the rad binary and that the Radicle node is running.

## **Set Up the Multiplayer Test**

### **Step 1: Create the task (N1 — orchestrator)**

Create a small but real coding task with two independent subtasks:

```shell
cd ~/lab-project

# Create a simple project skeleton
mkdir -p src
echo '{}' > package.json
git add . && git commit -m "add project skeleton"
git push rad main

# Open the parent issue
rad issue open \
  --title "Build a CLI greeting tool" \
  --description "Create a simple Node.js CLI tool with two components:
    1. A greeting module (src/greet.js) that exports a function
    2. A CLI entry point (src/cli.js) that parses args and calls the greeter
    Subtasks will be assigned to separate agents."
```

Record the issue ID.

### **Step 2: Create subtask issues**

```shell
rad issue open \
  --title "Subtask A: Create greeting module" \
  --description "Create src/greet.js that exports a greet(name) function.
    Returns a greeting string. Include at least 3 greeting variations.
    Parent: <PARENT_ISSUE_ID>"

rad issue open \
  --title "Subtask B: Create CLI entry point" \
  --description "Create src/cli.js that parses a --name argument and calls
    the greet function from src/greet.js. Print result to stdout.
    Parent: <PARENT_ISSUE_ID>"
```

### **Step 3: Assign work to agents**

Kick off both workers from N1 via SSH so they run simultaneously:

```shell
# Terminal 1 — N2 works on Subtask A
ssh radlab@<N2_IP> 'cd ~/lab-project && pi -p "
Pick up Radicle issue <SUBTASK_A_ID> in this repo.
Read the issue description, implement the requested module,
commit your work on a feature branch, and submit a Radicle patch
via git push rad HEAD:refs/patches.
Log your decisions as comments on the issue.
Store key learnings as a context COB using rad-context.
"'

# Terminal 2 — N3 works on Subtask B
ssh radlab@<N3_IP> 'cd ~/lab-project && pi -p "
Pick up Radicle issue <SUBTASK_B_ID> in this repo.
Read the issue description, implement the requested CLI entry point,
commit your work on a feature branch, and submit a Radicle patch
via git push rad HEAD:refs/patches.
Log your decisions as comments on the issue.
Store key learnings as a context COB using rad-context.
"'
```

Alternatively, open the Pi TUI interactively on each worker node to observe the agent in real time:

```shell
# SSH into N2, then:
cd ~/lab-project && pi --model claude-haiku-4-20250514
# Paste the prompt above into the TUI
```

### **Step 4: Observe**

While agents work, monitor from N1:

```shell
# Watch for incoming patches
watch -n 10 'rad patch list'

# Watch for issue comments (decision logs from agents)
rad issue show <SUBTASK_A_ID>
rad issue show <SUBTASK_B_ID>

# Check gossip status
rad node status

# Check for context COBs (agent learnings)
rad-context list
```

**What to pay attention to:**
- Do agent decision-log comments propagate to N1 in near-real-time?  
- Can N3's agent see N2's comments (and vice versa) while working?  
- Do patches arrive cleanly on the orchestrator node?  
- Any merge conflicts between the two patches?  
- Did agents create context COBs with useful learnings?

### **Step 5: Review and merge (N1)**

```shell
# List patches
rad patch list

# Review each patch
rad patch show <PATCH_A_ID>
rad patch show <PATCH_B_ID>

# Checkout and test Patch A
rad patch checkout <PATCH_A_ID>
# inspect, run, verify
git checkout main

# Checkout and test Patch B
rad patch checkout <PATCH_B_ID>
# inspect, run, verify
git checkout main

# Merge Patch A
git checkout main
git merge <PATCH_A_BRANCH>
git push rad main

# Merge Patch B
git merge <PATCH_B_BRANCH>
git push rad main
```

Note: `git push rad main` after merging marks the patch as merged in Radicle and propagates the result across the mesh.

## **Checkpoint & Observations**

Record findings against the hypothesis:

* \[ \] **Peer isolation worked:** Agents submitted independent patches without stepping on each other  
* \[ \] **COBs as shared context:** Issue comments served as decision logs visible across nodes  
* \[ \] **Context COBs:** Agents stored structured learnings via rad-context  
* \[ \] **Gossip latency:** Time from comment/patch creation to visibility on other nodes: \_\_\_  
* \[ \] **Agent autonomy:** How much hand-holding did agents need beyond the initial instruction?  
* \[ \] **Failure modes:** What broke? (skill invocation errors, sync delays, merge conflicts, etc.)

## **What's Next**

With the basic loop validated, the interesting extensions are:
- **Auto-assignment:** Agent heartbeat polls `rad issue list` and self-assigns open subtasks  
- **Plan COBs:** Use rad-plan to break down parent issues into structured implementation plans before assigning subtasks  
- **Delegate consensus:** Configure multiple delegates on the repo and test automated patch evaluation  
- **Scale test:** Add more worker nodes and more parallel subtasks  
- **Cross-region:** Move workers to different DO regions and measure gossip under real latency

## **Cost Notes**

Burn rate during active testing: \~$72/mo infrastructure \+ LLM API costs. To minimize API spend, tear down workers when not testing (`doctl compute droplet delete`) or snapshot and restore. Consider switching workers to DeepSeek or a local model via Ollama on a GPU droplet if API costs become a concern.
