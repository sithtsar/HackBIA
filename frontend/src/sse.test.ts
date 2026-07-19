import { describe, expect, test } from "bun:test";
import { connectEvents } from "./sse";

// Minimal EventSource stand-in: bun's test runtime has no `window`/EventSource
// by default, so both are polyfilled just enough to drive connect()'s branches.
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = FakeEventSource.CONNECTING;
  url: string;
  constructor(url: string) {
    this.url = url;
    instances.push(this);
  }
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
}

let instances: FakeEventSource[] = [];

describe("connectEvents", () => {
  test("resyncs (onReconnect) after the stream reopens, but not on the first connect", () => {
    instances = [];
    (globalThis as unknown as { window: EventTarget }).window ??= new EventTarget();
    (globalThis as unknown as { EventSource: typeof EventSource }).EventSource =
      FakeEventSource as unknown as typeof EventSource;

    const reconnects: number[] = [];
    const cleanup = connectEvents({
      onEvent: () => {},
      onStatus: () => {},
      onReconnect: () => reconnects.push(instances.length),
    });

    expect(instances.length).toBe(1);
    instances[0]?.onopen?.();
    expect(reconnects).toEqual([]); // initial connect is not a resync

    // Backend has no per-client event buffer (backend/app/main.py's
    // /api/events hands out a fresh asyncio.Queue per subscribe), so a
    // dropped connection loses whatever it missed unless the caller resyncs.
    window.dispatchEvent(new Event("online"));
    expect(instances.length).toBe(2);
    instances[1]?.onopen?.();
    expect(reconnects).toEqual([2]);

    cleanup();
  });
});
