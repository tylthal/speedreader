import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { FixedSizeList as List } from 'react-window'
import type { ListChildComponentProps } from 'react-window'
import type { Chapter, TocNode } from '../api/client'

interface TocSidebarProps {
  open: boolean
  chapters: Chapter[]
  /** Hierarchical TOC tree from NCX/PDF outline (PRD §6.4). */
  tocTree?: TocNode[] | null
  activeLocationKey?: string | null
  activeLocationTitle?: string | null
  activeLocationSectionIndex?: number | null
  activeLocationAnchor?: string | null
  onJump: (sectionIndex: number, htmlAnchor: string | null, tocKey: string) => void
  onClose: () => void
}

/**
 * Reader TOC sidebar (PRD §6.4).
 *
 * Renders either a flat list of sections (from `chapters`) or a tree (from
 * `tocTree`) when the source has hierarchical NCX/outline data. Tapping a
 * leaf jumps the reader to the first segment of that section.
 */
function TocSidebar({
  open,
  chapters,
  tocTree,
  activeLocationKey,
  activeLocationTitle,
  activeLocationSectionIndex,
  activeLocationAnchor,
  onJump,
  onClose,
}: TocSidebarProps) {
  const useTree = Array.isArray(tocTree) && tocTree.length > 0
  const listRef = useRef<List>(null)
  const [listHeight, setListHeight] = useState(360)

  const flatTreeRows = useMemo(() => flattenLeafRows(tocTree ?? null), [tocTree])
  const useVirtualTreeRows =
    useTree &&
    flatTreeRows.length > 0 &&
    flatTreeRows.every((row) => row.depth === 0 && !row.hasChildren && row.isLeaf)
  const virtualRows = useMemo<VirtualTocRow[]>(() => {
    if (useVirtualTreeRows) {
      return flatTreeRows.map((row) => ({
        key: row.key,
        title: row.title || 'Untitled',
        sectionIndex: row.sectionIndex,
        htmlAnchor: row.htmlAnchor,
        depth: row.depth,
      }))
    }

    if (useTree) return []

    return chapters.map((chapter, index) => ({
      key: `${index}`,
      title: chapter.title || 'Untitled',
      sectionIndex: index,
      htmlAnchor: null,
      depth: 0,
    }))
  }, [chapters, flatTreeRows, useTree, useVirtualTreeRows])

  useEffect(() => {
    if (useTree && !useVirtualTreeRows) return

    const updateHeight = () => {
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight
      const nextHeight = Math.max(160, Math.floor(viewportHeight - 84))
      setListHeight((prev) => (prev === nextHeight ? prev : nextHeight))
    }

    updateHeight()
    window.visualViewport?.addEventListener('resize', updateHeight)
    window.addEventListener('resize', updateHeight)
    return () => {
      window.visualViewport?.removeEventListener('resize', updateHeight)
      window.removeEventListener('resize', updateHeight)
    }
  }, [useTree, useVirtualTreeRows])

  const activeFlatIndex = useMemo(() => {
    return virtualRows.findIndex((row) => (
      row.key === activeLocationKey ||
      (
        activeLocationTitle === row.title &&
        activeLocationSectionIndex === row.sectionIndex &&
        (activeLocationAnchor ?? null) === row.htmlAnchor
      )
    ))
  }, [
    virtualRows,
    activeLocationKey,
    activeLocationTitle,
    activeLocationSectionIndex,
    activeLocationAnchor,
  ])

  useEffect(() => {
    if (!open) return
    if (useTree && !useVirtualTreeRows) return
    if (activeFlatIndex < 0) return
    let rafId = 0
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    rafId = requestAnimationFrame(() => {
      timeoutId = setTimeout(() => {
        listRef.current?.scrollToItem(activeFlatIndex, 'center')
      }, 0)
    })
    return () => {
      cancelAnimationFrame(rafId)
      if (timeoutId) clearTimeout(timeoutId)
    }
  }, [open, useTree, useVirtualTreeRows, activeFlatIndex])

  return (
    <div
      className={`toc-sidebar${open ? ' toc-sidebar--open' : ' toc-sidebar--closed'}`}
      role={open ? 'dialog' : undefined}
      aria-modal={open ? 'true' : undefined}
      aria-hidden={open ? undefined : 'true'}
      aria-label="Table of contents"
    >
      <div className="toc-sidebar__backdrop" onClick={onClose} />
      <aside className="toc-sidebar__panel">
        <header className="toc-sidebar__header">
          <h2 className="toc-sidebar__title">Contents</h2>
          <button
            className="toc-sidebar__close"
            onClick={onClose}
            aria-label="Close table of contents"
          >
            &#x2715;
          </button>
        </header>

        <nav className="toc-sidebar__nav">
          {useTree && !useVirtualTreeRows ? (
            <TocTree
              nodes={tocTree!}
              activeLocationKey={activeLocationKey ?? null}
              activeLocationTitle={activeLocationTitle ?? null}
              activeLocationSectionIndex={activeLocationSectionIndex ?? null}
              activeLocationAnchor={activeLocationAnchor ?? null}
              onJump={(idx, htmlAnchor, tocKey) => {
                onJump(idx, htmlAnchor, tocKey)
                onClose()
              }}
            />
          ) : (
            <List
              ref={listRef}
              className="toc-sidebar__virtual-list"
              height={listHeight}
              width="100%"
              itemCount={virtualRows.length}
              itemSize={46}
              overscanCount={10}
              itemData={{
                rows: virtualRows,
                activeLocationKey: activeLocationKey ?? null,
                activeLocationTitle: activeLocationTitle ?? null,
                activeLocationSectionIndex: activeLocationSectionIndex ?? null,
                activeLocationAnchor: activeLocationAnchor ?? null,
                onJump,
                onClose,
              }}
            >
              {FlatTocRow}
            </List>
          )}
        </nav>
      </aside>
    </div>
  )
}

