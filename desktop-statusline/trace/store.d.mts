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
  toolCount: number
  from: number
  added: readonly unknown[]
}
export declare function isMain(source: string): boolean
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
  )
  take(attributes: Record<string, unknown>): void
}
