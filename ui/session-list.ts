// ui/session-list.ts
import type { Component } from "@mariozechner/pi-tui";
import { getEditorKeybindings, SelectList, type SelectItem, type SelectListTheme, truncateToWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { SessionInfo } from "../types.js";

export class SessionListOverlay implements Component {
  private selectList: SelectList;
  private theme: Theme;
  private done: (result: SessionInfo | undefined) => void;
  private sessions: SessionInfo[];

  constructor(
    theme: Theme,
    sessions: SessionInfo[],
    done: (result: SessionInfo | undefined) => void,
  ) {
    this.theme = theme;
    this.sessions = sessions;
    this.done = done;

    const items: SelectItem[] = sessions.map(s => ({
      value: s.id,
      label: s.name || `Session ${s.id.slice(0, 8)}`,
      description: `${s.cwd} • ${s.model}`,
    }));

    const selectTheme: SelectListTheme = {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("dim", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("dim", t),
    };

    this.selectList = new SelectList(items, 10, selectTheme);
    this.selectList.onSelect = (item) => this.onSessionSelect(item.value);
    this.selectList.onCancel = () => this.done(undefined);
  }

  private onSessionSelect(sessionId: string): void {
    const session = this.sessions.find(s => s.id === sessionId);
    if (!session) return;

    // Return the selected session to the caller, which will show the compose overlay
    this.done(session);
  }

  invalidate(): void {
    this.selectList.invalidate?.();
  }

  handleInput(data: string): void {
    this.selectList.handleInput?.(data);
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const kb = getEditorKeybindings();
    const footer = `  ${kb.getKeys("selectConfirm").join("/")}: Message • ${kb.getKeys("selectCancel").join("/")}: Close`;
    
    // Header
    lines.push(truncateToWidth(this.theme.fg("accent", "━".repeat(Math.min(width, 50))), width));
    lines.push(truncateToWidth(this.theme.bold("  Active Sessions"), width));
    lines.push(truncateToWidth(this.theme.fg("accent", "━".repeat(Math.min(width, 50))), width));
    lines.push("");

    // Session list
    if (this.sessions.length === 0) {
      lines.push(truncateToWidth(this.theme.fg("dim", "  No other sessions running"), width));
    } else {
      lines.push(...this.selectList.render(width));
    }

    lines.push("");
    lines.push(truncateToWidth(this.theme.fg("dim", footer), width));

    return lines;
  }
}
