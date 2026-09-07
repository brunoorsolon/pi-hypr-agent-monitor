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
    // Only write if the feature gate is enabled
    if (process.env.PI_HYPR_MONITOR !== "1") {
      return;
    }

    const filePath = getStatusFilePath();
    try {
      await fs.mkdir(dirname(filePath), { recursive: true });
      
      // Write atomically: temp file then rename
      const tempFilePath = filePath + ".tmp";
      await fs.writeFile(tempFilePath, JSON.stringify(status, null, 2));
      await fs.rename(tempFilePath, filePath);
      
      currentStatus = status;
    } catch (err: any) {
      // Silently fail - don't want to crash Pi if we can't write the status file
      console.error("Failed to write Pi status file:", err);
    }
  };

  const removeStatusFile = async () => {
    // Only remove if the feature gate is enabled
    if (process.env.PI_HYPR_MONITOR !== "1") {
      return;
    }

    const filePath = getStatusFilePath();
    try {
      await fs.unlink(filePath);
      currentStatus = null;
    } catch (err: any) {
      // Ignore if file doesn't exist
      if (err.code !== "ENOENT") {
        console.error("Failed to remove Pi status file:", err);
      }
    }
  };

  const updateStatus = async (newState: StatusData["state"], extraData: Partial<StatusData> = {}) => {
    if (process.env.PI_HYPR_MONITOR !== "1") {
      return;
    }

    const now = Math.floor(Date.now() / 1000); // Unix seconds
    
    const status: StatusData = {
      state: newState,
      pid: process.pid,
      session_id: sessionId,
      cwd: sessionCwd,
      model: "unknown",
      updated_at: now,
      ...extraData
    };

    await writeStatusFile(status);
  };

  pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
    sessionId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    sessionCwd = process.cwd();
    
    await updateStatus("idle", { model: ctx.model?.toString() ?? "unknown" });
  });

  pi.on("agent_start", async (_event: any, _ctx: ExtensionContext) => {
    await updateStatus("working");
  });

  pi.on("agent_settled", async (_event: any, _ctx: ExtensionContext) => {
    await updateStatus("waiting");
  });

  pi.on("model_select", async (_event: any, ctx: ExtensionContext) => {
    if (currentStatus) {
      await updateStatus(currentStatus.state, { model: ctx.model?.toString() ?? "unknown" });
    }
  });

  pi.on("session_shutdown", async (_event: any, _ctx: ExtensionContext) => {
    await removeStatusFile();
  });
}