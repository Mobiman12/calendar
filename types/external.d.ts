declare module "jszip" {
  export default class JSZip {
    constructor();
    file(name: string, data: string | Uint8Array | Buffer): JSZip;
    generateAsync(options: { type: "nodebuffer" }): Promise<Buffer>;
  }
}

declare module "pino" {
  export interface Logger {
    info(obj: any, msg?: string): void;
    warn(obj: any, msg?: string): void;
    error(obj: any, msg?: string): void;
    debug?(obj: any, msg?: string): void;
    child?(bindings: Record<string, unknown>): Logger;
  }

  export default function pino(options?: { level?: string }): Logger;
}

declare module "bullmq" {
  export class Queue<T = any, R = any, N = string> {
    constructor(name: string, options?: any);
    add(name: N, data: T, options?: any): Promise<any>;
    close(): Promise<void>;
    waitUntilReady?(): Promise<void>;
  }

  export class Worker<T = any, R = any, N = string> {
    constructor(name: string, processor: (job: { name: N; data: T; id?: string }) => Promise<R>, options?: any);
    on(event: string, handler: (...args: any[]) => void): this;
    close(): Promise<void>;
  }
}
