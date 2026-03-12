// config.ts
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface IntercomConfig {
  /** Allow agent to send messages without confirmation */
  autoSend: boolean;
  
  /** Custom status shown to other sessions */
  status?: string;
  
  /** Enable/disable intercom (default: true) */
  enabled: boolean;
  
  /** Show reply hint in incoming messages (default: true) */
  replyHint: boolean;
}

const CONFIG_PATH = join(homedir(), ".pi/agent/intercom/config.json");

const defaults: IntercomConfig = {
  autoSend: false,
  enabled: true,
  replyHint: true,
};

export function loadConfig(): IntercomConfig {
  if (!existsSync(CONFIG_PATH)) {
    return { ...defaults };
  }
  
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...defaults, ...parsed };
  } catch {
    return { ...defaults };
  }
}
