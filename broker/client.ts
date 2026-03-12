// broker/client.ts
import { EventEmitter } from "events";
import net from "net";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { writeMessage, createMessageReader } from "./framing.js";
import type { SessionInfo, Message, BrokerMessage, Attachment } from "../types.js";

const BROKER_SOCKET = join(homedir(), ".pi/agent/intercom/broker.sock");

interface SendOptions {
  text: string;
  attachments?: Attachment[];
  replyTo?: string;
}

interface SendResult {
  id: string;
  delivered: boolean;
}

export class IntercomClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private _sessionId: string | null = null;
  private pendingSends = new Map<string, { resolve: (r: SendResult) => void; reject: (e: Error) => void }>();
  private pendingLists: Array<{ resolve: (sessions: SessionInfo[]) => void; reject: (e: Error) => void }> = [];
  private disconnecting = false;

  private failPending(reason: string): void {
    for (const pending of this.pendingSends.values()) {
      pending.reject(new Error(reason));
    }
    this.pendingSends.clear();
    for (const pending of this.pendingLists) {
      pending.reject(new Error(reason));
    }
    this.pendingLists = [];
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  connect(session: Omit<SessionInfo, "id">): Promise<void> {
    if (this.socket) {
      return Promise.reject(new Error("Already connected"));
    }

    return new Promise((resolve, reject) => {
      const socket = net.connect(BROKER_SOCKET);
      this.socket = socket;
      let settled = false;
      const timeout = setTimeout(() => {
        if (!this._sessionId) {
          cleanupConnectionAttempt();
          cleanupSocketListeners();
          if (this.socket === socket) {
            this.socket = null;
          }
          socket.destroy();
          reject(new Error("Connection timeout"));
        }
      }, 10000);
      
      const reader = createMessageReader((msg: BrokerMessage) => {
        this.handleBrokerMessage(msg);
      });
      
      let connectionEstablished = false;
      
      const onRegistered = () => {
        settled = true;
        connectionEstablished = true;
        cleanupConnectionAttempt();
        resolve();
      };
      
      const onError = (err: Error) => {
        settled = true;
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        if (this.socket === socket) {
          this.socket = null;
        }
        socket.destroy();
        reject(err);
      };
      
      const onClose = () => {
        const wasConnecting = !settled && !this._sessionId;
        const wasDisconnecting = this.disconnecting;
        this.disconnecting = false;
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        this.failPending("Client disconnected");
        if (this.socket === socket) {
          this.socket = null;
        }
        this._sessionId = null;
        if (!wasDisconnecting) {
          this.emit("disconnected");
        }
        if (wasConnecting) {
          reject(new Error("Connection closed before registration"));
        }
      };

      const onSocketError = (err: Error) => {
        // Only emit error events after connection is established.
        // During connection, errors are handled by onError which rejects the promise.
        if (connectionEstablished) {
          this.emit("error", err);
        }
      };
      
      const cleanupConnectionAttempt = () => {
        this.off("_registered", onRegistered);
        socket.off("error", onError);
        clearTimeout(timeout);
      };

      const cleanupSocketListeners = () => {
        socket.off("data", reader);
        socket.off("error", onSocketError);
        socket.off("close", onClose);
      };
      
      socket.on("data", reader);
      socket.on("error", onError);
      socket.on("close", onClose);
      
      // Permanent error handler (must stay attached after registration)
      // Without this, socket errors would throw uncaught exceptions
      socket.on("error", onSocketError);
      
      // Wait for registration confirmation
      this.once("_registered", onRegistered);
      
      try {
        writeMessage(socket, { type: "register", session });
      } catch (error) {
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        if (this.socket === socket) {
          this.socket = null;
        }
        socket.destroy();
        reject(error as Error);
      }
    });
  }

  private handleBrokerMessage(msg: BrokerMessage): void {
    switch (msg.type) {
      case "registered":
        this._sessionId = msg.sessionId;
        this.emit("_registered", msg);
        break;
        
      case "sessions":
        // Resolve the oldest pending list request (broker sends one response per list request)
        const pending = this.pendingLists.shift();
        if (pending) {
          pending.resolve(msg.sessions);
        }
        break;
        
      case "message":
        this.emit("message", msg.from, msg.message);
        break;
        
      case "delivered": {
        const pending = this.pendingSends.get(msg.messageId);
        if (pending) {
          pending.resolve({ id: msg.messageId, delivered: true });
          this.pendingSends.delete(msg.messageId);
        }
        break;
      }
        
      case "delivery_failed": {
        const pending = this.pendingSends.get(msg.messageId);
        if (pending) {
          pending.resolve({ id: msg.messageId, delivered: false });
          this.pendingSends.delete(msg.messageId);
        }
        break;
      }
        
      case "session_joined":
        this.emit("session_joined", msg.session);
        break;
        
      case "session_left":
        this.emit("session_left", msg.sessionId);
        break;
        
      case "presence_update":
        this.emit("presence_update", msg.session);
        break;
        
      case "error":
        this.emit("error", new Error(msg.error));
        break;
    }
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      return;
    }

    this.disconnecting = true;
    this.failPending("Client disconnected");

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        socket.off("close", onClose);
        socket.off("error", onError);
        resolve();
      };
      const onClose = () => finish();
      const onError = () => {
        socket.destroy();
      };
      const timeout = setTimeout(() => {
        socket.destroy();
      }, 2000);

      socket.once("close", onClose);
      socket.once("error", onError);

      try {
        writeMessage(socket, { type: "unregister" });
        socket.end();
      } catch {
        socket.destroy();
      }
    });
  }

  listSessions(): Promise<SessionInfo[]> {
    const socket = this.socket;
    if (!socket || !this._sessionId) {
      return Promise.reject(new Error("Not connected"));
    }
    
    return new Promise((resolve, reject) => {
      const wrappedResolve = (sessions: SessionInfo[]) => {
        clearTimeout(timeout);
        resolve(sessions);
      };
      const wrappedReject = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        const idx = this.pendingLists.findIndex(p => p.resolve === wrappedResolve);
        if (idx !== -1) {
          this.pendingLists.splice(idx, 1);
          wrappedReject(new Error("List sessions timeout"));
        }
      }, 5000);
      this.pendingLists.push({ resolve: wrappedResolve, reject: wrappedReject });
      try {
        writeMessage(socket, { type: "list" });
      } catch (error) {
        clearTimeout(timeout);
        const idx = this.pendingLists.findIndex(p => p.resolve === wrappedResolve);
        if (idx !== -1) {
          this.pendingLists.splice(idx, 1);
        }
        reject(error as Error);
      }
    });
  }

  send(to: string, options: SendOptions): Promise<SendResult> {
    const socket = this.socket;
    if (!socket || !this._sessionId) {
      return Promise.reject(new Error("Not connected"));
    }
    
    const messageId = randomUUID();
    const message: Message = {
      id: messageId,
      timestamp: Date.now(),
      replyTo: options.replyTo,
      content: {
        text: options.text,
        attachments: options.attachments,
      },
    };

    // Wait for delivered/delivery_failed response
    return new Promise((resolve, reject) => {
      const wrappedResolve = (result: SendResult) => {
        clearTimeout(timeout);
        resolve(result);
      };
      const wrappedReject = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        if (this.pendingSends.has(messageId)) {
          this.pendingSends.delete(messageId);
          wrappedReject(new Error("Send timeout"));
        }
      }, 10000);
      this.pendingSends.set(messageId, { resolve: wrappedResolve, reject: wrappedReject });

      try {
        writeMessage(socket, { type: "send", to, message });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingSends.delete(messageId);
        reject(error as Error);
      }
    });
  }

  updatePresence(updates: { status?: string; model?: string }): void {
    if (this.socket) {
      writeMessage(this.socket, { type: "presence", ...updates });
    }
  }

  // EventEmitter events:
  // - "message" (from: SessionInfo, message: Message)
  // - "session_joined" (session: SessionInfo)
  // - "session_left" (sessionId: string)
  // - "presence_update" (session: SessionInfo)
  // - "disconnected" ()
  // - "error" (error: Error)
}
