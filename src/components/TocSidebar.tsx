import { memo, useState } from 'react'
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
  if (!open) return null

  const useTree = Array.isArray(tocTree) && tocTree.length > 0

  return (
    <div
      className="toc-sidebar"
      role="dialog"
      aria-modal="true"
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
          {useTree ? (
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
            <ul className="toc-sidebar__list" role="list">
              {chapters.map((ch, idx) => {
                const tocKey = `${idx}`
                const isActive =
                  tocKey === activeLocationKey ||
                  (
                    activeLocationTitle === (ch.title || 'Untitled') &&
                    activeLocationSectionIndex === idx &&
                    (activeLocationAnchor ?? null) == null
                  )
                return (
                  <li key={ch.id}>
                    <button
                      className={`toc-sidebar__item${isActive ? ' toc-sidebar__item--active' : ''}`}
                      data-toc-key={tocKey}
                      data-section-index={idx}
                      data-html-anchor=""
                      onClick={() => {
                        onJump(idx, null, tocKey)
                        onClose()
                      }}
                    >
                      <span className="toc-sidebar__item-title">
                        {ch.title || 'Untitled'}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </nav>
      </aside>
    </div>
  )
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
  const [expanded, setExpanded] = useState(true)
  const isLeaf = node.section_index >= 0
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
