/**
 * HTML sanitizer for the formatted-view rendering pipeline (PRD §4.3, §7).
 *
 * Walks an existing DOM tree (or parses an HTML string) and returns a clean
 * HTML string limited to a small allowlist of structural tags. Inline styles,
 * scripts, and unknown attributes are stripped. Image references are preserved
 * verbatim — the renderer is responsible for resolving them.
 *
 * This is intentionally a hand-rolled walker rather than dompurify to avoid a
 * new runtime dependency for the redesign. The allowlist is small enough that
 * this is straightforward and easy to audit.
 */

const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'em', 'strong', 'b', 'i', 'u', 's', 'sub', 'sup',
  'blockquote', 'q', 'cite',
  'ul', 'ol', 'li',
  'dl', 'dt', 'dd',
  'a',
  'code', 'pre', 'kbd', 'samp', 'var',
  'img', 'figure', 'figcaption',
  'div', 'span',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
])

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'width', 'height']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan']),
}

const SAFE_URL_RE = /^(https?:|mailto:|#|\/)/i

function isSafeHref(href: string): boolean {
  return SAFE_URL_RE.test(href.trim())
}

/**
 * Recursively serialize an element with the allowlist applied.
 * Disallowed elements are unwrapped (their children are kept).
 */
function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeText(node.textContent ?? '')
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return ''
  }

  const el = node as Element
  const tag = el.tagName.toLowerCase()

  // Drop dangerous tags entirely (with their children).
  if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'iframe' || tag === 'object' || tag === 'embed') {
    return ''
  }

  // Unwrap disallowed tags — keep their children.
  if (!ALLOWED_TAGS.has(tag)) {
    return serializeChildren(el)
  }

  const attrs: string[] = []
  const allowed = ALLOWED_ATTRS[tag]
  if (allowed) {
    for (const name of allowed) {
      const value = el.getAttribute(name)
      if (value == null) continue
      if (name === 'href' && !isSafeHref(value)) continue
      if (name === 'src') {
        // Allow data: only for image data URIs (rare but valid for SVG covers).
        if (!/^(https?:|data:image\/|\/|covers\/|images\/)/.test(value)) continue
      }
      attrs.push(`${name}="${escapeAttr(value)}"`)
    }
  }

  // Self-closing tags
  if (tag === 'br' || tag === 'hr' || tag === 'img') {
    return `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''} />`
  }

  return `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>${serializeChildren(el)}</${tag}>`
}

function serializeChildren(el: Element): string {
  let out = ''
  for (const child of Array.from(el.childNodes)) {
    out += serializeNode(child)
  }
  return out
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** Sanitize a Document (or root Element) and return clean HTML. */
export function sanitizeDocument(doc: Document | Element): string {
  const root = 'body' in doc ? doc.body ?? doc.documentElement : doc
  return serializeChildren(root as Element).trim()
}

/** Parse a string of HTML and return its sanitized form. */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return sanitizeDocument(doc)
}

/**
 * Wrap a single block of text as a paragraph. Used for plain-text formats
 * (TXT/RTF) that need to produce a minimal HTML representation for the
 * formatted view.
 */
export function paragraphsToHtml(text: string): string {
  const blocks = text.split(/\n{2,}/)
  return blocks
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => `<p>${escapeText(b).replace(/\n/g, '<br />')}</p>`)
    .join('\n')
}
