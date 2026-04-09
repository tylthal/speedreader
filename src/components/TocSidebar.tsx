import { useState } from 'react'
import type { Chapter, TocNode } from '../api/client'

interface TocSidebarProps {
  open: boolean
  chapters: Chapter[]
  /** Hierarchical TOC tree from NCX/PDF outline (PRD §6.4). */
  tocTree?: TocNode[] | null
  currentSectionIndex: number
  onJump: (sectionIndex: number, htmlAnchor?: string | null) => void
  onClose: () => void
}

/**
 * Reader TOC sidebar (PRD §6.4).
 *
 * Renders either a flat list of sections (from `chapters`) or a tree (from
 * `tocTree`) when the source has hierarchical NCX/outline data. Tapping a
 * leaf jumps the reader to the first segment of that section.
 */
export default function TocSidebar({
  open,
  chapters,
  tocTree,
  currentSectionIndex,
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
              currentSectionIndex={currentSectionIndex}
              onJump={(idx, htmlAnchor) => {
                onJump(idx, htmlAnchor)
                onClose()
              }}
            />
          ) : (
            <ul className="toc-sidebar__list" role="list">
              {chapters.map((ch, idx) => (
                <li key={ch.id}>
                  <button
                    className={`toc-sidebar__item${idx === currentSectionIndex ? ' toc-sidebar__item--active' : ''}`}
                    onClick={() => {
                      onJump(idx, null)
                      onClose()
                    }}
                  >
                    <span className="toc-sidebar__item-title">
                      {ch.title || 'Untitled'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>
      </aside>
    </div>
  )
}

interface TocTreeProps {
  nodes: TocNode[]
  currentSectionIndex: number
  onJump: (sectionIndex: number, htmlAnchor?: string | null) => void
  depth?: number
}

function TocTree({ nodes, currentSectionIndex, onJump, depth = 0 }: TocTreeProps) {
  return (
    <ul className="toc-sidebar__list" role="list">
      {nodes.map((node, i) => (
        <TocTreeItem
          key={`${depth}-${i}-${node.title}`}
          node={node}
          currentSectionIndex={currentSectionIndex}
          onJump={onJump}
          depth={depth}
        />
      ))}
    </ul>
  )
}

function TocTreeItem({
  node,
  currentSectionIndex,
  onJump,
  depth,
}: {
  node: TocNode
  currentSectionIndex: number
  onJump: (sectionIndex: number, htmlAnchor?: string | null) => void
  depth: number
}) {
  const hasChildren = Array.isArray(node.children) && node.children.length > 0
  const [expanded, setExpanded] = useState(true)
  const isLeaf = node.section_index >= 0
  const isActive = isLeaf && node.section_index === currentSectionIndex

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
            onClick={() => onJump(node.section_index, node.html_anchor ?? null)}
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
          currentSectionIndex={currentSectionIndex}
          onJump={onJump}
          depth={depth + 1}
        />
      )}
    </li>
  )
}
