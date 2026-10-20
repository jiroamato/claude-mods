/** The receiver's pages (view.mjs), typed for the plugin's tests. */

type Record = {
  seq: number
  source: string
  from: number
  added: unknown[]
  [key: string]: unknown
}
type Link = (session: string, seq?: number) => string

export declare function escapeHtml(text: string): string
export declare function fullMessages(records: Record[], seq: number): unknown[] | null
export declare function requestPage(args: {
  session: string
  records: Record[]
  seq: number
  system: { type: string; text: string }[] | null
  tools: { name?: string }[] | null
  link: Link
}): string | null
export declare function sessionPage(args: {
  session: string
  records: Record[]
  link: Link
}): string