interface FlatTocRowData {
  rows: VirtualTocRow[]
  activeLocationKey: string | null
  activeLocationTitle: string | null
  activeLocationSectionIndex: number | null
  activeLocationAnchor: string | null
  onJump: (sectionIndex: number, htmlAnchor: string | null, tocKey: string) => void
  onClose: () => void
}

function FlatTocRow({
  index,
  style,
  data,
}: ListChildComponentProps<FlatTocRowData>) {
  const row = data.rows[index]
  if (!row) return null
  const isActive =
    row.key === data.activeLocationKey ||
    (
      data.activeLocationTitle === row.title &&
      data.activeLocationSectionIndex === row.sectionIndex &&
      (data.activeLocationAnchor ?? null) === row.htmlAnchor
    )

  return (
    <div style={style} className="toc-sidebar__virtual-row">
      <button
        className={`toc-sidebar__item${isActive ? ' toc-sidebar__item--active' : ''}`}
        data-toc-key={row.key}
        data-section-index={row.sectionIndex}
        data-html-anchor={row.htmlAnchor ?? ''}
        onClick={() => {
          data.onJump(row.sectionIndex, row.htmlAnchor, row.key)
          data.onClose()
        }}
      >
        <span className="toc-sidebar__item-title">
          {row.title}
        </span>
      </button>
    </div>
  )
}

interface VirtualTocRow {
  key: string
  title: string
  sectionIndex: number
  htmlAnchor: string | null
  depth: number
}

interface FlatTreeRow extends VirtualTocRow {
  hasChildren: boolean
  isLeaf: boolean
}

function flattenLeafRows(
  nodes: TocNode[] | null,
  parentKey = '',
  depth = 0,
): FlatTreeRow[] {
  if (!nodes?.length) return []

  return nodes.flatMap((node, index) => {
    const key = parentKey ? `${parentKey}.${index}` : `${index}`
    const hasChildren = Array.isArray(node.children) && node.children.length > 0
    const row: FlatTreeRow = {
      key,
      title: node.title || 'Untitled',
      sectionIndex: node.section_index,
      htmlAnchor: node.html_anchor?.trim() ? node.html_anchor : null,
      depth,
      hasChildren,
      isLeaf: node.section_index >= 0,
    }

    return [row, ...flattenLeafRows(node.children ?? null, key, depth + 1)]
  })
}

