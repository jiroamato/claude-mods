/** The receiver's logic (store.mjs), typed for the plugin's tests. */

export declare const HEALTH: string
export declare const KEPT_EVENTS: Set<string>
export declare function hashText(text: string): string
export declare function isBillingBlock(block: unknown): boolean
export declare function logRecords(payload: unknown): Record<string, unknown>[]
export declare function sessionFolder(id: unknown): string | null
/** What the chain of a session's requests is read by: the fields every kept request has. */
export type ChainRecord = {
  seq: number
  source: string
  continues?: boolean
  /** For one that goes on: the request it goes on from. */
  after?: number | null
  toolCount: number
  from: number
  added: readonly unknown[]
  /** For one that could not be read: how long its body was. */
  unreadable?: number
}
export declare function isMain(source: string): boolean
export declare function sourceKind(source: string): string
export declare function goesOn(record: ChainRecord, hasBefore: boolean): boolean
export declare function promptRecord<R extends ChainRecord>(
  records: readonly R[],
  seq: number,
): R | null
export declare function fullMessages<R extends ChainRecord>(
  records: readonly R[],
  seq: number,
): R['added'][number][] | null
export declare class TraceStore {
  constructor(
    write: (name: string, text: string) => void,
    firstSeq?: (folder: string) => number,
    exists?: (name: string) => boolean,
    read?: (folder: string) => readonly ChainRecord[],
  )
  take(attributes: Record<string, unknown>): void
}
