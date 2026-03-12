// index.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { IntercomClient } from "./broker/client.js";
import { spawnBrokerIfNeeded } from "./broker/spawn.js";
import { SessionListOverlay } from "./ui/session-list.js";
import { ComposeOverlay, type ComposeResult } from "./ui/compose.js";
import { InlineMessageComponent } from "./ui/inline-message.js";
import { loadConfig, type IntercomConfig } from "./config.js";
import type { SessionInfo, Message } from "./types.js";

export default function piIntercomExtension(pi: ExtensionAPI) {
  // =========================================================================
  // State (module-level, persists across events)
  // =========================================================================
  
  let client: IntercomClient | null = null;
  let config: IntercomConfig = loadConfig();

  // =========================================================================
  // Lifecycle Events
  // =========================================================================

  pi.on("session_start", async (_event, ctx) => {
    
    // Check if intercom is disabled in config
    if (!config.enabled) {
      return;
    }
    
    try {
      // Spawn broker if not running
      await spawnBrokerIfNeeded();
      
      // Create client and set up event handlers BEFORE connecting
      // This avoids a race where events fire before handlers are attached
      client = new IntercomClient();
      
      // Handle incoming messages
      client.on("message", (from, message) => {
        const senderName = from.name || from.id.slice(0, 8);
        const replyHint = config.replyHint
          ? ` — reply: intercom({ action: "send", to: ${JSON.stringify(senderName)}, message: "..." })`
          : "";
        
        pi.sendMessage(
          {
            customType: "intercom_message",
            content: `**📨 From ${senderName}** (${from.cwd})${replyHint}\n\n${message.content.text}`,
            display: true,
            details: { from, message },
          },
          { triggerTurn: true, deliverAs: "steer" }
        );
      });
      
      // Handle disconnection (broker crashed, socket error, etc.)
      client.on("disconnected", () => {
        console.error("Intercom disconnected from broker");
        client = null;
      });
      
      // Handle client errors
      client.on("error", (err) => {
        console.error("Intercom error:", (err as Error).message);
      });
      
      // Now connect - handlers are already attached so no events will be missed
      await client.connect({
        name: pi.getSessionName(),
        cwd: ctx.cwd ?? process.cwd(),
        model: ctx.model?.id ?? "unknown",
        pid: process.pid,
        startedAt: Date.now(),
        lastActivity: Date.now(),
        status: config.status,  // Initial status from config (optional)
      });
    } catch (error) {
      // Fail gracefully - intercom features will be unavailable
      console.error("Intercom failed to initialize:", (error as Error).message);
      client = null;
    }
  });
  
  pi.on("session_shutdown", async () => {
    if (client) {
      await client.disconnect();
      client = null;
    }
  });
  
  // Update presence when model changes
  pi.on("model_select", (event) => {
    if (client) {
      client.updatePresence({ model: event.model.id });
    }
  });

  // =========================================================================
  // Custom Message Renderer
  // =========================================================================

  pi.registerMessageRenderer("intercom_message", (message, _options, theme) => {
    const details = message.details as { from: SessionInfo; message: Message } | undefined;
    if (!details) return undefined;
    return new InlineMessageComponent(details.from, details.message, theme);
  });

  // =========================================================================
  // Tool Registration
  // =========================================================================

  pi.registerTool({
    name: "intercom",
    label: "Intercom",
    description: `Send a message to another pi session running on this machine.
Use this to communicate findings, request help, or coordinate work with other sessions.

Usage:
  intercom({ action: "list" })                    → List active sessions
  intercom({ action: "send", to: "session-name", message: "..." })  → Send message
  intercom({ action: "status" })                  → Show connection status`,

    parameters: Type.Object({
      action: Type.String({
        description: "Action: 'list', 'send', or 'status'",
      }),
      to: Type.Optional(Type.String({
        description: "Target session name or ID (for 'send' action)",
      })),
      message: Type.Optional(Type.String({
        description: "Message to send (for 'send' action)",
      })),
      attachments: Type.Optional(Type.Array(Type.Object({
        type: Type.Union([Type.Literal("file"), Type.Literal("snippet"), Type.Literal("context")]),
        name: Type.String(),
        content: Type.String(),
        language: Type.Optional(Type.String()),
      }))),
      replyTo: Type.Optional(Type.String({
        description: "Message ID to reply to (for threading)",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!client) {
        return { content: [{ type: "text", text: "Intercom not connected" }], isError: true };
      }

      const { action, to, message, attachments, replyTo } = params;

      switch (action) {
        case "list": {
          try {
            const mySessionId = client.sessionId;
            const sessions = await client.listSessions();
            const otherSessions = sessions.filter(s => s.id !== mySessionId);
            
            if (otherSessions.length === 0) {
              return { 
                content: [{ type: "text", text: "No other sessions connected." }],
                isError: false,
              };
            }
            
            const lines = otherSessions.map(s => {
              const name = s.name || `Session ${s.id.slice(0, 8)}`;
              const status = s.status || "idle";
              return `• ${name} — ${s.cwd} (${s.model}) [${status}]`;
            });
            
            return {
              content: [{ type: "text", text: `**Active Sessions:**\n${lines.join("\n")}` }],
              isError: false,
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to list sessions: ${(error as Error).message}` }],
              isError: true,
            };
          }
        }

        case "send": {
          if (!to || !message) {
            return {
              content: [{ type: "text", text: "Missing 'to' or 'message' parameter" }],
              isError: true,
            };
          }

          // Check if auto-send is enabled
          if (!config.autoSend && ctx.hasUI) {
            // Show confirmation dialog
            const confirmed = await ctx.ui.confirm(
              "Send Message",
              `Send to "${to}":\n\n${message}`,
            );
            if (!confirmed) {
              return {
                content: [{ type: "text", text: "Message cancelled by user" }],
                isError: false,
              };
            }
          }

          // Re-check client after potential await (could have disconnected during confirm)
          if (!client) {
            return {
              content: [{ type: "text", text: "Intercom disconnected" }],
              isError: true,
            };
          }

          try {
            const result = await client.send(to, {
              text: message,
              attachments,
              replyTo,
            });

            // Check if delivery actually succeeded
            if (!result.delivered) {
              return {
                content: [{ type: "text", text: `Message to "${to}" was not delivered. Session may not exist or has disconnected.` }],
                isError: true,
                details: { messageId: result.id, delivered: false },
              };
            }

            // Persist sent message in our session
            pi.appendEntry("intercom_sent", {
              to,
              message: { text: message, attachments, replyTo },
              messageId: result.id,
              timestamp: Date.now(),
            });

            return {
              content: [{ type: "text", text: `Message sent to ${to}` }],
              isError: false,
              details: { messageId: result.id, delivered: true },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to send: ${(error as Error).message}` }],
              isError: true,
            };
          }
        }

        case "status": {
          try {
            const mySessionId = client.sessionId;
            const sessions = await client.listSessions();
            return {
              content: [{
                type: "text",
                text: `**Intercom Status:**\nConnected: Yes\nSession ID: ${mySessionId}\nActive sessions: ${sessions.length}`,
              }],
              isError: false,
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to get status: ${(error as Error).message}` }],
              isError: true,
            };
          }
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown action: ${action}` }],
            isError: true,
          };
      }
    },
  });

  // =========================================================================
  // Shared UI Handler (used by command and shortcut)
  // =========================================================================

  async function openIntercomOverlay(ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1]): Promise<void> {
    if (!ctx.hasUI || !client) return;

    let sessions: SessionInfo[];
    try {
      const mySessionId = client.sessionId;
      sessions = await client.listSessions();
      sessions = sessions.filter(s => s.id !== mySessionId);
    } catch (error) {
      ctx.ui.notify(`Failed to list sessions: ${(error as Error).message}`, "error");
      return;
    }

    const selectedSession = await ctx.ui.custom<SessionInfo | undefined>(
      (_tui, theme, _keybindings, done) => {
        return new SessionListOverlay(theme, sessions, done);
      },
      { overlay: true }
    );

    if (!selectedSession) return;

    // Re-check client after await (could have disconnected during selection)
    if (!client) {
      ctx.ui.notify("Intercom disconnected", "error");
      return;
    }

    const result = await ctx.ui.custom<ComposeResult>(
      (tui, theme, _keybindings, done) => {
        return new ComposeOverlay(tui, theme, selectedSession, client!, done);
      },
      { overlay: true }
    );

    if (result.sent && result.messageId && result.text) {
      pi.appendEntry("intercom_sent", {
        to: selectedSession.name || selectedSession.id,
        message: { text: result.text },
        messageId: result.messageId,
        timestamp: Date.now(),
      });
      ctx.ui.notify(`Message sent to ${selectedSession.name || selectedSession.id.slice(0, 8)}`, "info");
    }
  }

  // =========================================================================
  // Command and Shortcut Registration
  // =========================================================================

  pi.registerCommand("intercom", {
    description: "Open session intercom overlay",
    handler: async (_args, ctx) => openIntercomOverlay(ctx),
  });

  pi.registerShortcut("alt+m", {
    description: "Open session intercom",
    handler: async (ctx) => openIntercomOverlay(ctx),
  });
}