interface TocTreeProps {
  nodes: TocNode[]
  activeLocationKey: string | null
  activeLocationTitle: string | null
  activeLocationSectionIndex: number | null
  activeLocationAnchor: string | null
  onJump: (sectionIndex: number, htmlAnchor: string | null, tocKey: string) => void
  depth?: number
  parentKey?: string
}

function TocTree({
  nodes,
  activeLocationKey,
  activeLocationTitle,
  activeLocationSectionIndex,
  activeLocationAnchor,
  onJump,
  depth = 0,
  parentKey = '',
}: TocTreeProps) {
  return (
    <ul className="toc-sidebar__list" role="list">
      {nodes.map((node, i) => {
        const nodeKey = parentKey ? `${parentKey}.${i}` : `${i}`
        return (
          <TocTreeItem
            key={nodeKey}
            node={node}
            nodeKey={nodeKey}
            activeLocationKey={activeLocationKey}
            activeLocationTitle={activeLocationTitle}
            activeLocationSectionIndex={activeLocationSectionIndex}
            activeLocationAnchor={activeLocationAnchor}
            onJump={onJump}
            depth={depth}
          />
        )
      })}
    </ul>
  )
}

function TocTreeItem({
  node,
  nodeKey,
  activeLocationKey,
  activeLocationTitle,
  activeLocationSectionIndex,
  activeLocationAnchor,
  onJump,
  depth,
}: {
  node: TocNode
  nodeKey: string
  activeLocationKey: string | null
  activeLocationTitle: string | null
  activeLocationSectionIndex: number | null
  activeLocationAnchor: string | null
  onJump: (sectionIndex: number, htmlAnchor: string | null, tocKey: string) => void
  depth: number
}) {
  const hasChildren = Array.isArray(node.children) && node.children.length > 0
  const isLeaf = node.section_index >= 0
  const activeBranch =
    activeLocationKey === nodeKey ||
    (activeLocationKey?.startsWith(`${nodeKey}.`) ?? false)
  const [expanded, setExpanded] = useState(() => depth === 0 || activeBranch)
  const isActive =
    activeLocationKey === nodeKey ||
    (
      activeLocationTitle === (node.title || 'Untitled') &&
      activeLocationSectionIndex === node.section_index &&
      (activeLocationAnchor ?? null) === (node.html_anchor ?? null)
    )

  return (
    <li>
      <div
        className="toc-sidebar__row"
        style={{ paddingLeft: `${depth * 0.85 + 0.75}rem` }}
      >
        {hasChildren ? (
          <button
            className="toc-sidebar__expand"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? 'Collapse section' : 'Expand section'}
            aria-expanded={expanded}
          >
            {expanded ? '\u25BE' : '\u25B8'}
          </button>
        ) : (
          <span className="toc-sidebar__expand toc-sidebar__expand--placeholder" />
        )}
        {isLeaf ? (
          <button
            className={`toc-sidebar__item${isActive ? ' toc-sidebar__item--active' : ''}`}
            data-toc-key={nodeKey}
            data-section-index={node.section_index}
            data-html-anchor={node.html_anchor ?? ''}
            onClick={() => onJump(node.section_index, node.html_anchor ?? null, nodeKey)}
          >
            <span className="toc-sidebar__item-title">{node.title || 'Untitled'}</span>
          </button>
        ) : (
          <span className="toc-sidebar__item toc-sidebar__item--parent">
            <span className="toc-sidebar__item-title">{node.title || 'Untitled'}</span>
          </span>
        )}
      </div>
      {hasChildren && expanded && (
        <TocTree
          nodes={node.children!}
          activeLocationKey={activeLocationKey}
          activeLocationTitle={activeLocationTitle}
          activeLocationSectionIndex={activeLocationSectionIndex}
          activeLocationAnchor={activeLocationAnchor}
          onJump={onJump}
          depth={depth + 1}
          parentKey={nodeKey}
        />
      )}
    </li>
  )
}

const MemoizedTocSidebar = memo(TocSidebar)
MemoizedTocSidebar.displayName = 'TocSidebar'

export default MemoizedTocSidebar
