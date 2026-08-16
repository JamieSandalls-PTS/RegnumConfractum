import { parseServerMessage, type ClientMessage, type ServerMessage } from '@rc/shared';

/**
 * Thin WebSocket wrapper: validates every inbound frame against the shared
 * schema (D-105) and dispatches typed messages. State lives in main.ts —
 * this class only speaks the protocol.
 */

export type MessageHandler = (msg: ServerMessage) => void;

export class Connection {
  private ws: WebSocket | null = null;

  onMessage: MessageHandler = () => {};
  onOpen: () => void = () => {};
  onClose: (reason: string) => void = () => {};
  onProtocolError: (detail: string) => void = () => {};

  connect(url: string): void {
    this.close();
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => this.onOpen();
    ws.onclose = (e) => this.onClose(e.reason || `connection closed (${e.code})`);
    ws.onerror = () => {
      /* onclose follows with the useful signal */
    };
    ws.onmessage = (e) => {
      let json: unknown;
      try {
        json = JSON.parse(String(e.data));
      } catch {
        this.onProtocolError('unparseable frame from server');
        return;
      }
      const msg = parseServerMessage(json);
      if (!msg) {
        this.onProtocolError('server message failed schema validation');
        return;
      }
      this.onMessage(msg);
    };
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: ClientMessage): void {
    if (this.open) this.ws!.send(JSON.stringify(msg));
  }

  close(): void {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }
}
