// Minimal types for the `ws` package (installed with viem) as test/watchdog.test.ts uses it: a local JSON-RPC
// WebSocket server for the stuck-socket reproduction.
declare module "ws" {
  interface Peer { send(data: string): void; terminate(): void; on(ev: "message", f: (m: unknown) => void): void }
  export class WebSocketServer {
    constructor(opts: { host: string; port: number }, ready?: () => void);
    clients: Set<Peer>;
    on(ev: "connection", f: (c: Peer) => void): void;
    close(cb?: () => void): void;
  }
}
