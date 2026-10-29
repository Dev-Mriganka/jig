# jig-scripts: your own scripts as tools

**Status: design.**

## Tool: `script`

| Action | What it does |
|---|---|
| `list` | The registered scripts with their descriptions and parameters |
| `run` | Runs one registered script with checked parameters |

## Registering a script

Scripts are registered in configuration:

| Field | Meaning |
|---|---|
| `name`, `description` | The model's handle, and when to use the script |
| `dir`, `entry`, `interpreter` | Where the script lives and how it starts. The folder is hidden from the agent's shell and file tools |
| `environment`, `effect` | Where the script has effect and whether it writes. `jig-core` decides from these |
| `params` | Each parameter's flag, pattern and kind |
| `secrets` | Environment variables filled from secret references |
| `pin` | The folder's hash, written by a command. A script whose folder changed is refused until you pin it again |

A run's output is staged, then published to the ticket folder.

## Company part (in the company plugin)

- the scripts themselves.

## Layout (planned)

```text
jig-scripts/
  src/      the tool, registration checks, pinning, staged output
  test/
```
