# Radicle Command Reference

Complete reference for all `rad` CLI commands and options.

## Identity Commands

### rad auth

Create or authenticate cryptographic identity.

```bash
rad auth                    # Interactive identity creation
rad auth --alias "myname"   # Set display alias
rad auth --stdin            # Read passphrase from stdin

# Non-interactive examples:
echo "" | rad auth --alias "name" --stdin        # No passphrase
echo "pass" | rad auth --alias "name" --stdin    # With passphrase
RAD_PASSPHRASE="pass" rad auth --alias "name"    # Via environment
```

### rad self

Display current identity information.

```bash
rad self                    # Show DID, NID, alias
rad self --did              # Show only DID
rad self --nid              # Show only Node ID
rad self --home             # Show Radicle home directory
```

## Repository Commands

### rad init

Initialize a Git repository for Radicle.

```bash
rad init                                    # Interactive mode
rad init --name "name"                      # Set repository name
rad init --description "desc"               # Set description
rad init --default-branch main              # Set default branch
rad init --public                           # Public visibility
rad init --private                          # Private visibility
rad init --no-confirm                       # Skip confirmation prompt
```

### rad clone

Clone a repository from the network.

```bash
rad clone rad:<RID>                         # Clone by RID
rad clone rad:<RID> --path ./dir            # Specify directory
rad clone rad:<RID> --no-seed               # Clone without seeding
rad clone rad:<RID> --scope followed        # Limit to followed delegates
rad clone rad:<RID> --scope all             # Include all contributors
```

### rad ls

List repositories.

```bash
rad ls                      # List local repositories
rad ls --seeded             # List seeded repositories
rad ls --all                # List all known repositories
```

### rad .

Show current repository's RID.

```bash
rad .                       # Print RID of current repository
```

### rad seed / rad unseed

Manage repository seeding.

```bash
rad seed rad:<RID>          # Start seeding a repository
rad seed rad:<RID> --scope followed   # Seed with scope
rad unseed rad:<RID>        # Stop seeding
```

### rad publish

Convert private repository to public.

```bash
rad publish                 # Make current repository public
```

## Patch Commands

### rad patch

Work with patches (pull request equivalent).

```bash
# List patches
rad patch list                              # List all patches
rad patch list --state open                 # List open patches
rad patch list --state merged               # List merged patches
rad patch list --state closed               # List closed patches
rad patch list --author <DID>               # Filter by author

# Show patch
rad patch show <PATCH_ID>                   # Show patch details
rad patch show <PATCH_ID> --revision 2      # Show specific revision

# Diff
rad patch diff <PATCH_ID>                   # Show patch diff
rad patch diff <PATCH_ID> --revision 2      # Diff specific revision

# Checkout
rad patch checkout <PATCH_ID>               # Checkout patch branch
rad patch checkout <PATCH_ID> --revision 2  # Checkout specific revision

# Comment
rad patch comment <PATCH_ID>                # Add comment (opens editor)
rad patch comment <PATCH_ID> --message "text"  # Inline comment

# Review
rad patch review <PATCH_ID> --accept        # Accept patch
rad patch review <PATCH_ID> --reject        # Reject patch

# Archive/Unarchive
rad patch archive <PATCH_ID>                # Archive patch
rad patch unarchive <PATCH_ID>              # Unarchive patch
```

### Creating Patches via Git

```bash
# Open new patch (magic ref)
git push rad HEAD:refs/patches

# Update existing patch
git push --force

# Push and set upstream
git push -u rad HEAD:refs/patches
```

## Issue Commands

### rad issue

Manage issues.

```bash
# Create
rad issue open                              # Open editor for new issue
rad issue open --title "Title"              # Set title
rad issue open --title "T" --description "D"  # Set title and description

# List
rad issue list                              # List all issues
rad issue list --state open                 # List open issues
rad issue list --state closed               # List closed issues
rad issue list --assigned                   # List assigned issues
rad issue list --author <DID>               # Filter by author

# Show
rad issue show <ISSUE_ID>                   # Show issue details

# Comment
rad issue comment <ISSUE_ID>                # Add comment (editor)
rad issue comment <ISSUE_ID> --message "text"  # Inline comment

# State
rad issue state <ISSUE_ID> --closed         # Close issue
rad issue state <ISSUE_ID> --open           # Reopen issue

# Assignment
rad issue assign <ISSUE_ID> --add <DID>     # Assign to peer
rad issue assign <ISSUE_ID> --remove <DID>  # Unassign

# Labels
rad issue label <ISSUE_ID> --add bug        # Add label
rad issue label <ISSUE_ID> --remove bug     # Remove label
```

## Node Commands

### rad node

Manage the Radicle node.

```bash
rad node start              # Start node daemon
rad node stop               # Stop node
rad node status             # Check node status and connections
rad node connect <NID>@<address>   # Connect to specific peer
rad node routing            # Show routing table
```

### rad sync

Synchronize with the network.

```bash
rad sync                    # Sync current repository
rad sync --fetch            # Force fetch updates
rad sync --announce         # Announce local refs
rad sync status             # Check sync status
rad sync --scope all        # Sync all seeded repos
rad sync --scope followed   # Sync only followed delegates
```

### rad inbox

View notifications.

```bash
rad inbox                   # Show all notifications
rad inbox --clear           # Clear notifications
```

## Remote Commands

### rad remote

Manage peer remotes.

```bash
rad remote add <NID>                    # Add peer remote
rad remote add <NID> --name alice       # Add with alias
rad remote remove <name>                # Remove remote
rad remote list                         # List remotes
rad remote list --untracked             # Show untracked peers
```

## Identity Management

### rad id

Manage repository identity/delegates.

```bash
# Update repository access (private repos)
rad id update --title "Grant access" --allow <DID>
rad id update --title "Revoke access" --disallow <DID>
rad id update --title "Change name" --name "new-name"
rad id update --title "Update desc" --description "new description"

# List delegates
rad id list
```

## Configuration

### rad config

Manage Radicle configuration.

```bash
rad config                  # Show current config
rad config edit             # Edit config file
rad config set <key> <val>  # Set config value
rad config get <key>        # Get config value
```

## Utility Commands

### rad inspect

Inspect Radicle objects.

```bash
rad inspect <RID>           # Inspect repository
rad inspect --refs          # Show refs
rad inspect --history       # Show history
```

### rad web

Open web interface.

```bash
rad web                     # Open repository in browser (if web UI configured)
```

## Public Seed Nodes

Connect to public infrastructure for better distribution:

- `iris.radicle.xyz` - Public seed node
- `rosa.radicle.xyz` - Public seed node
- `willow.radicle.xyz` - Public seed node

Configure in `rad config edit` under `[node]` section.

## Environment Variables

- `RAD_HOME` - Override default Radicle home directory
- `RAD_PASSPHRASE` - Provide passphrase non-interactively (use with caution)
- `RAD_DEBUG` - Enable debug logging

## Exit Codes

- `0` - Success
- `1` - General error
- `2` - Command line parsing error
- `3` - Network error
- `4` - Authentication error
