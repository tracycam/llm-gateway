// Incrementally split an SSE stream without changing its wire representation.

/** One block of an SSE stream, up to and including its blank line. */
export interface SseFrame {
  /** The block exactly as received, terminator included: what is passed on untouched. */
  raw: string;
  /** Value of the `event:` field, or null. */
  event: string | null;
  /** The `data:` lines joined with "\n"; null for a block with no data line. */
  data: string | null;
}

export class SseParser {
  private buffer = '';
  private position = 0;
  private lineStart = 0;
  private event: string | null = null;
  private data: string[] = [];

  /** Return complete blocks received so far. */
  public push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    return this.scan(false);
  }

  /** Return the last block if the stream ended without a terminating blank line. */
  public end(): SseFrame[] {
    return this.scan(true);
  }

  private scan(ended: boolean): SseFrame[] {
    const frames: SseFrame[] = [];
    while (this.position < this.buffer.length) {
      const char = this.buffer[this.position];
      if (char !== '\r' && char !== '\n') {
        this.position++;
        continue;
      }
      if (char === '\r' && this.position + 1 === this.buffer.length && !ended) break;
      const line = this.buffer.slice(this.lineStart, this.position);
      this.position += char === '\r' && this.buffer[this.position + 1] === '\n' ? 2 : 1;
      this.lineStart = this.position;
      if (line === '') {
        frames.push(this.frame(this.buffer.slice(0, this.position)));
        this.buffer = this.buffer.slice(this.position);
        this.position = 0;
        this.lineStart = 0;
      } else {
        this.field(line);
      }
    }
    if (ended && this.buffer.length) {
      if (this.lineStart < this.buffer.length) this.field(this.buffer.slice(this.lineStart));
      frames.push(this.frame(this.buffer));
      this.buffer = '';
      this.position = 0;
      this.lineStart = 0;
    }
    return frames;
  }

  private field(line: string): void {
    // Comment lines have an empty field name and match neither recognized field.
    const colon = line.indexOf(':');
    const name = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (name === 'event') this.event = value;
    if (name === 'data') this.data.push(value);
  }

  private frame(raw: string): SseFrame {
    const frame = { raw, event: this.event, data: this.data.length ? this.data.join('\n') : null };
    this.event = null;
    this.data = [];
    return frame;
  }
}
