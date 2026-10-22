/** A running time as the band writes it: `42s`, `8m 28s`, and past an hour `2h 5m`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)

  return `${hours}h ${minutes % 60}m`
}
