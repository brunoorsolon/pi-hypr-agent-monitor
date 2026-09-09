# Pi Hypr Agent Monitor

A [Pi](https://github.com/earendil-works/pi-mono) extension that publishes the active agent state for desktop integrations such as the [Noctalia Pi scratchpad widget](https://github.com/brunoorsolon/noctalia-plugins/issues/8).

## Install

Clone the repository where Pi auto-discovers extension directories:

```sh
git clone https://github.com/brunoorsolon/pi-hypr-agent-monitor ~/.pi/agent/extensions/pi-hypr-agent-monitor
```

For development, load the checkout directly with `pi -e ./index.ts`.

Set `PI_HYPR_MONITOR=1` only on the monitored Pi process:

```sh
PI_HYPR_MONITOR=1 pi
```

Do not export `PI_HYPR_MONITOR` from a shell profile. The status path is a singleton; competing gated processes overwrite each other, and shutdown removes the file only when its recorded PID belongs to the exiting process.

## Status file

The extension atomically replaces `$XDG_RUNTIME_DIR/pi-hypr-agent-monitor/status.json`. When `XDG_RUNTIME_DIR` is unset, it uses `$XDG_STATE_HOME/pi-hypr-agent-monitor/status.json`, defaulting `XDG_STATE_HOME` to `~/.local/state`.

```json
{
  "state": "working",
  "pid": 12345,
  "session_id": "0f3c...",
  "cwd": "/home/bruno",
  "model": "anthropic/claude-sonnet-4-5",
  "updated_at": 1757260800
}
```

Every field is present. `state` is `working`, `waiting`, or `idle`; `updated_at` is Unix seconds.

| Pi event | Result |
| --- | --- |
| `session_start` | Writes `idle` with the current session ID, working directory, and model |
| `agent_start` | Writes `working` |
| `agent_settled` | Writes `waiting` |
| `model_select` | Keeps the state and refreshes the model |
| `session_shutdown` | Removes the file when owned by this process |

Without `PI_HYPR_MONITOR=1`, the extension does not create, modify, or remove the file. A `SIGKILL` leaves the last status behind so readers can detect the dead `pid` through `/proc/<pid>`.
