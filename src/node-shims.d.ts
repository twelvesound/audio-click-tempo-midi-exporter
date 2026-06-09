declare const Buffer: any;

declare module "node:fs/promises" {
  export function readFile(path: string): Promise<any>;
  export function writeFile(path: string, data: any): Promise<void>;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}
