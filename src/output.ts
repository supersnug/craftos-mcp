/** A bounded, per-session log of committed terminal lines and mutable live rows. */
export const OUTPUT_BUDGET = 1024 * 1024;
const PAGE_BYTES = 64 * 1024;
type Line = { text: string; commandId?: string };
type Entry = Line & { sequence: number };
const cost = (line: Line) => 128 + line.text.length + (line.commandId?.length ?? 0);

export class OutputHistory {
  private entries: (Entry | undefined)[] = [];
  private head = 0;
  private live = new Map<number, Line>();
  private bytes = 0;
  private sequence = 0;
  private droppedThrough = 0;
  private droppedLiveLines = 0;

  constructor(private readonly budget = OUTPUT_BUDGET) {}

  get cursor() { return this.sequence; }

  clearLive() {
    for (const line of this.live.values()) this.bytes -= cost(line);
    this.live.clear();
  }

  hasCommand(commandId: string) {
    for (let i = this.head; i < this.entries.length; i++) if (this.entries[i]!.commandId === commandId) return true;
    for (const line of this.live.values()) if (line.commandId === commandId) return true;
    return false;
  }

  accept(kind: 0 | 1, row: number, line: Line) {
    const previous = this.live.get(row);
    if (previous) {
      this.bytes -= cost(previous);
      this.live.delete(row);
    }
    if (kind === 0) this.entries.push({ ...line, sequence: ++this.sequence });
    else this.live.set(row, line);
    this.bytes += cost(line);
    while (this.bytes > this.budget && this.head < this.entries.length) {
      const evicted = this.entries[this.head]!;
      this.entries[this.head++] = undefined;
      this.bytes -= cost(evicted);
      this.droppedThrough = evicted.sequence;
    }
    while (this.bytes > this.budget && this.live.size) {
      const [key, evicted] = this.live.entries().next().value!;
      this.live.delete(key);
      this.bytes -= cost(evicted);
      this.droppedLiveLines++;
    }
    // Release references promptly, including large text strings, without an
    // O(n) shift for every incoming line once the ring reaches its budget.
    if (this.head > 0 && (this.head >= 256 || this.head === this.entries.length)) {
      this.entries = this.entries.slice(this.head);
      this.head = 0;
    }
  }

  read(cursor = 0, commandId?: string, limit = 200) {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.sequence) throw new Error('Invalid output cursor for this session');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Output limit must be 1–1000 lines');
    const lines: Entry[] = [];
    let nextCursor = Math.max(cursor, this.droppedThrough), bytes = 0, hasMore = false;
    for (let i = this.head; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      if (entry.sequence <= cursor) continue;
      if (!commandId || entry.commandId === commandId) {
        if (lines.length >= limit || bytes + entry.text.length + 1 > PAGE_BYTES) { hasMore = true; break; }
        lines.push({ ...entry });
        bytes += entry.text.length + 1;
      }
      nextCursor = entry.sequence;
    }
    if (!hasMore) nextCursor = this.sequence;
    const liveLines: (Line & { row: number })[] = [];
    let liveTruncated = false;
    for (const [row, line] of this.live) {
      if (commandId && line.commandId !== commandId) continue;
      if (liveLines.length >= limit || bytes + line.text.length + 1 > PAGE_BYTES) { liveTruncated = true; continue; }
      liveLines.push({ row, ...line });
      bytes += line.text.length + 1;
    }
    liveLines.sort((a, b) => a.row - b.row);
    return {
      lines, text: lines.map(line => line.text + '\n').join(''), liveLines,
      nextCursor, hasMore, truncated: cursor < this.droppedThrough,
      droppedThroughCursor: this.droppedThrough, droppedLiveLines: this.droppedLiveLines, liveTruncated,
      retainedBytes: this.bytes, budgetBytes: this.budget,
    };
  }
}
