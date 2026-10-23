import type { ClientSurface } from 'claude-code'
import { formatDuration } from './duration'

export type ElapsedProps = { ms: number }

type State = {
  ticks: number
}

const bases = new WeakMap<object, { ms: number; ticks: number }>()

export default function Elapsed(props: ElapsedProps, surface: ClientSurface<State>) {
  const { Text } = surface.elements
  const ticks = surface.state?.ticks ?? 0
  const base = bases.get(surface)
  if (!base) surface.every(1000, () => surface.setState({ ticks: (surface.state?.ticks ?? 0) + 1 }))
  if (!base || base.ms !== props.ms) bases.set(surface, { ms: props.ms, ticks })
  const since = bases.get(surface)!

  return (
    <Text color="secondaryText" tabular>
      {formatDuration(props.ms + (ticks - since.ticks) * 1000)}
    </Text>
  )
}
