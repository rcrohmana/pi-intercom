// broker/broker.ts
import net from "net";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { writeMessage, createMessageReader } from "./framing.js";
import type { SessionInfo, ClientMessage, BrokerMessage } from "../types.js";

const INTERCOM_DIR = join(homedir(), ".pi/agent/intercom");
const SOCKET_PATH = join(INTERCOM_DIR, "broker.sock");
const PID_PATH = join(INTERCOM_DIR, "broker.pid");

interface ConnectedSession {
  socket: net.Socket;
  info: SessionInfo;
}

class IntercomBroker {
  private sessions = new Map<string, ConnectedSession>();
  private server: net.Server;
  private shutdownTimer: NodeJS.Timeout | null = null;

  constructor() {
    // Ensure directory exists
    mkdirSync(INTERCOM_DIR, { recursive: true });

    // Clean up stale socket
    try { unlinkSync(SOCKET_PATH); } catch {}

    this.server = net.createServer(this.handleConnection.bind(this));
  }

  start(): void {
    this.server.listen(SOCKET_PATH, () => {
      writeFileSync(PID_PATH, String(process.pid));
      console.log(`Intercom broker started (pid: ${process.pid})`);
    });

    // Graceful shutdown
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }

  private handleConnection(socket: net.Socket): void {
    let sessionId: string | null = null;

    const reader = createMessageReader((msg) => {
      this.handleMessage(socket, msg as ClientMessage, sessionId, (id) => {
        sessionId = id;
      });
    });

    socket.on("data", reader);

    socket.on("close", () => {
      if (sessionId) {
        this.sessions.delete(sessionId);
        this.broadcast({ type: "session_left", sessionId }, sessionId);

        // Schedule shutdown if no sessions (with grace period)
        this.scheduleShutdownCheck();
      }
    });

    socket.on("error", (err) => {
      console.error("Socket error:", err.message);
    });
  }

  private scheduleShutdownCheck(): void {
    if (this.shutdownTimer) return;

    this.shutdownTimer = setTimeout(() => {
      this.shutdownTimer = null;
      if (this.sessions.size === 0) {
        console.log("No sessions connected, shutting down");
        this.shutdown();
      }
    }, 5000); // 5 second grace period
  }

  private handleMessage(
    socket: net.Socket,
    msg: ClientMessage,
    currentId: string | null,
    setId: (id: string | null) => void,
  ): void {
    switch (msg.type) {
      case "register": {
        // Prevent duplicate registration - ignore if already registered
        if (currentId) {
          break;
        }
        
        const id = randomUUID();
        setId(id);
        const info: SessionInfo = { ...msg.session, id };
        this.sessions.set(id, { socket, info });
        
        // Cancel any pending shutdown
        if (this.shutdownTimer) {
          clearTimeout(this.shutdownTimer);
          this.shutdownTimer = null;
        }

        writeMessage(socket, { type: "registered", sessionId: id });
        this.broadcast({ type: "session_joined", session: info }, id);
        break;
      }

      case "unregister": {
        if (currentId) {
          this.sessions.delete(currentId);
          this.broadcast({ type: "session_left", sessionId: currentId }, currentId);
          setId(null);
          this.scheduleShutdownCheck();
        }
        break;
      }

      case "list": {
        const sessions = Array.from(this.sessions.values()).map(s => s.info);
        writeMessage(socket, { type: "sessions", sessions });
        break;
      }

      case "send": {
        if (!currentId) {
          writeMessage(socket, {
            type: "delivery_failed",
            messageId: msg.message?.id ?? "unknown",
            reason: "Not registered",
          });
          break;
        }

        // Validate message has required fields
        if (!msg.message?.id || typeof msg.message?.content?.text !== "string") {
          writeMessage(socket, {
            type: "delivery_failed",
            messageId: msg.message?.id ?? "unknown",
            reason: "Invalid message format",
          });
          break;
        }

        const target = this.findSession(msg.to);
        if (target) {
          const from = this.sessions.get(currentId)!.info;
          writeMessage(target.socket, {
            type: "message",
            from,
            message: msg.message,
          });
          writeMessage(socket, { type: "delivered", messageId: msg.message.id });
        } else {
          writeMessage(socket, {
            type: "delivery_failed",
            messageId: msg.message.id,
            reason: "Session not found",
          });
        }
        break;
      }

      case "presence": {
        if (currentId) {
          const session = this.sessions.get(currentId);
          if (session) {
            if (msg.status !== undefined) {
              session.info.status = msg.status;
            }
            if (msg.model !== undefined) {
              session.info.model = msg.model;
            }
            session.info.lastActivity = Date.now();
            this.broadcast({ type: "presence_update", session: session.info }, currentId);
          }
        }
        break;
      }
    }
  }

  private findSession(nameOrId: string): ConnectedSession | undefined {
    // Try by ID first
    if (this.sessions.has(nameOrId)) {
      return this.sessions.get(nameOrId);
    }
    // Try by name (case-insensitive)
    const lowerName = nameOrId.toLowerCase();
    for (const session of this.sessions.values()) {
      if (session.info.name?.toLowerCase() === lowerName) {
        return session;
      }
    }
    return undefined;
  }

  private broadcast(msg: BrokerMessage, exclude?: string): void {
    for (const [id, session] of this.sessions) {
      if (id !== exclude) {
        writeMessage(session.socket, msg);
      }
    }
  }

  private shutdown(): void {
    console.log("Broker shutting down");
    
    // Close all connections
    for (const session of this.sessions.values()) {
      session.socket.end();
    }
    this.sessions.clear();

    // Clean up files
    try { unlinkSync(SOCKET_PATH); } catch {}
    try { unlinkSync(PID_PATH); } catch {}
    
    this.server.close();
    process.exit(0);
  }
}

// Start broker
new IntercomBroker().start();
