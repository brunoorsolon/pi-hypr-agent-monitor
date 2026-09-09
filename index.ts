import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type State = "working" | "waiting" | "idle";

interface StatusData {
  state: State;
  pid: number;
  session_id: string;
  cwd: string;
  model: string;
  updated_at: number;
}

export default function monitor(pi: ExtensionAPI) {
  let current: StatusData | undefined;
  let sessionId = "";
  let cwd = "";

  const statusPath = () => join(
    process.env.XDG_RUNTIME_DIR || process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
    "pi-hypr-agent-monitor",
    "status.json",
  );
  const enabled = () => process.env.PI_HYPR_MONITOR === "1";
  const modelName = (model: ExtensionContext["model"]) => model ? `${model.provider}/${model.id}` : "unknown";

  async function publish(state: State, model = current?.model ?? "unknown") {
    if (!enabled()) return;
    const status: StatusData = {
      state,
      pid: process.pid,
      session_id: sessionId,
      cwd,
      model,
      updated_at: Math.floor(Date.now() / 1000),
    };
    const path = statusPath();
    try {
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(`${path}.${process.pid}.tmp`, JSON.stringify(status));
      await fs.rename(`${path}.${process.pid}.tmp`, path);
      current = status;
    } catch (error) {
      console.error("Failed to write Pi status file:", error);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    cwd = ctx.cwd;
    await publish("idle", modelName(ctx.model));
  });
  pi.on("agent_start", async () => publish("working"));
  pi.on("agent_settled", async () => publish("waiting"));
  pi.on("model_select", async (event) => publish(current?.state ?? "idle", modelName(event.model)));
  pi.on("session_shutdown", async () => {
    if (!enabled()) return;
    const path = statusPath();
    try {
      const status = JSON.parse(await fs.readFile(path, "utf8")) as { pid?: unknown };
      if (status.pid === process.pid) {
        await fs.unlink(path);
        current = undefined;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        console.error("Failed to conditionally remove Pi status file:", error);
      }
    }
  });
}
