declare const Buffer: any;

declare module "node:fs/promises" {
  export function readFile(path: string): Promise<any>;
  export function readFile(path: string, encoding: string): Promise<string>;
  export function writeFile(path: string, data: any): Promise<void>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<any>;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare module "node:timers/promises" {
  export function setImmediate<T = void>(value?: T): Promise<T>;
}
