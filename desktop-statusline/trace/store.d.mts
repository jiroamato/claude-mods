/** The receiver's logic (store.mjs), typed for the plugin's tests. */

export declare const HEALTH: string
export declare const KEPT_EVENTS: Set<string>
export declare function hashText(text: string): string
export declare function isBillingBlock(block: unknown): boolean
export declare function logRecords(payload: unknown): Record<string, unknown>[]
export declare function sessionFolder(id: unknown): string | null
export declare class TraceStore {
  constructor(write: (name: string, text: string) => void, firstSeq?: (folder: string) => number)
  take(attributes: Record<string, unknown>): void
}
