export interface InternalTocNode {
  title: string
  sectionIndex: number
  htmlAnchor?: string | null
  children?: InternalTocNode[]
}

export function mapTocTree<T>(
  nodes: ReadonlyArray<InternalTocNode> | null | undefined,
  mapNode: (node: InternalTocNode, children: T[] | undefined) => T,
): T[] | undefined {
  if (!nodes?.length) return undefined
  return nodes.map((node) =>
    mapNode(node, mapTocTree(node.children, mapNode)),
  )
}

export function cloneTocTree(
  nodes: ReadonlyArray<InternalTocNode> | null | undefined,
): InternalTocNode[] | undefined {
  return mapTocTree(nodes, (node, children) => ({
    title: node.title,
    sectionIndex: node.sectionIndex,
    htmlAnchor: node.htmlAnchor ?? null,
    children,
  }))
}

export function parseTocTreeJson(json: string | null | undefined): InternalTocNode[] | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as InternalTocNode[]
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}
