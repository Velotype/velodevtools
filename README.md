# Velotype DevTools

A Chrome extension for debugging [Velotype](https://github.com/Velotype/velotype) projects. Three DevTools panels:

- **Velotype** — the live component tree for the page, similar to React DevTools: class names, DOM anchor, and (for Class Components) their `attrs` and own instance fields, including live `RenderObject`/`RenderBasic` values. Click a node to inspect it and highlight it on the page. Fields are a real expand/collapse tree, not a flattened string: any object/array/Map/Set field can be expanded arbitrarily deep to its actual live values (fetched fresh from the page on each expand, and kept live for already-expanded branches) rather than dead-ending at a bare "Object".
- **Velotype Events** — a snapshot of the event bus's current registrations (`listenersF`): every listening key, how many listeners are on it, and (resolved against `domReferences`) which live components/RenderObjects those are. This is a snapshot of what's *registered*, not a trace of what has *fired* — see [Known limitations](#known-limitations).
- **VeloJSON** — decodes [velojson](https://github.com/Velotype/velojson) (VSON/VBIN) binary payloads. Automatically inspects network request/response bodies while the panel is open, plus a manual decode (bytes → JSON) and encode (JSON → bytes) tool.

A toolbar popup shows a quick "is Velotype present on this page" status without opening DevTools.

## Requires a devtools hook in Velotype

Velotype's `domReferences` registry (the map from DOM elements to live Component/RenderObject instances) is module-private — there's no equivalent of React's `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` to read it from outside. This extension only works against a Velotype build that installs `window.__VELOTYPE_DEVTOOLS_HOOK__`, installed by `src/tsx/devtools-hook.ts` in the `Velotype` repo (from every Velotype entry point). If a site uses Velotype but the tree is empty, its Velotype bundle predates that hook.

The hook is a small singleton keyed by an auto-incrementing instance id:

```ts
window.__VELOTYPE_DEVTOOLS_HOOK__ = {
    instances: Map<number, { version: string, domKeyProperty: symbol, domReferences: Map<number, ...>, listenersF, listenersR, styleSectionMounted }>,
    register(metadata) { ... },
    unregister(instanceId) { ... }
}
```

Each element bound to a Component or RenderObject stores its key under that instance's `domKeyProperty`, a `Symbol` unique to the instance, rather than in a DOM attribute. Multiple independently-bundled Velotype instances on one page (micro-frontends, or version skew across bundles) each register separately, and because every instance has its own Symbol, their keys never collide even though each instance restarts its key counter at 1. Each instance also registers its Velotype `version`, which the panels show.

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
src/background/service-worker.ts   -- pure relay, keyed by tabId and frameId
        │  chrome.runtime.Port
        ▼
src/panel-tree/panel.ts     -- the DevTools panel UI
```

`page-hook.ts` never imports the `velotype` package — it only reads the untyped
`window.__VELOTYPE_DEVTOOLS_HOOK__` global. It supports the latest Velotype release. Turning a `domReferences` entry into a tree node uses duck
typing against Velotype's internal (single-letter, undocumented) property names (`.c`, `.a`, `.e`,
`.w`, `.k` — see `classify()`/`labelFor()` in `page-hook.ts`), the same way React DevTools is
coupled to React's fiber internals. If Velotype ever renames those, this needs updating alongside.

The **Velotype Events** panel reads `listenersF`/`listenersR`, which are also part of
`__vtAppMetadata`, for what is registered. For the live trace, it asks each page to call
`metadata.setEventTracer(fn)`: Velotype calls the tracer for every event just before its listeners
receive it, and the page batches the entries (key, event, emitter, data preview, listeners) to the
panel. Velotype emits through a field that only `setEventTracer` writes, so an app without devtools
tracing runs the same code as before. An instance that has no `setEventTracer` is skipped.

**Frames.** Every frame of a page runs its own content scripts, so each has its own Velotype instances
and its own port to the relay, and the relay tags what a frame sends with its `frameId` and URL. The
tree and Events panels show each frame that has Velotype as its own root, and requests about a node
(details, fields, highlight) go to the frame the node belongs to.

The **VeloJSON** panel decodes with the real `@velotype/velojson` package (via JSR) inside the DevTools
page, and reads bodies from `chrome.devtools.network`. For request bodies it also asks the page for
the exact bytes (see below).

**Request bodies.** The network API gives a request's body only as text, decoded as UTF-8, so a binary
body has lost every byte that is not valid UTF-8 by the time the extension sees it. While the VeloJSON
panel is open, `src/content/body-capture.ts` (in each page's main world) wraps `fetch`,
`XMLHttpRequest`, and `navigator.sendBeacon`, and reports the bytes of bodies whose Content-Type says
VSON or VBIN. The panel matches each network entry with its capture by method, URL, and start time, and does not decode a request body that has none.
Nothing is wrapped until the panel asks, and bodies of other types are never copied.

## Known limitations

- **The event trace needs a Velotype version with event tracing.** Without it the Events panel still
  shows what is registered, but "Start trace" shows nothing. The trace starts empty when you press
  Start, and keeps the last 1,000 events.
- **Request bodies are exact only when the page's own code sends them.** A VSON or VBIN body sent with
  `fetch`, `XMLHttpRequest`, or `sendBeacon` while the VeloJSON panel is open is captured byte for
  byte. A request that does not come from the page's JavaScript (a worker, or the browser itself) has
  no capture, and its body is not decoded: `chrome.devtools.network`'s `postData` text is UTF-8
  decoded, so it can hold corrupted bytes, and the panel says the bytes were not captured instead of
  showing them. A form post cannot send VSON or VBIN as binary anyway. Response bodies are reliable
  (`request.getContent()` says whether the content is base64). Use the manual decode tool as a fallback
  for request payloads that don't decode automatically.
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
