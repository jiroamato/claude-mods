export declare const HEALTH: string
export declare function withBilling<B>(
  record: { billing?: readonly string[] } | null | undefined,
  blocks: readonly B[] | null | undefined,
): (B | { type: 'text'; text: string })[]
export declare function logRecords(payload: unknown): Record<string, unknown>[]
export declare function sessionFolder(id: unknown): string | null
export type ChainRecord = {
  seq: number
  source: string
  continues?: boolean
  after?: number | null
  toolCount: number
  from: number
  messageCount?: number
  added: readonly unknown[]
  unreadable?: number
  isHead?: boolean
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
  readonly sessions: Map<string, unknown>
  take(attributes: Record<string, unknown>): void
  prune(idleMs: number): void
}
