# jig-scripts: your own scripts as tools

**Status: design.**

`jig-scripts` turns scripts you already have into tools the agent can call with
checked parameters, and refuses a script whose folder changed since you pinned
it. For example, you register `export-orders`, a script that writes yesterday's
orders from `staging` to a CSV file; the agent can list it and run it with a
date, and nothing else.

## Tool: `script`

| Action | Kind | What it does |
|---|---|---|
| `list` | read | The registered scripts with their descriptions and parameters |
| `run` | as registered: read, local write or external write | Runs one registered script with checked parameters. The script's `environment` and `effect` decide how `jig-core` treats the call |

## Rules

- **A changed script is refused.** A script is pinned by a hash of its folder;
  once the folder changes, the script is refused until you pin it again.
- **The agent cannot read or edit a script.** The script's folder is hidden
  from the agent's shell and file tools.
- **Output is staged,** then published to the ticket folder.

## Configure (planned)

Scripts are registered in configuration:

| Field | Meaning |
|---|---|
| `name`, `description` | The model's handle, and when to use the script |
| `dir`, `entry`, `interpreter` | Where the script lives and how it starts |
| `environment`, `effect` | Where the script has effect and whether it writes. `jig-core` decides from these |
| `params` | Each parameter's flag, pattern and kind |
| `secrets` | Environment variables filled from secret references |
| `pin` | The folder's hash, written by a command |

## Company part (in the company plugin)

- the scripts themselves.

## Layout (planned)

```text
jig-scripts/
  src/      the tool, registration checks, pinning, staged output
  test/
```
