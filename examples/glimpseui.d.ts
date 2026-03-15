declare module "glimpseui" {
  import type { EventEmitter } from "node:events";

  interface GlimpseOpenOptions {
    width?: number;
    height?: number;
    title?: string;
    frameless?: boolean;
    floating?: boolean;
    transparent?: boolean;
    clickThrough?: boolean;
    followCursor?: boolean;
    autoClose?: boolean;
    x?: number;
    y?: number;
    cursorOffset?: { x?: number; y?: number };
  }

  export interface GlimpseWindow extends EventEmitter {
    send(js: string): void;
    setHTML(html: string): void;
    close(): void;
    loadFile(path: string): void;
    followCursor(enabled: boolean): void;
  }

  export function open(html: string, options?: GlimpseOpenOptions): GlimpseWindow;
  export function prompt(
    html: string,
    options?: GlimpseOpenOptions & { timeout?: number },
  ): Promise<unknown>;
}
