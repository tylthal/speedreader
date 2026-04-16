import type { TocNode } from '../db/localClient'

export interface FlatTocLocation {
  key: string
  title: string
  sectionIndex: number
  htmlAnchor: string | null
  depth: number
  order: number
}

export function flattenTocLocations(
  nodes: ReadonlyArray<TocNode> | null | undefined,
): FlatTocLocation[] {
  if (!nodes?.length) return []

  const entries: FlatTocLocation[] = []
  let order = 0

  const visit = (branch: ReadonlyArray<TocNode>, parentKey: string, depth: number) => {
    branch.forEach((node, index) => {
      const key = parentKey ? `${parentKey}.${index}` : `${index}`
      entries.push({
        key,
        title: node.title,
        sectionIndex: node.section_index,
        htmlAnchor: node.html_anchor?.trim() ? node.html_anchor : null,
        depth,
        order: order++,
      })
      if (node.children?.length) visit(node.children, key, depth + 1)
    })
  }

  visit(nodes, '', 0)
  return entries
}

interface SelectActiveTocLocationKeyArgs {
  entries: ReadonlyArray<FlatTocLocation>
  currentSectionIndex: number
  currentArrayIndex: number | null
  preferredKey?: string | null
  resolveArrayIndex?: ((entry: FlatTocLocation) => number | null) | null
}

interface ResolvedTocLocation extends FlatTocLocation {
  targetArrayIndex: number | null
}

export function selectActiveTocLocationKey({
  entries,
  currentSectionIndex,
  currentArrayIndex,
  preferredKey,
  resolveArrayIndex,
}: SelectActiveTocLocationKeyArgs): string | null {
  const matching = entries.filter((entry) => entry.sectionIndex === currentSectionIndex)
  if (matching.length === 0) return null

  const preferred = preferredKey
    ? matching.find((entry) => entry.key === preferredKey) ?? null
    : null

  const resolved = matching.map<ResolvedTocLocation>((entry) => ({
    ...entry,
    targetArrayIndex:
      entry.htmlAnchor == null
        ? 0
        : resolveArrayIndex?.(entry) ?? null,
  }))

  const preferredResolved = preferred
    ? resolved.find((entry) => entry.key === preferred.key) ?? null
    : null

  if (preferredResolved) {
    if (preferredResolved.targetArrayIndex == null || currentArrayIndex == null) {
      return preferredResolved.key
    }
    if (currentArrayIndex <= preferredResolved.targetArrayIndex) {
      return preferredResolved.key
    }
  }

  const withTargets = resolved.filter((entry) => entry.targetArrayIndex != null)
  if (withTargets.length === 0 || currentArrayIndex == null) {
    if (preferred) return preferred.key
    return chooseDeepestLocationKey(matching)
  }

  const atOrBefore = withTargets.filter(
    (entry) => (entry.targetArrayIndex ?? -1) <= currentArrayIndex,
  )
  const pool = atOrBefore.length > 0 ? atOrBefore : withTargets

  pool.sort((a, b) => {
    const targetDiff =
      atOrBefore.length > 0
        ? (b.targetArrayIndex ?? -1) - (a.targetArrayIndex ?? -1)
        : (a.targetArrayIndex ?? Number.POSITIVE_INFINITY) -
          (b.targetArrayIndex ?? Number.POSITIVE_INFINITY)
    if (targetDiff !== 0) return targetDiff

    if (preferred && a.key === preferred.key) return -1
    if (preferred && b.key === preferred.key) return 1

    if (b.depth !== a.depth) return b.depth - a.depth
    return b.order - a.order
  })

  return pool[0]?.key ?? preferred?.key ?? chooseDeepestLocationKey(matching)
}

function chooseDeepestLocationKey(entries: ReadonlyArray<FlatTocLocation>): string | null {
  if (entries.length === 0) return null

  const sorted = [...entries].sort((a, b) => {
    if (b.depth !== a.depth) return b.depth - a.depth
    return b.order - a.order
  })

  return sorted[0]?.key ?? null
}
