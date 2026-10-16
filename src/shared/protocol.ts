/**
 * Message shapes shared across the three contexts that make up the component-tree feature:
 *
 *   page-hook.ts (MAIN world, shares JS heap with the page's Velotype instances)
 *       <--postMessage-->
 *   bridge.ts (ISOLATED content script, shares the DOM but not the JS heap with the page)
 *       <--chrome.runtime.Port-->
 *   background/service-worker.ts (relays by tabId and frameId)
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
    /** Short, one-line, non-recursive summary -- see shared/serialize.ts's preview() */
    preview: string
    /** Whether this field has further children to expand -- see shared/serialize.ts's childrenOf() */
    expandable: boolean
    /** Full path from the resolved component/renderObject/withComponent's `ref` to this field's
     *  value (e.g. `["c", "someField"]`), passed back on a "requestFieldChildren" to expand it */
    path: string[]
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
    /** The version of Velotype this instance runs */
    version: string
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

/** One event emitted on an instance's event bus, from tracing */
export interface TracedEvent {
    /** `Date.now()` when it was emitted */
    time: number
    instanceId: number
    /** The listening key it was emitted on */
    key: string
    /** The event's `event` string, such as "onChange" */
    name: string
    /** What emitted it, when it is a live component, RenderObject, or withComponent */
    emitter: EventPartyRef | { id: string; label: null; kind: null }
    /** A short summary of the event's `data`, or null when it has none */
    data: string | null
    /** Whoever was listening on the key when it was emitted */
    listeners: Array<EventPartyRef | { id: string; label: null; kind: null }>
}

export interface EventsSnapshot {
    instances: Array<{ instanceId: number; keys: EventKeySummary[] }>
}

/**
 * A VSON or VBIN request body, with its exact bytes, as the page's code passed it to fetch,
 * XMLHttpRequest, or sendBeacon -- see content/body-capture.ts for why the network API's text is
 * not enough.
 */
export interface CapturedRequestBody {
    method: string
    /** Absolute, without the fragment: what the network entry's `request.url` will be */
    url: string
    /** `Date.now()` when the page made the request, to match it with its network entry */
    startedAt: number
    contentType: string | null
    /** The body's bytes, base64 */
    bytes: string
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
    | { source: typeof PAGE_HOOK_SOURCE; type: "fieldChildren"; requestId: string; id: string; path: string[]; children: FieldPreview[] | null }
    | { source: typeof PAGE_HOOK_SOURCE; type: "capturedBody"; body: CapturedRequestBody }
    | { source: typeof PAGE_HOOK_SOURCE; type: "tracedEvents"; events: TracedEvent[] }

export type BridgeToPageMessage =
    | { source: typeof BRIDGE_SOURCE; type: "requestTree"; requestId: string }
    | { source: typeof BRIDGE_SOURCE; type: "requestDetails"; requestId: string; id: string }
    | { source: typeof BRIDGE_SOURCE; type: "requestHighlight"; requestId: string; id: string | null }
    | { source: typeof BRIDGE_SOURCE; type: "requestHookStatus" }
    | { source: typeof BRIDGE_SOURCE; type: "requestEvents"; requestId: string }
    | { source: typeof BRIDGE_SOURCE; type: "requestFieldChildren"; requestId: string; id: string; path: string[] }
    | { source: typeof BRIDGE_SOURCE; type: "startBodyCapture" }
    | { source: typeof BRIDGE_SOURCE; type: "stopBodyCapture" }
    | { source: typeof BRIDGE_SOURCE; type: "startEventTrace" }
    | { source: typeof BRIDGE_SOURCE; type: "stopEventTrace" }

// ---------------------------------------------------------------------------
// panel (DevTools page) <-> background <-> bridge (ISOLATED content script), via chrome.runtime.Port
// ---------------------------------------------------------------------------

/**
 * A frame of the inspected tab. Every frame runs its own content scripts and its own Velotype
 * instances, so the background tags what each frame sends with where it came from.
 */
export interface FrameInfo {
    /** `chrome.runtime.MessageSender.frameId`: 0 for the top frame */
    frameId: number
    url: string
}

/**
 * A request is for one frame when it has a `frameId` (an id from a node, which belongs to the frame
 * it came from), and for every frame of the tab when it has none. A `requestHighlight` for a frame
 * also clears the highlight in the others.
 */
export type PanelRequest =
    | { type: "requestTree"; frameId?: number }
    | { type: "requestDetails"; id: string; frameId?: number }
    | { type: "requestHighlight"; id: string | null; frameId?: number }
    | { type: "requestHookStatus"; frameId?: number }
    | { type: "requestEvents"; frameId?: number }
    | { type: "requestFieldChildren"; id: string; path: string[]; frameId?: number }
    /** Start (or stop) keeping the bytes of VSON and VBIN request bodies, in every frame */
    | { type: "startBodyCapture" }
    | { type: "stopBodyCapture" }
    /** Start (or stop) tracing the events emitted on the event bus, in every frame */
    | { type: "startEventTrace" }
    | { type: "stopEventTrace" }

/** What a content script sends to a panel, before the background says which frame it came from */
export type ContentResponse =
    | { type: "hookStatus"; status: HookStatus }
    | { type: "tree"; tree: ComponentTreeNode[] }
    | { type: "details"; details: ComponentDetails | null }
    | { type: "events"; events: EventsSnapshot }
    | { type: "fieldChildren"; id: string; path: string[]; children: FieldPreview[] | null }
    | { type: "capturedBody"; body: CapturedRequestBody }
    | { type: "tracedEvents"; events: TracedEvent[] }

export type PanelResponse =
    | (ContentResponse & { frame: FrameInfo })
    /** A frame navigated away or was removed, so what it sent earlier is gone */
    | { type: "frameGone"; frame: FrameInfo }
    | { type: "contentScriptGone" }

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
