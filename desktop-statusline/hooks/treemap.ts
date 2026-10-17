import type { BlockKind, ContextBlock } from '../types'

// Fixed tile colours: an SVG cannot read the theme, and these hold their
// contrast on both the light and the dark band.
export const BLOCK_COLOR: Record<BlockKind, string> = {
  system: '#7a7872',
  tools: '#5b78d6',
  mcp: '#3aa6a6',
  agents: '#a27bd0',
  memory: '#d08a3a',
  skills: '#b99a2a',
  conversation: '#8b6fd6',
  result: '#c95a5a',
  free: '#3a3a37',
}

type Tile = ContextBlock & { x: number; y: number; w: number; h: number }

/** Lays the blocks out as a squarified treemap filling `w` by `h`, largest first. */
export function squarify(blocks: readonly ContextBlock[], w: number, h: number): Tile[] {
  const items = blocks.filter(one => one.tokens > 0).sort((a, b) => b.tokens - a.tokens)
  const total = items.reduce((sum, one) => sum + one.tokens, 0)
  if (total === 0) return []
  const scale = (w * h) / total
  const tiles: Tile[] = []
  let rect = { x: 0, y: 0, w, h }
  let row: { block: ContextBlock; area: number }[] = []

  const worst = (areas: number[], side: number): number => {
    const sum = areas.reduce((a, b) => a + b, 0)
    const max = Math.max(...areas)
    const min = Math.min(...areas)

    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min))
  }
  const place = (): void => {
    const sum = row.reduce((a, one) => a + one.area, 0)
    if (rect.w >= rect.h) {
      const width = sum / rect.h
      let y = rect.y
      for (const one of row) {
        const height = one.area / width
        tiles.push({ ...one.block, x: rect.x, y, w: width, h: height })
        y += height
      }
      rect = { x: rect.x + width, y: rect.y, w: rect.w - width, h: rect.h }
    } else {
      const height = sum / rect.w
      let x = rect.x
      for (const one of row) {
        const width = one.area / height
        tiles.push({ ...one.block, x, y: rect.y, w: width, h: height })
        x += width
      }
      rect = { x: rect.x, y: rect.y + height, w: rect.w, h: rect.h - height }
    }
    row = []
  }

  for (const block of items) {
    const area = block.tokens * scale
    const side = Math.min(rect.w, rect.h)
    const areas = row.map(one => one.area)
    if (row.length === 0 || worst([...areas, area], side) <= worst(areas, side)) {
      row.push({ block, area })
    } else {
      place()
      row.push({ block, area })
    }
  }
  if (row.length > 0) place()

  return tiles
}

/** `1000000` -> `1M`, `41234` -> `41k`, `4123` -> `4.1k`, `412` -> `412`. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`

  return String(Math.round(tokens))
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function clip(text: string, width: number): string {
  const max = Math.floor(width / 6.2)
  if (text.length <= max) return text

  return max <= 1 ? '' : `${text.slice(0, max - 1)}…`
}

/** The treemap as SVG markup; each tile names itself in a `<title>` tooltip. */
export function treemapSvg(blocks: readonly ContextBlock[], w: number, h: number): string {
  const gap = 1.5
  let body = ''
  for (const tile of squarify(blocks, w, h)) {
    const x = tile.x + gap / 2
    const y = tile.y + gap / 2
    const tw = Math.max(0, tile.w - gap)
    const th = Math.max(0, tile.h - gap)
    const ink = tile.kind === 'free' ? '#9a988f' : '#ffffff'
    const name = escapeXml(tile.label)
    body +=
      `<g><title>${name}: ${formatTokens(tile.tokens)} tokens</title>` +
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${tw.toFixed(1)}" height="${th.toFixed(1)}" rx="3" fill="${BLOCK_COLOR[tile.kind]}"/>`
    if (tw > 58 && th > 30) {
      body +=
        `<text x="${(x + 6).toFixed(1)}" y="${(y + 15).toFixed(1)}" font-size="11" font-weight="600" fill="${ink}">${escapeXml(clip(tile.label, tw - 10))}</text>` +
        `<text x="${(x + 6).toFixed(1)}" y="${(y + 28).toFixed(1)}" font-size="10.5" fill="${ink}" fill-opacity="0.75">${formatTokens(tile.tokens)}</text>`
    } else if (tw > 28 && th > 15) {
      body += `<text x="${(x + 4).toFixed(1)}" y="${(y + 12).toFixed(1)}" font-size="10" fill="${ink}" fill-opacity="0.85">${formatTokens(tile.tokens)}</text>`
    }
    body += '</g>'
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="system-ui, sans-serif">` +
    body +
    `</svg>`
  )
}
