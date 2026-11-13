//#region src/crypto.d.ts
export declare const hashWith: (algorithm: string, str: string) => Promise<Uint8Array>;
export declare const sha1: (str: string) => Promise<string>;
//#endregion
