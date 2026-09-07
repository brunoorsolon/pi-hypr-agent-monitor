import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { promises as fs } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

interface StatusData {
  state: "working" | "waiting" | "idle";
  pid: number;
  session_id: string;
  cwd: string;
  model: string;
  updated_at: number;
}

export default function (pi: ExtensionAPI) {
  let currentStatus: StatusData | null = null;
  let sessionId: string = "";
  let sessionCwd: string = "";

  const getStatusFilePath = (): string => {
    const runtimeDir = process.env.XDG_RUNTIME_DIR;
    if (runtimeDir) {
      return join(runtimeDir, "pi-hypr-agent-monitor", "status.json");
    }
    const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
    return join(stateHome, "pi-hypr-agent-monitor", "status.json");
  };

  const writeStatusFile = async (status: StatusData) => {
    if (process.env.PI_HYPR_MONITOR !== "1") return;

    const filePath = getStatusFilePath();
    try {
      await fs.mkdir(dirname(filePath), { recursive: true });
      const tempFilePath = filePath + ".tmp";
      await fs.writeFile(tempFilePath, JSON.stringify(status, null, 2));
      await fs.rename(tempFilePath, filePath);
      currentStatus = status;
    } catch (err: any) {
      console.error("Failed to write Pi status file:", err);
    }
  };

  const removeStatusFileIfOwner = async () => {
    if (process.env.PI_HYPR_MONITOR !== "1") return;
    const filePath = getStatusFilePath();
    try {
      const data = await fs.readFile(filePath, "utf8");
      const parsed: StatusData = JSON.parse(data);
      if (parsed.pid === process.pid) {
        await fs.unlink(filePath);
        currentStatus = null;
      }
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        console.error("Failed to conditionally remove status file:", err);
      }
    }
  };

  const updateStatus = async (newState: StatusData["state"], extraData: Partial<StatusData> = {}) => {
    if (process.env.PI_HYPR_MONITOR !== "1") return;

    const now = Math.floor(Date.now() / 1000);
    const modelStr = extraData.model || currentStatus?.model || "unknown";
    
    const status: StatusData = {
      state: newState,
      pid: process.pid,
      session_id: sessionId,
      cwd: sessionCwd,
      model: modelStr,
      updated_at: now,
      ...extraData
    };

    await writeStatusFile(status);
  };

  const serializeModel = (ctx: ExtensionContext) => {
    return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
  };

  pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
    sessionId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    sessionCwd = process.cwd();
    await updateStatus("idle", { model: serializeModel(ctx) });
  });

  pi.on("agent_start", async (_event: any, _ctx: ExtensionContext) => {
    await updateStatus("working");
  });

  pi.on("agent_settled", async (_event: any, _ctx: ExtensionContext) => {
    await updateStatus("waiting");
  });

  pi.on("model_select", async (_event: any, ctx: ExtensionContext) => {
    await updateStatus(currentStatus?.state || "idle", { model: serializeModel(ctx) });
  });

  pi.on("session_shutdown", async (_event: any, _ctx: ExtensionContext) => {
    await removeStatusFileIfOwner();
  });
}
