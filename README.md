# Velotype DevTools

A Chrome extension for debugging [Velotype](https://github.com/Velotype/velotype) projects. Three DevTools panels:

- **Velotype** — the live component tree for the page, similar to React DevTools: class names, DOM anchor, and (for Class Components) their `attrs` and own instance fields, including live `RenderObject`/`RenderBasic` values. Click a node to inspect it and highlight it on the page.
- **Velotype Events** — a snapshot of the event bus's current registrations (`listenersF`): every listening key, how many listeners are on it, and (resolved against `domReferences`) which live components/RenderObjects those are. This is a snapshot of what's *registered*, not a trace of what has *fired* — see [Known limitations](#known-limitations).
- **VeloJSON** — decodes [velojson](https://github.com/Velotype/velojson) (VSON/VBIN) binary payloads. Automatically inspects network request/response bodies while the panel is open, plus a manual decode (bytes → JSON) and encode (JSON → bytes) tool.

A toolbar popup shows a quick "is Velotype present on this page" status without opening DevTools.

## Requires a devtools hook in Velotype

Velotype's `domReferences` registry (the map from DOM elements to live Component/RenderObject instances) is module-private — there's no equivalent of React's `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` to read it from outside. This extension only works against a Velotype build that installs `window.__VELOTYPE_DEVTOOLS_HOOK__`, added to `tsx-core.ts` alongside this extension (see the `Velotype` repo). If a site's `vk`-tagged elements show up but the tree is empty, its Velotype bundle predates that hook.

The hook is a small singleton keyed by an auto-incrementing instance id:

```ts
window.__VELOTYPE_DEVTOOLS_HOOK__ = {
    instances: Map<number, { domKeyName: string, domReferences: Map<string, ...> }>,
    register(metadata) { ... },
    unregister(instanceId) { ... }
}
```

Multiple independently-bundled Velotype instances on one page (micro-frontends, or version skew across bundles) each register separately. Since every instance defaults to the same `domKeyName` ("vk") and restarts its key counter at 1, two instances would otherwise tag elements with colliding attributes — Velotype's installer avoids this by checking already-registered `domKeyName`s and calling `setDomKey()` to pick a free one (`vk`, `vk-2`, `vk-3`, ...) before any of that instance's components mount.

## Architecture

Getting from "a page's JS heap" to "a DevTools panel" crosses three separate JS contexts:

```
window.__VELOTYPE_DEVTOOLS_HOOK__  (the page's own JS world)
        │  window.postMessage
        ▼
src/content/page-hook.ts    -- MAIN world content script; the only context that can see the hook
        │  window.postMessage
        ▼
src/content/bridge.ts       -- ISOLATED world content script; has chrome.* APIs, owns the
        │  chrome.runtime.Port      on-page highlight overlay (the DOM is shared across worlds,
        ▼                           only the JS heap is isolated)
src/background/service-worker.ts   -- pure relay, keyed by tabId
        │  chrome.runtime.Port
        ▼
src/panel-tree/panel.ts     -- the DevTools panel UI
```

`page-hook.ts` never imports the `velotype` package — it only reads the untyped
`window.__VELOTYPE_DEVTOOLS_HOOK__` global, so one build of this extension works against whatever
Velotype version a page happens to ship. Turning a `domReferences` entry into a tree node uses duck
typing against Velotype's internal (single-letter, undocumented) property names (`.c`, `.a`, `.e`,
`.w`, `.k` — see `classify()`/`labelFor()` in `page-hook.ts`), the same way React DevTools is
coupled to React's fiber internals. If Velotype ever renames those, this needs updating alongside.

The **Velotype Events** panel reads `listenersF`/`listenersR`, which are also part of
`__vtAppMetadata` — no extra hook needed beyond the one above.

The **VeloJSON** panel needs none of this — it runs entirely inside the DevTools page context using
`chrome.devtools.network` and the real `@velotype/velojson` package (via JSR).

## Known limitations

- **Component tree only covers the top frame.** The background relay only tracks one content
  script connection per tab; components rendered inside `<iframe>`s aren't merged into the tree.
- **Events panel is a registration snapshot, not a live trace.** It shows what's currently
  registered on the event bus, not a log of events as they fire — a "did my `onChange` actually
  fire, with what data" trace would need a small hook in `emitEvent()` itself. Measured at ~100
  bytes minified (~60 bytes gzipped) added to Velotype's own shipped bundle, but decided against for
  now — the registration snapshot covers most debugging needs (leaked listeners, "is anything even
  listening on this key") without that always-on cost or the memory pinned by a trace buffer.
- **Request body decoding is best-effort.** `chrome.devtools.network`'s extension API only exposes
  `postData` as text, which can be lossy for binary bodies depending on Chrome version. Response
  body decoding (`request.getContent()`) is reliable since it gives an explicit `base64` encoding
  flag for binary content. Use the manual decode tool as a fallback for request payloads that don't
  decode automatically.
- **VSON/VBIN detection on the network tab is Content-Type only, by design.** velojson payloads
  have real, specific Content-Types — `application/vson` and `application/vbin` (see veloschema's
  `ContentTypes` and its generated clients/gateways, which set/read exactly these, typically as
  `application/vson; charset=utf-8`). The panel reads this from `postData.mimeType` /
  `response.content.mimeType` (falling back to the raw `Content-Type` header), matching by substring
  so the `; charset=...` suffix doesn't matter, and treats it as authoritative: a non-VSON
  Content-Type means the body is never even attempted, and a VSON/VBIN Content-Type means decoding
  is always attempted, surfacing the real error if it fails. There's no byte-content fallback for a
  body with no Content-Type at all (e.g. `application/octet-stream`) — a real Content-Type is
  required. The manual decode/encode tool is the escape hatch for anything without one, since it has
  no HTTP context to read a Content-Type from in the first place.
- **VBIN (KeyID format) payloads decode in "debug format" only.** This panel imports the `velojson`
  *server* build (`@velotype/velojson`, not `@velotype/velojson/browser` — the browser build only
  implements the KeyTable format and throws on anything else; bundle size doesn't matter here since
  this only runs inside the DevTools page). Its `VSON.decode()` handles Base, KeyTable, and VBIN
  payloads uniformly, but for VBIN it can only produce a "debug format": object keys come back as
  their raw numeric KeyIDs (e.g. `{"1": "hello"}`) rather than real field names, since real names
  require a schema-generated `VBINObjectMapper` (see `veloschema`) that this generic extension has no
  way to obtain for an arbitrary site. The panel labels VBIN output accordingly.

## Development

Requires [Deno](https://deno.com) (no npm, no `node_modules` — dependencies are `jsr:`/`npm:`
specifiers in `deno.json`, fetched into Deno's own cache on first use):

```sh
deno task build       # copies static files (incl. icons) + bundles everything into dist/
deno task watch       # same, but rebuilds on change
deno task typecheck
```

The toolbar/panel icons (`public/icons/*.png`) are the real Velotype logo (`assets/velotype-logo.svg`,
copied from the `velotype` repo's own `assets/logo.svg`), rasterized once via
`deno task rasterize-icons` (needs a real Chrome, since the logo has an arc in it — not part of the
regular build). Re-run it if the logo ever changes; the checked-in PNGs are what actually ships.

Then load `dist/` as an unpacked extension: `chrome://extensions` → enable Developer mode → **Load
unpacked** → select the `dist/` folder. After `deno task watch` picks up a change, reload the
extension from `chrome://extensions` (and refresh the inspected page, since content scripts only
(re-)inject on navigation).

## License

MIT
