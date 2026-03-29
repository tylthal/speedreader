"""Phrase-based text chunker for speed-reading segments."""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass
class Segment:
    index: int
    text: str
    word_count: int
    duration_ms: int


# ---------------------------------------------------------------------------
# Sentence splitting
# ---------------------------------------------------------------------------

# Common abbreviations that should NOT trigger a sentence split.
_ABBREVIATIONS = frozenset({
    "mr", "mrs", "ms", "dr", "st", "vs", "etc", "prof", "sr", "jr",
    "gen", "gov", "sgt", "cpl", "pvt", "capt", "lt", "col", "maj",
    "dept", "univ", "inc", "corp", "ltd", "co", "jan", "feb", "mar",
    "apr", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
})

# Two-letter abbreviations that always end with a dot: "e.g.", "i.e."
_DOTTED_ABBREVS_RE = re.compile(
    r"\b(?:e\.g|i\.e|a\.m|p\.m|a\.k\.a|U\.S|U\.K)\.",
    re.IGNORECASE,
)

# Placeholder unlikely to appear in real text
_ABBR_PLACEHOLDER = "\x00ABBR\x00"

# Sentence boundary: sentence-ending punctuation, optional closing quotes /
# parens, then whitespace, then an uppercase letter or end of string.
_SENTENCE_SPLIT_RE = re.compile(
    r'([.!?]["\'\)\]]?)\s+(?=[A-Z])',
)


def _split_sentences(text: str) -> list[str]:
    """Split *text* into sentences, respecting common abbreviations."""
    if not text:
        return []

    # Protect dotted abbreviations like "e.g." and "i.e."
    protected = _DOTTED_ABBREVS_RE.sub(
        lambda m: m.group().replace(".", _ABBR_PLACEHOLDER), text
    )

    # Protect simple abbreviations: word boundary + abbrev + "."
    def _protect_abbr(m: re.Match) -> str:
        return m.group().replace(".", _ABBR_PLACEHOLDER)

    abbr_pattern = re.compile(
        r"\b(" + "|".join(re.escape(a) for a in sorted(_ABBREVIATIONS, key=len, reverse=True)) + r")\.",
        re.IGNORECASE,
    )
    protected = abbr_pattern.sub(_protect_abbr, protected)

    # Split on sentence boundaries
    parts = _SENTENCE_SPLIT_RE.split(protected)

    # Re-assemble: parts alternate between text and the captured punctuation
    sentences: list[str] = []
    i = 0
    while i < len(parts):
        piece = parts[i]
        # If the next part is a captured punctuation group, append it
        if i + 1 < len(parts):
            piece += parts[i + 1]
            i += 2
        else:
            i += 1
        restored = piece.replace(_ABBR_PLACEHOLDER, ".").strip()
        if restored:
            sentences.append(restored)

    return sentences


# ---------------------------------------------------------------------------
# Phrase splitting
# ---------------------------------------------------------------------------

_PHRASE_DELIMITERS_RE = re.compile(r"(?<=[,;:\u2014)(\]])\s+|\s+(?=[\u2014(])")

_CONJUNCTIONS = frozenset({
    "and", "but", "or", "nor", "yet", "so", "for",
    "which", "that", "who", "when", "where", "while",
    "although", "because", "since", "if", "unless",
})


def _split_at_conjunctions(words: list[str], max_words: int = 7) -> list[list[str]]:
    """Try to split a word list at a conjunction near the middle."""
    if len(words) <= max_words:
        return [words]

    # Find conjunction positions (not first or last word)
    conj_positions = [
        i for i, w in enumerate(words)
        if w.lower().rstrip(".,;:!?") in _CONJUNCTIONS and 1 <= i < len(words) - 1
    ]

    if conj_positions:
        # Pick the conjunction closest to the midpoint
        mid = len(words) // 2
        best = min(conj_positions, key=lambda p: abs(p - mid))
        left = words[:best]
        right = words[best:]
        # Recursively split if still too long
        result: list[list[str]] = []
        result.extend(_split_at_conjunctions(left, max_words))
        result.extend(_split_at_conjunctions(right, max_words))
        return result

    # No conjunction found — split at midpoint
    mid = len(words) // 2
    return [words[:mid], words[mid:]]


def _split_into_phrases(sentence: str) -> list[str]:
    """Split a sentence into reading-friendly phrases of ~3-5 words."""
    # First pass: split at punctuation delimiters
    raw_phrases = _PHRASE_DELIMITERS_RE.split(sentence)

    result: list[str] = []
    for phrase in raw_phrases:
        phrase = phrase.strip()
        if not phrase:
            continue
        words = phrase.split()
        if not words:
            continue

        if len(words) <= 7:
            result.append(phrase)
        else:
            # Try conjunction splitting, then midpoint fallback
            for chunk_words in _split_at_conjunctions(words, max_words=7):
                if chunk_words:
                    result.append(" ".join(chunk_words))

    return result


# ---------------------------------------------------------------------------
# Duration calculation
# ---------------------------------------------------------------------------

_LONG_WORD_THRESHOLD = 8


def _compute_duration(text: str, word_count: int, wpm: int) -> int:
    """Compute display duration in milliseconds for a chunk."""
    if word_count == 0:
        return 0

    base_ms = (word_count / wpm) * 60_000

    # Punctuation pauses (check the *last* character of the trimmed text)
    stripped = text.rstrip()
    if stripped:
        last_char = stripped[-1]
        if last_char in ".!?":
            base_ms += 300
        elif last_char in ",;":
            base_ms += 150
        elif last_char == ":":
            base_ms += 200

    # Long-word penalty
    words = text.split()
    long_words = sum(1 for w in words if len(w) > _LONG_WORD_THRESHOLD)
    base_ms += long_words * 50

    return max(1, round(base_ms))


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def chunk_text(text: str, wpm: int = 250) -> list[Segment]:
    """Split *text* into speed-reading segments with timing metadata.

    Parameters
    ----------
    text:
        Plain text (typically one chapter).
    wpm:
        Target words-per-minute for duration calculation.

    Returns
    -------
    list[Segment]
        Ordered list of segments ready for the reading UI.
    """
    if not text or not text.strip():
        return []
    if wpm <= 0:
        raise ValueError("wpm must be positive")

    sentences = _split_sentences(text.strip())
    segments: list[Segment] = []
    index = 0

    for sentence in sentences:
        phrases = _split_into_phrases(sentence)
        for phrase in phrases:
            phrase = phrase.strip()
            if not phrase:
                continue
            words = phrase.split()
            wc = len(words)
            if wc == 0:
                continue
            duration = _compute_duration(phrase, wc, wpm)
            segments.append(Segment(
                index=index,
                text=phrase,
                word_count=wc,
                duration_ms=duration,
            ))
            index += 1

    return segments
