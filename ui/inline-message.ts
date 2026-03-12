// ui/inline-message.ts
import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { SessionInfo, Message } from "../types.js";

export class InlineMessageComponent implements Component {
  private from: SessionInfo;
  private message: Message;
  private theme: Theme;

  constructor(from: SessionInfo, message: Message, theme: Theme) {
    this.from = from;
    this.message = message;
    this.theme = theme;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    const borderChar = "─";
    if (width < 3) {
      return [truncateToWidth(`From ${this.from.name || this.from.id.slice(0, 8)}`, width)];
    }
    const bodyWidth = Math.max(1, Math.min(width - 2, 58));

    // Top border with sender info
    const senderName = this.from.name || this.from.id.slice(0, 8);
    const header = ` 📨 From: ${senderName} (${this.from.cwd}) `;
    const headerText = truncateToWidth(header, bodyWidth, "");
    const headerPadding = Math.max(0, bodyWidth - visibleWidth(headerText));
    lines.push(this.theme.fg("accent", `╭${headerText}${borderChar.repeat(headerPadding)}╮`));

    // Message content
    const contentLines = wrapTextWithAnsi(this.message.content.text, bodyWidth);
    for (const line of contentLines) {
      const text = truncateToWidth(line, bodyWidth, "");
      const padding = Math.max(0, bodyWidth - visibleWidth(text));
      lines.push(this.theme.fg("accent", `│${text}${" ".repeat(padding)}│`));
    }

    // Attachments
    if (this.message.content.attachments?.length) {
      lines.push(this.theme.fg("accent", `│${" ".repeat(bodyWidth)}│`));
      for (const att of this.message.content.attachments) {
        const label = this.theme.fg("dim", ` 📎 ${att.name}`);
        const text = truncateToWidth(label, bodyWidth, "");
        const padding = Math.max(0, bodyWidth - visibleWidth(text));
        lines.push(this.theme.fg("accent", `│${text}${" ".repeat(padding)}│`));
      }
    }

    // Reply indicator
    if (this.message.replyTo) {
      const reply = this.theme.fg("dim", ` ↳ Reply to ${this.message.replyTo.slice(0, 8)}`);
      const text = truncateToWidth(reply, bodyWidth, "");
      const padding = Math.max(0, bodyWidth - visibleWidth(text));
      lines.push(this.theme.fg("accent", `│${text}${" ".repeat(padding)}│`));
    }

    // Bottom border
    lines.push(this.theme.fg("accent", `╰${borderChar.repeat(bodyWidth)}╯`));

    return lines;
  }
}
