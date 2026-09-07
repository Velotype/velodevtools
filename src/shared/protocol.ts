/**
 * Message shapes shared across the three contexts that make up the component-tree feature:
 *
 *   page-hook.ts (MAIN world, shares JS heap with the page's Velotype instances)
 *       <--postMessage-->
 *   bridge.ts (ISOLATED content script, shares the DOM but not the JS heap with the page)
 *       <--chrome.runtime.Port-->
 *   background/service-worker.ts (relays by tabId)
 *       <--chrome.runtime.Port-->
 *   panel-tree/panel.ts (the DevTools panel UI)
 *
 * page-hook.ts is the only context with direct access to `window.__VELOTYPE_DEVTOOLS_HOOK__`, so
 * every other context is just plumbing to get requests to it and snapshots back.
 */

export type ComponentNodeKind = "component" | "renderObject" | "withComponent"

export interface ComponentTreeNode {
    /** Stable id: `${instanceId}:${vtKey}`, used to re-resolve this node back to a live object */
    id: string
    instanceId: number
    vtKey: string
    kind: ComponentNodeKind
    /** Component class name, or "RenderObject" / "RenderBasic" / "RenderObjectArray" / "vtwith" */
    label: string
    /** Lowercase tag name of the DOM element this node is anchored to */
    tag: string
    children: ComponentTreeNode[]
}

export interface FieldPreview {
    name: string
    typeLabel: string
    preview: string
}

export interface ComponentDetails {
    id: string
    label: string
    kind: ComponentNodeKind
    tag: string
    attrs: FieldPreview[]
    fields: FieldPreview[]
}

export interface HookInstanceSummary {
    instanceId: number
    domKeyName: string
    componentCount: number
}

export interface HookStatus {
    present: boolean
    instances: HookInstanceSummary[]
}

export interface DOMRectSummary {
    top: number
    left: number
    width: number
    height: number
}

/** A resolved reference to a live component/renderObject/withComponent, for display */
export interface EventPartyRef {
    id: string
    label: string
    kind: ComponentNodeKind
}

export interface EventKeySummary {
    /** The listening key passed to registerEventListener()/emitEvent() */
    key: string
    /** Best-effort: resolved if `key` matches RenderObject's own "vt-ro-<vtKey>" pattern --
     *  custom keys from user code have no way to resolve an "owner" from the key alone */
    owner: EventPartyRef | null
    /** Everything currently registered to listen on this key, resolved where possible */
    listeners: Array<EventPartyRef | { id: string; label: null; kind: null }>
}

export interface EventsSnapshot {
    instances: Array<{ instanceId: number; keys: EventKeySummary[] }>
}

// ---------------------------------------------------------------------------
// page-hook (MAIN world) <-> bridge (ISOLATED content script), via window.postMessage
// ---------------------------------------------------------------------------

export const PAGE_HOOK_SOURCE = "velodevtools-page-hook" as const
export const BRIDGE_SOURCE = "velodevtools-bridge" as const

export type PageToBridgeMessage =
    | { source: typeof PAGE_HOOK_SOURCE; type: "hookStatus"; status: HookStatus }
    | { source: typeof PAGE_HOOK_SOURCE; type: "tree"; requestId: string; tree: ComponentTreeNode[] }
    | { source: typeof PAGE_HOOK_SOURCE; type: "details"; requestId: string; details: ComponentDetails | null }
    | { source: typeof PAGE_HOOK_SOURCE; type: "highlightRects"; requestId: string; rects: DOMRectSummary[] }
    | { source: typeof PAGE_HOOK_SOURCE; type: "events"; requestId: string; events: EventsSnapshot }

export type BridgeToPageMessage =
    | { source: typeof BRIDGE_SOURCE; type: "requestTree"; requestId: string }
    | { source: typeof BRIDGE_SOURCE; type: "requestDetails"; requestId: string; id: string }
    | { source: typeof BRIDGE_SOURCE; type: "requestHighlight"; requestId: string; id: string | null }
    | { source: typeof BRIDGE_SOURCE; type: "requestHookStatus" }
    | { source: typeof BRIDGE_SOURCE; type: "requestEvents"; requestId: string }

// ---------------------------------------------------------------------------
// panel (DevTools page) <-> background <-> bridge (ISOLATED content script), via chrome.runtime.Port
// ---------------------------------------------------------------------------

export type PanelRequest =
    | { type: "requestTree" }
    | { type: "requestDetails"; id: string }
    | { type: "requestHighlight"; id: string | null }
    | { type: "requestHookStatus" }
    | { type: "requestEvents" }

export type PanelResponse =
    | { type: "hookStatus"; status: HookStatus }
    | { type: "tree"; tree: ComponentTreeNode[] }
    | { type: "details"; details: ComponentDetails | null }
    | { type: "contentScriptGone" }
    | { type: "events"; events: EventsSnapshot }

/** Port name used by both panel-tree and popup when connecting to the background worker */
export const TREE_PORT_NAME = "velodevtools-tree"

/**
 * The panel/popup side of a Port is a DevTools or extension page, not a content script, so
 * `chrome.runtime.onConnect`'s `sender.tab` is unset for it -- unlike a content script's Port,
 * which always carries `sender.tab.id`. So the panel/popup must announce which tab it's for as
 * its first message; the background worker uses this to route later requests to the right tab's
 * content script.
 */
export type PanelInitMessage = { type: "init"; tabId: number }
export type PanelPortMessage = PanelInitMessage | PanelRequest
