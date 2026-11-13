import { BaseRoomConfig, RelayConfig, SocketClient } from "./types.mjs";
//#region src/utils.d.ts
export declare const libName = "Trystero";
export declare const genId: (n: number) => string;
export declare const selfId: string;
export declare const all: {
  <T>(values: Iterable<T | PromiseLike<T>>): Promise<Awaited<T>[]>;
  <T extends readonly unknown[] | []>(values: T): Promise<{ -readonly [P in keyof T]: Awaited<T[P]>; }>;
};
declare const entries: {
  <T>(o: {
    [s: string]: T;
  } | ArrayLike<T>): [string, T][];
  (o: {}): [string, any][];
}, fromEntries: {
  <T = any>(entries: Iterable<readonly [PropertyKey, T]>): {
    [k: string]: T;
  };
  (entries: Iterable<readonly any[]>): any;
}, keys: {
  (o: object): string[];
  (o: {}): string[];
}, values: {
  <T>(o: {
    [s: string]: T;
  } | ArrayLike<T>): T[];
  (o: {}): any[];
};
export declare const encodeBytes: (txt: string) => Uint8Array;
export declare const decodeBytes: (buffer: ArrayBufferLike | ArrayBufferView) => string;
export declare const toHex: (buffer: Uint8Array) => string;
export declare const getRelays: <TConfig extends BaseRoomConfig & {
  relayConfig?: RelayConfig;
}>(config: TConfig, defaults: string[], defaultN: number, deriveFromAppId?: boolean) => string[];
export declare const toJson: {
  (value: any, replacer?: (this: any, key: string, value: any) => any, space?: string | number): string;
  (value: any, replacer?: (number | string)[] | null, space?: string | number): string;
};
export declare const fromJson: <T>(s: string) => T;
export declare const strToNum: (str: string, limit?: number) => number;
export declare const pauseRelayReconnection: () => void;
export declare const resumeRelayReconnection: () => void;
export declare const makeSocket: (url: string, onMessage: (data: string) => void, onReconnect?: () => void) => SocketClient;
export declare const socketGetter: <T extends {
  socket: WebSocket;
}>(clientMap: Record<string, T>) => (() => Record<string, WebSocket>);
type RelayScopedStore<T, TRelay extends object> = {
  forKey: (key: string) => Record<string, T>;
  forRelay: (relay: TRelay) => Record<string, T>;
};
export declare const createRelayManager: <TRelay extends object>(getSocket: (relay: TRelay) => WebSocket | undefined) => {
  register: (key: string, createRelay: () => TRelay) => TRelay;
  keyOf: (relay: TRelay) => string;
  scoped: <T>() => RelayScopedStore<T, TRelay>;
  getSockets: () => Record<string, WebSocket>;
};
//#endregion
export { entries, keys, values };
