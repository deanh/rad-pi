# Day 1: Stand Up the Radicle Mesh (Scaleway)

## Goal
Three Scaleway instances running Radicle + Pi agent nodes in a private network, with a shared test repository propagating issues and patches across all nodes.

## Infrastructure Setup

### 1. Create the VPC and Private Network
In the Scaleway console: **Network → VPC**.

- Click **Create a VPC**
- Region: `Paris` (or `Amsterdam` / `Warsaw` — pick one, all instances go here)
- Name: `radicle-lab`

Then create a Private Network inside it:
- Click into `radicle-lab` → **Create Private Network**
- Name: `rad-mesh`
- CIDR: use the default (auto-assigned) or set `172.16.0.0/24`

### 2. Provision Three Instances
In the console: **Compute → Instances → Create Instance**.

| Node | Name | Role | Type |
|------|------|------|------|
| N1 | `rad-orchestrator` | Seed node, human seat | DEV1-M (~€14/mo) |
| N2 | `rad-worker-1` | Agent worker | DEV1-M (~€14/mo) |
| N3 | `rad-worker-2` | Agent worker | DEV1-M (~€14/mo) |

For each instance:
- **Availability Zone:** any AZ in your chosen region (e.g. `PAR-1`)
- **Image:** Ubuntu 24.04 (Jammy)
- **Type:** DEV1-M (3 vCPU, 4 GB RAM)
- **Storage:** 20 GB local (default is fine)
- **SSH key:** add your public key
- **Advanced → Private Networks:** attach to `rad-mesh`

Total infrastructure cost: ~€43/mo for three nodes.

### 3. Note the Private Network Addresses
After creation, each instance gets a private IP on `rad-mesh` via DHCP. You can also reach instances by hostname on the private network using Scaleway's built-in DNS:

```
rad-orchestrator.rad-mesh.internal
rad-worker-1.rad-mesh.internal
rad-worker-2.rad-mesh.internal
```

Find private IPs in the console under each instance's **Private Networks** tab, or via:
```bash
ip addr show | grep 172.16
```

### 4. Basic Hardening (all three nodes)
```bash
# SSH in as root
apt update && apt upgrade -y
adduser radlab --disabled-password
usermod -aG sudo radlab
cp -r /root/.ssh /home/radlab/.ssh
chown -R radlab:radlab /home/radlab/.ssh

# Firewall: allow SSH + Radicle gossip (8776) from private network only
ufw allow OpenSSH
ufw allow from 172.16.0.0/24 to any port 8776
ufw enable
```

Adjust the CIDR in the `ufw` rule if your Private Network uses a different range.

From here on, work as `radlab` user.

## Bootstrap All Three Nodes

Run the bootstrap script on each node:

```bash
./bootstrap-rad-agent.sh --alias rad-orchestrator  # on N1
./bootstrap-rad-agent.sh --alias rad-worker-1      # on N2
./bootstrap-rad-agent.sh --alias rad-worker-2      # on N3
```

This installs Radicle, rad-plan, rad-context, Pi, and rad-pi. It also creates a Radicle identity on each node.

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
On N2 and N3, connect to N1 using its private IP (or hostname) and NID:
```bash
rad node connect <N1_NID>@rad-orchestrator.rad-mesh.internal:8776
# or use the IP directly:
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
```

### Test 3: Pi + Radicle smoke test
On **N2**:
```bash
cd ~/lab-project
pi -p "List open Radicle issues using rad issue list"
```

## Checkpoint

Before moving to Day 2, confirm:

- [ ] All three nodes bootstrapped cleanly (rad, rad-plan, rad-context, pi, rad-pi all present)
- [ ] All three nodes are running and connected (`rad node status`)
- [ ] Repository is seeded on all three nodes
- [ ] Issues created on any node appear on all others
- [ ] Patches submitted from a worker appear on the orchestrator
- [ ] Pi can invoke rad commands on a worker node
- [ ] Note the convergence time for each propagation test (seconds? minutes?)

Record the private IPs (or hostnames), NIDs, and RID — you'll need them for Day 2.

Day 2 is cloud-agnostic. Use the same `day2-multiplayer-test.md` runbook, substituting Scaleway private IPs or `*.rad-mesh.internal` hostnames where it references `<N2_PRIVATE_IP>` / `<N3_PRIVATE_IP>`.
