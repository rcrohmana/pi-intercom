// broker/spawn.ts
import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import net from "net";

const INTERCOM_DIR = join(homedir(), ".pi/agent/intercom");
const BROKER_SOCKET = join(INTERCOM_DIR, "broker.sock");
const BROKER_PID = join(INTERCOM_DIR, "broker.pid");
const BROKER_SPAWN_LOCK = join(INTERCOM_DIR, "broker.spawn.lock");

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function spawnBrokerIfNeeded(): Promise<void> {
  // Ensure directory exists
  mkdirSync(INTERCOM_DIR, { recursive: true });

  // Check if broker is already running
  if (await isBrokerRunning()) {
    return;
  }

  const ownsLock = acquireSpawnLock();
  if (!ownsLock) {
    await waitForBroker();
    return;
  }

  try {
    if (await isBrokerRunning()) {
      return;
    }

    // Spawn broker as detached process using the extension-local tsx runtime
    const brokerPath = join(dirname(fileURLToPath(import.meta.url)), "broker.ts");
    const child = spawn("npx", ["--no-install", "tsx", brokerPath], {
      detached: true,
      stdio: "ignore",
      cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    child.unref();

    // Wait for broker to be ready
    await waitForBroker();
  } finally {
    releaseSpawnLock();
  }
}

async function isBrokerRunning(): Promise<boolean> {
  if (await checkSocketConnectable()) {
    return true;
  }

  if (!existsSync(BROKER_PID)) return false;

  try {
    const pid = parseInt(readFileSync(BROKER_PID, "utf-8").trim(), 10);
    process.kill(pid, 0); // Check if process exists (signal 0 = no signal, just check)
    
    // Also verify socket is accepting connections
    return checkSocketConnectable();
  } catch {
    return false;
  }
}

function checkSocketConnectable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(BROKER_SOCKET);
    const finish = (isConnected: boolean) => {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      resolve(isConnected);
    };
    const onConnect = () => {
      socket.end();
      finish(true);
    };
    const onError = () => {
      socket.destroy();
      finish(false);
    };
    socket.on("connect", onConnect);
    socket.on("error", onError);
    // Timeout after 1 second
    const timeout = setTimeout(() => {
      socket.destroy();
      finish(false);
    }, 1000);
  });
}

function acquireSpawnLock(): boolean {
  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      writeFileSync(BROKER_SPAWN_LOCK, `${process.pid}\n${Date.now()}\n`, { flag: "wx" });
      return true;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw error;
      }
      if (isSpawnLockStale()) {
        try {
          unlinkSync(BROKER_SPAWN_LOCK);
        } catch {
          // If we can't delete the stale lock, retry a few times before giving up
        }
        continue;
      }
      // Lock exists and is not stale - another process owns it
      return false;
    }
  }
  // Couldn't acquire lock after max retries (stale lock that can't be deleted)
  return false;
}

function isSpawnLockStale(): boolean {
  if (!existsSync(BROKER_SPAWN_LOCK)) {
    return false;
  }

  try {
    const [pidLine = "", createdAtLine = "0"] = readFileSync(BROKER_SPAWN_LOCK, "utf-8").trim().split("\n");
    const pid = Number.parseInt(pidLine, 10);
    const createdAt = Number.parseInt(createdAtLine, 10);
    const ageMs = Date.now() - createdAt;

    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
    }

    return !Number.isFinite(createdAt) || ageMs > 10_000;
  } catch {
    return true;
  }
}

function releaseSpawnLock(): void {
  try {
    unlinkSync(BROKER_SPAWN_LOCK);
  } catch {}
}

async function waitForBroker(timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkSocketConnectable()) {
      return;
    }
    await sleep(100);
  }
  throw new Error("Broker failed to start within timeout");
}
