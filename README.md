# Velotype DevTools

A Chrome extension for debugging [Velotype](https://github.com/Velotype/velotype) projects. Two DevTools panels:

- **Velotype** — the live component tree for the page, similar to React DevTools: class names, DOM anchor, and (for Class Components) their `attrs` and own instance fields, including live `RenderObject`/`RenderBasic` values. Click a node to inspect it and highlight it on the page.
- **VeloJSON** — decodes [velojson](https://github.com/Velotype/velojson) (VSON) binary payloads. Automatically inspects network request/response bodies while the panel is open, plus a manual decode (bytes → JSON) and encode (JSON → bytes) tool.

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

The **VeloJSON** panel needs none of this — it runs entirely inside the DevTools page context using
`chrome.devtools.network` and the real `@jsr/velotype__velojson` package.

## Known limitations

- **Component tree only covers the top frame.** The background relay only tracks one content
  script connection per tab; components rendered inside `<iframe>`s aren't merged into the tree.
- **Request body decoding is best-effort.** `chrome.devtools.network`'s extension API only exposes
  `postData` as text, which can be lossy for binary bodies depending on Chrome version. Response
  body decoding (`request.getContent()`) is reliable since it gives an explicit `base64` encoding
  flag for binary content. Use the manual decode tool as a fallback for request payloads that don't
  decode automatically.
- **VSON detection is heuristic.** A buffer is treated as "possibly VSON" if its first byte falls in
  `[8, 15]` (the only currently-valid `(encodingFormat * 8) + wireType` values), then an actual
  decode is attempted. This can't be 100% certain for arbitrary binary payloads that happen to start
  with such a byte, but false positives should be very rare in practice.

## Development

```sh
npm install     # also pulls @jsr/velotype__velojson via the JSR npm registry (see .npmrc)
npm run build   # generates icons + bundles everything into dist/
npm run watch   # same, but rebuilds on change
npm run typecheck
```

Then load `dist/` as an unpacked extension: `chrome://extensions` → enable Developer mode → **Load
unpacked** → select the `dist/` folder. After `npm run watch` picks up a change, reload the
extension from `chrome://extensions` (and refresh the inspected page, since content scripts only
(re-)inject on navigation).

## License

MIT
