# Windowed reads: large pages over MCP

A page can be far larger than one tool result can carry. A conversation
export or a long log of 2 MB is about 500k tokens, and Claude Code cuts a tool
result at about 25k tokens. From this release, `get_page`, `fetch` and evidence
delivery read a large page in windows: bounded slices addressed in UTF-8 bytes
and lines, each one a slice of the same read projection a whole-page read
returns. Nothing is cut silently: every partial response says it is partial,
and the whole page stays reachable.

This guide covers who gets what, the parameters, and the four refusals.

## Who gets a window

| Caller | `get_page` with no body mode | Large page (over 256 KB) |
| --- | --- | --- |
| Trusted local CLI (`gbrain get`) | Whole page | Whole page, any size |
| gbrain's thin client (`X-Gbrain-Client` header) | Whole page | Whole page while it fits the connection; otherwise the CLI pages the round-trip markdown to its end and checks its sha256, or fails without printing |
| Any other MCP client | `auto` | Outline plus a first window; never `compiled_truth`, `timeline` or `content` |

The inline size is `mcp.inline_body_bytes` (default 256 KB). Hosts advertise the
contract in `get_brain_identity` as `capabilities: ["large_pages_v1"]`.

## get_page body modes

| Parameter | Meaning |
| --- | --- |
| `body: "auto"` | Whole page up to the inline size, else outline plus a first window (`auto_reason: "over_inline_bytes"`). |
| `body: "full"` | Whole page, up to the connection's egress cap; `include_content: true` means the same. |
| `body: "none"` | Revision, size, total lines and chunk counts. Use it for `edit_page`'s `expected_revision`. |
| `body: "outline"` | Headings (or blocks for pages with fewer than two headings) with line and byte ranges and date ranges; page it with `outline_from`. |
| `body: "window"` | One window. Choose it with exactly one selector below; with none, the window starts at the top. |
| `lines: {from, count}` | 1-based lines. |
| `bytes: {offset, length}` | UTF-8 bytes, snapped back to a line start. |
| `around_chunk_id: N` | The text around a search hit's chunk, `context_lines` either side (default 20). |
| `cursor: "gpw1.…"` | `next_cursor` from the previous window. |
| `max_bytes` | Window size (default 40,000, at most 1 MiB, and always inside the connection's cap). |
| `view: "markdown"` | Page the round-trip markdown (`include_content`'s `content`) instead of the read text; `size.sha256` verifies the joined pages. |

Passing two selectors, a selector with `body: "outline"`, or `include_content`
with a partial mode is `invalid_params` with an example. A window response
carries `window {text, byte_start, byte_end, line_start, line_end}`,
`size {total_bytes, total_lines}`, `truncated`, and when more follows
`next_cursor` plus `next`, the exact `get_page` call that reads on. The starter
MCP surface advertises none of the window parameters (its tool list has a fixed
size budget); it accepts all of them, so following `next` or a refusal's fix works
there too. A line longer than the window is cut on a character boundary and
marked `forced_cut`.

`around_chunk_id` uses the chunk's recorded position (`anchor: "stored_span"`).
A chunk written before positions were recorded is located only when its text is
unique on the page (`anchor: "located"`); otherwise the response is the chunk
itself with no surrounding text (`anchor: "chunk_only"`), never a guessed
neighborhood.

## fetch and evidence delivery

`fetch` returns a page over the inline size as the window around the searched
chunk: a search result id past the page's first chunk names that chunk.
`metadata.total_bytes`, `metadata.window` and `metadata.next_id` describe the
window; fetch `next_id` to read on. A chunk id from before a re-chunk falls back
to the first window (`metadata.anchor: "chunk_not_current"`), and an old
continuation reads on from the same byte offset (`"cursor_rebased"`).

Evidence delivery (`return_unit` on search, query and `assemble_evidence`)
never assembles a page over the inline size whole: a `page` unit becomes the
window around the hits, with `delivered.fallback_reason: "page_over_inline_bytes"`.
A truncated search snippet past the first chunk points at
`get_page <slug> around_chunk_id=<id>`.

## Privacy

Windows, outlines and snippets for remote callers are slices of the read
projection: withdrawn facts overlaid, Takes and non-world Facts fences removed,
credentials projected. A window that starts inside a protected fence, balanced
or not, holds none of it, and an outline never names a heading inside one.

## Egress caps

Every MCP result is measured as the complete encoded JSON-RPC frame, notices and
escaping included. Defaults: 4 MiB on stdio (`mcp.max_result_bytes_stdio`),
1 MiB on HTTP (`mcp.max_result_bytes_http`); a configured value is clamped to
256 KiB–9 MiB. Windows shrink until their frame fits.

## page_too_large_for_inline

`get_page` with `body: "full"` (or `include_content`, or gbrain's thin client
naming no mode) asked for a page whose encoded result is over the connection's
cap. Nothing was returned or cut. Read `body: "outline"`, then windows; edit with
`edit_page` using the revision from `body: "none"`. An older gbrain CLI gets this
refusal instead of a partial page: upgrade it (`gbrain upgrade`).

## page_shrink_refused

A remote `put_page` would replace a page over the inline size with content under
half its size. That is most often a window sent back as the page, which would
delete the unread rest, so nothing was written. Change part of the page with
`edit_page`. When the smaller content really is the intended complete page,
resend it with `allow_shrink: true` and the page's `expected_revision`. Replacing
a page over the inline size always needs `expected_revision`; `force` does not
stand in for it.

## result_too_large

The tool's result, measured as the final encoded frame, is over this
connection's cap, so it was replaced by this error; nothing was cut. Ask for less
in one call: a window, a page of rows, or metadata only. The error's `detail`
names the measured size, the cap and the config key that sets it.

## revision_changed

The page changed after the cursor or chunk id was issued, so that position no
longer names the same text. The fix reads on from the same byte offset at the
current revision; or start again from `body: "outline"`, or search again for a
current chunk id.
