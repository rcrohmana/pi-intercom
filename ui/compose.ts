// ui/compose.ts
import type { Component, TUI } from "@mariozechner/pi-tui";
import { getEditorKeybindings, truncateToWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { IntercomClient } from "../broker/client.js";
import type { SessionInfo } from "../types.js";

export interface ComposeResult {
  sent: boolean;
  messageId?: string;
  /** The message text (for persistence by caller) */
  text?: string;
  /** Target session ID (for persistence by caller) */
  targetId?: string;
}

export class ComposeOverlay implements Component {
  private tui: TUI;
  private theme: Theme;
  private target: SessionInfo;
  private client: IntercomClient;
  private done: (result: ComposeResult) => void;
  private inputBuffer: string = "";
  private sending: boolean = false;
  private error: string | null = null;

  constructor(
    tui: TUI,
    theme: Theme,
    target: SessionInfo,
    client: IntercomClient,
    done: (result: ComposeResult) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.target = target;
    this.client = client;
    this.done = done;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.sending) return;
    const kb = getEditorKeybindings();

    // Handle escape key (cancel)
    if (kb.matches(data, "selectCancel")) {
      this.done({ sent: false });
      return;
    }

    // Ignore other escape sequences (arrows, function keys, etc.)
    // These start with ESC but have additional characters
    if (data.startsWith("\x1b")) {
      return;
    }

    if (kb.matches(data, "selectConfirm")) {
      // Enter - send if we have content
      if (this.inputBuffer.trim()) {
        this.sendMessage();
      }
      return;
    }

    if (kb.matches(data, "deleteCharBackward")) {
      // Backspace
      this.inputBuffer = [...this.inputBuffer].slice(0, -1).join("");
      this.tui.scheduleRender();
      return;
    }

    // Regular character input (handles both single chars and paste)
    // Use spread operator to properly handle Unicode (including emoji)
    const printable = [...data].filter(c => c >= " ").join("");
    if (printable) {
      this.inputBuffer += printable;
      this.tui.scheduleRender();
    }
  }

  private async sendMessage(): Promise<void> {
    this.sending = true;
    this.error = null;
    this.tui.scheduleRender();

    try {
      const result = await this.client.send(this.target.id, {
        text: this.inputBuffer.trim(),
      });
      
      // Check if delivery actually succeeded
      if (!result.delivered) {
        this.error = "Message not delivered. Session may not exist or has disconnected.";
        this.sending = false;
        this.tui.scheduleRender();
        return;
      }
      
      this.done({ 
        sent: true, 
        messageId: result.id,
        text: this.inputBuffer.trim(),
        targetId: this.target.id,
      });
    } catch (err) {
      this.error = (err as Error).message;
      this.sending = false;
      this.tui.scheduleRender();
    }
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const borderWidth = Math.max(0, Math.min(width - 4, 60));
    const targetName = this.target.name || this.target.id.slice(0, 8);
    const kb = getEditorKeybindings();
    const footer = `  ${kb.getKeys("selectConfirm").join("/")}: Send • ${kb.getKeys("selectCancel").join("/")}: Close`;

    // Header
    lines.push(truncateToWidth(this.theme.fg("accent", "━".repeat(borderWidth)), width));
    lines.push(truncateToWidth(this.theme.bold(`  Send to: ${targetName}`), width));
    lines.push(truncateToWidth(this.theme.fg("dim", `  ${this.target.cwd} • ${this.target.model}`), width));
    lines.push(truncateToWidth(this.theme.fg("accent", "━".repeat(borderWidth)), width));
    lines.push("");

    // Input area
    if (this.sending) {
      lines.push(truncateToWidth(this.theme.fg("dim", "  Sending..."), width));
    } else if (this.error) {
      lines.push(truncateToWidth(this.theme.fg("error", `  Error: ${this.error}`), width));
      lines.push("");
      lines.push(truncateToWidth(`  > ${this.inputBuffer}█`, width));
    } else {
      lines.push(truncateToWidth(`  > ${this.inputBuffer}█`, width));
    }

    lines.push("");
    lines.push(truncateToWidth(this.theme.fg("dim", footer), width));

    return lines;
  }
}
