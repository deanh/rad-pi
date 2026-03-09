---
name: radicle
description: This skill should be used when the user asks to "initialize a radicle repo", "rad init", "create a patch", "open a patch", "rad patch", "clone from radicle", "rad clone", "work with radicle issues", "rad issue", "start radicle node", "rad node", "seed a repository", "sync with radicle", "push to radicle", "collaborate on radicle", or mentions RIDs, DIDs, patches, seeding, or peer-to-peer code collaboration.
version: 0.1.0
---

# Radicle Collaboration Skill

Radicle is a decentralized, peer-to-peer code collaboration protocol built on Git. It enables sovereign code hosting without centralized platforms, using cryptographic identities and a gossip-based network for repository distribution.

## Core Concepts

**Repository ID (RID)**: Globally unique URN identifying a repository (e.g., `rad:z31hE1wco9132nedN3mm5qJjyotna`)

**Node ID (NID)**: Device identifier on the network, used for push operations

**DID (Decentralized Identifier)**: Self-sovereign identity (e.g., `did:key:z6Mkhp7VU...`) for authentication

**Delegates**: Maintainers with authority to sign and manage repository metadata

**Seeding**: Hosting and synchronizing a repository across the network

**Patches**: Git-based collaborative objects similar to pull requests, with revision history

## Prerequisites

Before using Radicle commands, verify the installation and identity:

```bash
# Check if rad is installed
rad --version

# Check identity status
rad self

# Check node status
rad node status
```

If `rad` is not installed, direct the user to https://radicle.xyz/install or run:

```bash
curl -sSLf https://radicle.xyz/install | sh
source ~/.zshenv  # Or open a new terminal
```

If no identity exists, create one:

```bash
rad auth

# Non-interactive (for scripting):
echo "" | rad auth --alias "name" --stdin        # No passphrase
echo "pass" | rad auth --alias "name" --stdin    # With passphrase
```

## Repository Management

### Initialize a New Repository

To publish an existing Git repository to Radicle:

```bash
# Initialize (interactive - prompts for name, description, visibility)
rad init

# Initialize with options
rad init --name "project-name" --description "Project description" --public

# Initialize without confirmation prompt
rad init --name "project-name" --description "Description" --public --no-confirm

# Initialize as private repository
rad init --private

# Show current repository's RID
rad .
```

After initialization, push changes with `git push` (the rad remote is configured automatically).

### Clone a Repository

To clone from Radicle:

```bash
# Clone by RID (also starts seeding)
rad clone rad:z31hE1wco9132nedN3mm5qJjyotna

# Clone and specify working directory
rad clone rad:z31hE1wco9132nedN3mm5qJjyotna --path ./project-dir
```

### Seeding

Seeding replicates repositories across the network:

```bash
# Seed a repository (without working copy)
rad seed rad:<RID>

# Stop seeding
rad unseed rad:<RID>

# List seeded repositories
rad ls --seeded
```

### Private Repository Access

For private repositories, manage access via delegates:

```bash
# Grant access to a peer
rad id update --title "Allow access" --allow <DID>

# Revoke access
rad id update --disallow <DID>

# Convert private to public
rad publish
```

## Patch Collaboration

Patches are Radicle's equivalent to pull requests, with built-in revision tracking.

### Create a Patch

To open a new patch, push to the magic ref:

```bash
# Create branch and make changes
git checkout -b feature-branch
# ... make changes and commit ...

# Open patch
git push rad HEAD:refs/patches
```

### Update a Patch

Subsequent pushes update the existing patch with a new revision:

```bash
# Add more commits to the branch
git commit -m "Address review feedback"

# Update the patch (creates new revision)
git push --force
```

### Review Patches

```bash
# List all patches
rad patch list

# Show patch details with revision history
rad patch show <PATCH_ID>

# View patch diff without checkout
rad patch diff <PATCH_ID>

# Checkout patch branch for local testing
rad patch checkout <PATCH_ID>
```

### Merge a Patch

After review, merge into the main branch:

```bash
# Checkout and merge
git checkout main
git merge <patch-branch>

# Push to mark patch as merged
git push rad main
```

## Issue Tracking

Issues are collaborative objects stored in Git, synchronized across the network.

### Create Issues

```bash
# Open new issue (launches editor)
rad issue open

# Open with title directly
rad issue open --title "Bug: login fails on mobile"
```

### Manage Issues

