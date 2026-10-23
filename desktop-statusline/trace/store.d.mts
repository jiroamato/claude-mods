/** The receiver's logic (store.mjs), typed for the plugin's tests. */

export declare const HEALTH: string
export declare function withBilling<B>(
  record: { billing?: readonly string[] } | null | undefined,
  blocks: readonly B[] | null | undefined,
): (B | { type: 'text'; text: string })[]
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
  /** The conversation's length with this request's messages. */
  messageCount?: number
  added: readonly unknown[]
  /** For one that could not be read: how long its body was. */
  unreadable?: number
  /** A head (`<seq>.head.json`): the request without its messages, which `added` leaves out. */
  isHead?: boolean
  /** For a head: the role of each message it added. */
  roles?: readonly string[]
}
export declare const HEAD_AFTER_BYTES: number
export declare function headMessages(record: ChainRecord): { role: string; content: string }[]
export declare function isMain(source: string): boolean
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
    now?: () => number,
  )
  /** Per session: what the receiver holds of it in memory. */
  readonly sessions: Map<string, unknown>
  take(attributes: Record<string, unknown>): void
  /** Drops the state of every session that sent nothing for `idleMs`. */
  prune(idleMs: number): void
}
