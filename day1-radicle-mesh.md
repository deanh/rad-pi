# Day 1: Stand Up the Radicle Mesh

## Goal
Three DigitalOcean droplets running Radicle + Pi agent nodes in a private network, with a shared test repository propagating issues and patches across all nodes.

## Infrastructure Setup

### 1. Create the VPC
In the DO console: **Networking → VPC → Create VPC**.
- Name: `radicle-lab`
- Region: Pick one (e.g. `nyc1`) — all droplets go here
- IP range: use the default (e.g. `10.124.0.0/20`)

### 2. Provision Three Droplets
Create three droplets in the `radicle-lab` VPC. Use the DO API or console:

| Node | Hostname | Role | Size |
|------|----------|------|------|
| N1 | `rad-orchestrator` | Seed node, human seat | s-2vcpu-4gb ($24/mo) |
| N2 | `rad-worker-1` | Agent worker | s-2vcpu-4gb ($24/mo) |
| N3 | `rad-worker-2` | Agent worker | s-2vcpu-4gb ($24/mo) |

- **Image:** Ubuntu 24.04
- **Auth:** SSH key (same key for all three, simplifies hopping)
- **VPC:** `radicle-lab`
- **Enable monitoring** for resource visibility

### 3. Basic Hardening (all three nodes)
```bash
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

## Bootstrap All Three Nodes

Run the bootstrap script on each node:

```bash
# Copy the script to each node, or host it and curl it
./bootstrap-rad-agent.sh --alias rad-orchestrator  # on N1
./bootstrap-rad-agent.sh --alias rad-worker-1      # on N2
./bootstrap-rad-agent.sh --alias rad-worker-2      # on N3
```

This installs Radicle, rad-plan, rad-context, Pi, and the Radicle skills/extensions. It also creates a Radicle identity on each node.

Set the LLM API key on each node:
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.bashrc
```

Record each node's **Node ID (NID)**:
```bash
rad self
# Note the NID (starts with z6Mk...)
```

## Create the Test Repository (N1 only)

```bash
mkdir ~/lab-project && cd ~/lab-project
git init
echo "# Multiplayer Agent Lab" > README.md
git add . && git commit -m "init"
rad init --name "multiplayer-lab" --description "Testing distributed agentic workflows"
```

Record the **Repository ID (RID)** from the output (starts with `rad:`).

## Start Nodes & Connect the Mesh

### Start the Radicle node on all three:
```bash
rad node start
```

### Connect N2 and N3 to N1:
On N2 and N3, connect to N1 using its **private VPC IP** and NID:
```bash
rad node connect <N1_NID>@<N1_PRIVATE_IP>:8776
```

### Seed the repo from N2 and N3:
```bash
rad seed <RID>
# Wait a moment for sync
rad ls  # Should show multiplayer-lab
```

## Verify Gossip Propagation

### Test 1: Issue propagation
On **N1**:
```bash
cd ~/lab-project
rad issue open --title "Test issue: verify mesh propagation" \
  --description "If you can read this on N2 and N3, gossip works."
```

On **N2** and **N3**:
```bash
rad issue list --rid <RID>
# Should show the test issue
```

### Test 2: Patch propagation
On **N2**, clone and submit a patch:
```bash
rad clone <RID>
cd lab-project
echo "N2 was here" >> README.md
git add . && git commit -m "N2 contribution"
git push rad HEAD:refs/patches
```

On **N1**:
```bash
rad patch list
# Should show N2's patch
```

### Test 3: Pi + Radicle smoke test
On **N2**:
```bash
cd ~/lab-project
pi -p "List open Radicle issues using rad issue list"
```

Pi should invoke the rad CLI via bash and return the test issue.

## Checkpoint

Before moving to Day 2, confirm:

- [ ] All three nodes bootstrapped cleanly (rad, rad-plan, rad-context, pi all present)
- [ ] All three nodes are running and connected (`rad node status`)
- [ ] Repository is seeded on all three nodes
- [ ] Issues created on any node appear on all others
- [ ] Patches submitted from a worker appear on the orchestrator
- [ ] Pi can invoke rad commands on a worker node
- [ ] Note the convergence time for each propagation test (seconds? minutes?)

Record the private IPs, NIDs, and RID somewhere accessible — you'll need them tomorrow.