```bash
# List issues
rad issue list

# Show issue details
rad issue show <ISSUE_ID>

# Add comment
rad issue comment <ISSUE_ID>

# Assign to a peer
rad issue assign <ISSUE_ID> --add <DID>

# Close issue
rad issue state <ISSUE_ID> --closed

# Reopen issue
rad issue state <ISSUE_ID> --open
```

### Label Issues

```bash
# Add label
rad issue label <ISSUE_ID> --add bug

# Remove label
rad issue label <ISSUE_ID> --remove bug
```

## Node Operations

The Radicle node handles peer-to-peer networking and repository synchronization.

### Node Lifecycle

```bash
# Start node (required for network operations)
rad node start

# Stop node
rad node stop

# Check node status
rad node status
```

### Synchronization

```bash
# Check sync status for current repository
rad sync status

# Force fetch from network
rad sync --fetch

# Sync with specific scope
rad sync --scope all        # All seeded repos
rad sync --scope followed   # Only followed delegates

# Announce local refs to network (after creating/updating repo)
rad sync --announce

# Pull canonical changes to working copy
git pull
```

### Network Connectivity

```bash
# Connect to a specific peer
rad node connect <NID>@<address>

# View notifications (new issues/patches)
rad inbox
```

### Remote Management

Track changes from collaborators:

```bash
# Add a peer's remote
rad remote add <NID> --name alice

# Fetch peer's branches
git fetch alice

# List tracked remotes
rad remote list

# Find untracked peers
rad remote list --untracked
```

## Common Workflows

### Workflow: Contribute to a Project

1. Clone the repository: `rad clone rad:<RID>`
2. Create a feature branch: `git checkout -b my-feature`
3. Make changes and commit
4. Open a patch: `git push rad HEAD:refs/patches`
5. Address feedback and update: `git push --force`

### Workflow: Review and Merge Contributions

1. List open patches: `rad patch list`
2. Review patch: `rad patch show <ID>` or `rad patch checkout <ID>`
3. Test locally if needed
4. Merge: `git checkout main && git merge <branch>`
5. Push to close patch: `git push rad main`

### Workflow: Maintain a Private Project

1. Initialize private: `rad init --private`
2. Grant team access: `rad id update --allow <DID1> --allow <DID2>`
3. Team members clone: `rad clone rad:<RID>`
4. Revoke access when needed: `rad id update --disallow <DID>`

### Workflow: Mirror to GitHub (Optional)

When initializing a Radicle repository that already has a GitHub remote, you can optionally keep both in sync.

**Check for existing GitHub remote:**

```bash
git remote -v | grep github
```

**Manual sync:**

```bash
git push rad main && git push github main
```

**Automatic sync with post-commit hook:**

To auto-push to both Radicle and GitHub after each commit, create `.git/hooks/post-commit`:

```bash
#!/bin/sh
# Auto-push to Radicle and mirror to GitHub after each commit

export PATH="$HOME/.radicle/bin:$PATH"
git push rad main 2>/dev/null || true
git push github main 2>/dev/null || true
```

Make it executable: `chmod +x .git/hooks/post-commit`

**New project without GitHub:**

If starting fresh, you can add GitHub later:

```bash
git remote add github https://github.com/username/repo.git
git push -u github main
```

Note: Radicle remains the source of truth for patches and issues. GitHub serves as a read-only mirror for discoverability.

## Troubleshooting

### Node Not Running

If commands fail with connection errors:

```bash
rad node start
rad node status  # Verify running
```

### Sync Issues

If changes aren't appearing:

```bash
rad sync --fetch
rad sync status
```

### Identity Problems

If authentication fails:

```bash
rad self        # Check current identity
rad auth        # Re-authenticate if needed
```

### Understanding Node Status

The `rad node status` output uses these indicators:

| Symbol | Meaning |
|--------|---------|
| `✓` | Connected |
| `!` | Connection attempted |
| `✗` | Disconnected |
| `↗` | Outbound connection |
| `↘` | Inbound connection |

### NAT and Inbound Connections

"Not configured to listen for inbound connections" is normal for nodes behind NAT/firewall. The node can still:
- Connect outbound to seeds and peers
- Push and pull repositories
- Participate fully in the network

For inbound connections, configure port forwarding or use Tor mode.

## Additional Resources

### Reference Files

For detailed command reference and advanced patterns:

- **`references/commands.md`** - Complete command reference with all flags and options
