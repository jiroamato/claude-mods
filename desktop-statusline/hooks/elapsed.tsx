import type { ClientSurface } from 'claude-code'
import { formatDuration } from './duration'

/** What the band hands the timer: how long the session has run, at the drawing. */
export type ElapsedProps = { ms: number }

type State = {
  /** The seconds the region has counted since it was born. */
  ticks: number
}

/** What each instance was last handed, and its count then, by its surface. */
const bases = new WeakMap<object, { ms: number; ticks: number }>()

/**
 * How long the session has run, a region with a clock of its own: it counts
 * the seconds itself, from the time the band last handed it, so the band is
 * not drawn again each second. A drawing of the band has the desktop paint
 * every element of the plugin's again, the pane's included, and a focused
 * field there blinks at each; a region's own state draws the region alone.
 * Each drawing of the band sets the count right.
 */
export default function Elapsed(props: ElapsedProps, surface: ClientSurface<State>) {
  const { Text } = surface.elements
  const ticks = surface.state?.ticks ?? 0
  const base = bases.get(surface)
  // Started once, with the instance.
  if (!base) surface.every(1000, () => surface.setState({ ticks: (surface.state?.ticks ?? 0) + 1 }))
  // New props: count on from them.
  if (!base || base.ms !== props.ms) bases.set(surface, { ms: props.ms, ticks })
  const since = bases.get(surface)!

  // Digits of one width: centred in its slot, the reading would otherwise
  // shift by a hair as each second's digits change.
  return (
    <Text color="secondaryText" tabular>
      {formatDuration(props.ms + (ticks - since.ticks) * 1000)}
    </Text>
  )
}
