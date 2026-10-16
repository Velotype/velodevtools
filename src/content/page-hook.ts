/**
 * Runs in the page's own JS world (manifest `"world": "MAIN"`), so it can see
 * `window.__VELOTYPE_DEVTOOLS_HOOK__` the way any of the page's own scripts would.
 *
 * It never talks to the extension directly (a MAIN-world script has no `chrome.*` APIs) --
 * instead it exchanges plain, structured-clone-safe messages with bridge.ts (the ISOLATED-world
 * content script) over `window.postMessage`, which is the standard way to cross the MAIN/ISOLATED
 * world boundary while still sharing the same document.
 *
 * This file intentionally does NOT import anything from the `velotype` package: the devtools hook
 * it reads (`window.__VELOTYPE_DEVTOOLS_HOOK__`) is a plain untyped global by design. It supports
 * the latest Velotype; each instance reports its `version` for when versions need telling apart.
 */
import {
    BRIDGE_SOURCE,
    PAGE_HOOK_SOURCE,
    type BridgeToPageMessage,
    type ComponentDetails,
    type ComponentNodeKind,
    type ComponentTreeNode,
    type TracedEvent,
    type DOMRectSummary,
    type EventKeySummary,
    type EventPartyRef,
    type EventsSnapshot,
    type FieldPreview,
    type HookStatus
} from "../shared/protocol.ts"
import { childrenOf, isRenderObjectLike, preview, typeLabelOf } from "../shared/serialize.ts"
import { startBodyCapture, stopBodyCapture } from "./body-capture.ts"

// ---- Minimal local view of the hook's shape -------------------------------------------------
// Deliberately not imported from `velotype` -- see file header. Matches the runtime contract of
// `window.__VELOTYPE_DEVTOOLS_HOOK__` installed by velotype's tsx-core.ts.

interface VelotypeHookInstanceMetadata {
    /** The version of this Velotype instance */
    version: string
    /** Property holding each bound element's DOM key */
    domKeyProperty: symbol
    domReferences: Map<number, unknown>
    /** Forward event-bus map: listeningKey -> vtKey (of the listening object) -> listener fn */
    listenersF: Map<string, Map<number, unknown>>
    /** Traces the events this instance emits (Velotype versions with event tracing only) */
    setEventTracer?: (tracer: ((listeningKey: string, event: { emittingObject?: unknown; event?: unknown; data?: unknown }) => void) | undefined) => void
}
interface VelotypeDevtoolsHookGlobal {
    instances: Map<number, VelotypeHookInstanceMetadata>
}
declare global {
    interface Window {
        __VELOTYPE_DEVTOOLS_HOOK__?: VelotypeDevtoolsHookGlobal
    }
}

// ---- Reading the live component graph -----------------------------------------------------

function getInstances(): Array<[number, VelotypeHookInstanceMetadata]> {
    const hook = window.__VELOTYPE_DEVTOOLS_HOOK__
    return hook ? Array.from(hook.instances.entries()) : []
}

function getHookStatus(): HookStatus {
    const instances = getInstances()
    return {
        present: instances.length > 0,
        instances: instances.map(([instanceId, metadata]) => ({
            instanceId,
            version: metadata.version,
            componentCount: metadata.domReferences.size
        }))
    }
}

/** Duck-types which kind of object a domReferences entry is -- see velotype's tsx-core.ts:
 *  InternalComponent has `.c` (the user Component, with a `.render` method); a RenderObject-like
 *  has `.rD`/`.uK`; a WithComponent has `.w` (an array of RenderObjects). */
function classify(ref: unknown): ComponentNodeKind | null {
    if (typeof ref !== "object" || ref === null) return null
    const r = ref as Record<string, unknown>
    const c = r.c as Record<string, unknown> | undefined
    if (typeof c === "object" && c !== null && typeof c.render === "function") return "component"
    if (isRenderObjectLike(ref)) return "renderObject"
    if (Array.isArray(r.w) && typeof r.k === "number" && typeof r.unmount === "function") return "withComponent"
    return null
}

function labelFor(ref: Record<string, unknown>, kind: ComponentNodeKind): string {
    if (kind === "component") {
        const c = ref.c as object
        return c.constructor?.name || "Component"
    }
    if (kind === "renderObject") return typeLabelOf(ref)
    return "vtwith"
}

/** An element's DOM key for this Velotype instance as a string, or null if it isn't bound */
function keyOf(element: Element, metadata: VelotypeHookInstanceMetadata): string | null {
    const key = (element as unknown as Record<symbol, unknown>)[metadata.domKeyProperty]
    return typeof key === "number" ? String(key) : null
}

/** The domReferences entry for a vtKey in string form */
function referenceFor(metadata: VelotypeHookInstanceMetadata, vtKey: string): unknown {
    return metadata.domReferences.get(Number(vtKey))
}

function tryResolveNode(element: Element, instances: Array<[number, VelotypeHookInstanceMetadata]>): ComponentTreeNode | null {
    for (const [instanceId, metadata] of instances) {
        const key = keyOf(element, metadata)
        if (key === null) continue
        const ref = referenceFor(metadata, key)
        if (ref === undefined) continue
        const kind = classify(ref)
        if (!kind) continue
        return {
            id: `${instanceId}:${key}`,
            instanceId,
            vtKey: key,
            kind,
            label: labelFor(ref as Record<string, unknown>, kind),
            tag: element.tagName.toLowerCase(),
            children: []
        }
    }
    return null
}

/** Mirrors velotype's own traverseElementChildren(): walks real DOM, flattening plain HTML
 *  elements that aren't a component boundary into their parent's child list. */
function walkChildren(element: Element, instances: Array<[number, VelotypeHookInstanceMetadata]>): ComponentTreeNode[] {
    const result: ComponentTreeNode[] = []
    for (const child of Array.from(element.children)) {
        const node = tryResolveNode(child, instances)
        if (node) {
            node.children = walkChildren(child, instances)
            result.push(node)
        } else {
            result.push(...walkChildren(child, instances))
        }
    }
    return result
}

function buildTree(): ComponentTreeNode[] {
    const instances = getInstances()
    if (instances.length === 0) return []
    return walkChildren(document.documentElement, instances)
}

function resolveById(id: string): { ref: Record<string, unknown>; metadata: VelotypeHookInstanceMetadata; kind: ComponentNodeKind; vtKey: string } | null {
    const separatorIndex = id.indexOf(":")
    if (separatorIndex < 0) return null
    const instanceId = Number(id.slice(0, separatorIndex))
    const vtKey = id.slice(separatorIndex + 1)
    const hook = window.__VELOTYPE_DEVTOOLS_HOOK__
    const metadata = hook?.instances.get(instanceId)
    if (!metadata) return null
    const ref = referenceFor(metadata, vtKey)
    if (ref === undefined) return null
    const kind = classify(ref)
    if (!kind) return null
    return { ref: ref as Record<string, unknown>, metadata, kind, vtKey }
}

/**
 * Builds the FieldPreview[] for a value's own children, each carrying the full path (from the
 * resolved component/renderObject/withComponent's `ref`) needed to expand it further later --
 * see resolveFieldChildren() below, which walks that same path back to a live value on demand.
 */
function fieldPreviewsFor(value: unknown, pathPrefix: string[], excludeKeys?: Set<string>): FieldPreview[] {
    const children = childrenOf(value)
    if (!children) return []
    return children
        .filter(({ key }) => !excludeKeys?.has(key))
        .map(({ key, value: childValue }) => ({
            name: key,
            typeLabel: typeLabelOf(childValue),
            preview: preview(childValue),
            expandable: childrenOf(childValue) !== null,
            path: [...pathPrefix, key]
        }))
}

function singleFieldPreview(name: string, value: unknown, path: string[]): FieldPreview {
    return { name, typeLabel: typeLabelOf(value), preview: preview(value), expandable: childrenOf(value) !== null, path }
}

function buildDetails(id: string): ComponentDetails | null {
    const resolved = resolveById(id)
    if (!resolved) return null
    const { ref, kind } = resolved

    if (kind === "component") {
        return {
            id,
            label: labelFor(ref, kind),
            kind,
            tag: "",
            attrs: fieldPreviewsFor(ref.a, ["a"]),
            fields: fieldPreviewsFor(ref.c, ["c"], new Set(["attrs"]))
        }
    }
    if (kind === "renderObject") {
        return {
            id,
            label: labelFor(ref, kind),
            kind,
            tag: "",
            attrs: [],
            fields: [singleFieldPreview("value", (ref as { value: unknown }).value, ["value"])]
        }
    }
    // withComponent
    const withObjects = (ref.w as unknown[]) || []
    return {
        id,
        label: "vtwith",
        kind,
        tag: "",
        attrs: [],
        fields: withObjects.map((obj, index) => singleFieldPreview(`[${index}]`, obj, ["w", String(index)]))
    }
}

/** Re-resolves `id` and walks `path` (as produced by fieldPreviewsFor/singleFieldPreview above)
 *  back to a live value, then returns previews of *its* children -- the on-demand "expand" step.
 *  Returns null only if the component/renderObject/withComponent itself is gone; a path that no
 *  longer resolves to something expandable just yields an empty array. */
function resolveFieldChildren(id: string, path: string[]): FieldPreview[] | null {
    const resolved = resolveById(id)
    if (!resolved) return null
    const value = path.reduce<unknown>((current, key) => {
        if (current === null || current === undefined) return undefined
        return (current as Record<string, unknown>)[key]
    }, resolved.ref)
    return fieldPreviewsFor(value, path)
}

function buildHighlightRects(id: string | null): DOMRectSummary[] {
    if (!id) return []
    const resolved = resolveById(id)
    if (!resolved) return []
    const { metadata, vtKey } = resolved
    const rects: DOMRectSummary[] = []
    // Keys stored as a property can't be selected with querySelectorAll, so every element is checked
    const candidates = document.querySelectorAll("*")
    for (const el of Array.from(candidates)) {
        if (keyOf(el, metadata) !== vtKey) continue
        const rect = el.getBoundingClientRect()
        rects.push({ top: rect.top, left: rect.left, width: rect.width, height: rect.height })
    }
    return rects
}

// ---- Event bus registration snapshot -------------------------------------------------------
// Read-only, from listenersF (already part of __vtAppMetadata) -- no velotype core changes
// needed. This shows what is registered; the event trace below shows what fires.

const RENDER_OBJECT_KEY_PATTERN = /^vt-ro-(\d+)$/

/** Resolves a vtKey back to a display-friendly reference, if it's still a live component/
 *  renderObject/withComponent in this instance's domReferences -- otherwise a bare id. */
function resolveEventParty(instanceId: number, metadata: VelotypeHookInstanceMetadata, vtKey: string | number): EventPartyRef | { id: string; label: null; kind: null } {
    const id = `${instanceId}:${vtKey}`
    const ref = referenceFor(metadata, String(vtKey))
    const kind = classify(ref)
    if (!kind) return { id, label: null, kind: null }
    return { id, label: labelFor(ref as Record<string, unknown>, kind), kind }
}

function buildEventsSnapshot(): EventsSnapshot {
    const instances = getInstances()
    return {
        instances: instances.map(([instanceId, metadata]) => {
            const keys: EventKeySummary[] = Array.from(metadata.listenersF.entries()).map(([key, listenerMap]) => {
                const ownerVtKey = RENDER_OBJECT_KEY_PATTERN.exec(key)?.[1]
                const owner = ownerVtKey ? resolveEventParty(instanceId, metadata, ownerVtKey) : null
                return {
                    key,
                    owner: owner && owner.kind ? owner : null,
                    listeners: Array.from(listenerMap.keys()).map(vtKey => resolveEventParty(instanceId, metadata, vtKey))
                }
            })
            return { instanceId, keys }
        })
    }
}

// ---- Event trace --------------------------------------------------------------------------------
//
// A tracer is installed on each Velotype instance, which calls it for every event just before the
// listeners receive it. Entries are sent in batches, so a burst of events is one message.

const MAX_BATCH = 200
let traceBatch: TracedEvent[] = []
let traceTimer: number | undefined

function flushTrace(): void {
    traceTimer = undefined
    if (traceBatch.length === 0) return
    post({ source: PAGE_HOOK_SOURCE, type: "tracedEvents", events: traceBatch })
    traceBatch = []
}

function tracerFor(instanceId: number, metadata: VelotypeHookInstanceMetadata) {
    return (key: string, event: { emittingObject?: unknown; event?: unknown; data?: unknown }): void => {
        const emitterKey = (event.emittingObject as { vtKey?: unknown } | undefined)?.vtKey
        const listenerMap = metadata.listenersF.get(key)
        traceBatch.push({
            time: Date.now(),
            instanceId,
            key,
            name: String(event.event),
            emitter: emitterKey === undefined ? { id: "", label: null, kind: null } : resolveEventParty(instanceId, metadata, emitterKey as number),
            data: event.data === undefined ? null : preview(event.data),
            listeners: listenerMap ? Array.from(listenerMap.keys()).map(vtKey => resolveEventParty(instanceId, metadata, vtKey)) : []
        })
        if (traceBatch.length >= MAX_BATCH) flushTrace()
        else if (traceTimer === undefined) traceTimer = setTimeout(flushTrace, 100) as unknown as number
    }
}

/** Starts tracing in every instance that can, and in ones that register later */
let tracing = false
const tracedInstances = new Set<number>()
function updateTracing(): void {
    for (const [instanceId, metadata] of getInstances()) {
        if (tracing && !tracedInstances.has(instanceId) && metadata.setEventTracer) {
            metadata.setEventTracer(tracerFor(instanceId, metadata))
            tracedInstances.add(instanceId)
        }
    }
}
function startEventTrace(): void {
    tracing = true
    updateTracing()
}
function stopEventTrace(): void {
    tracing = false
    for (const [instanceId, metadata] of getInstances()) {
        if (tracedInstances.has(instanceId)) metadata.setEventTracer?.(undefined)
    }
    tracedInstances.clear()
    flushTrace()
}

// ---- Messaging with bridge.ts ---------------------------------------------------------------

function post(message: Parameters<typeof window.postMessage>[0]): void {
    window.postMessage(message, "*")
}

function pushHookStatus(): void {
    post({ source: PAGE_HOOK_SOURCE, type: "hookStatus", status: getHookStatus() })
}

window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return
    const data = event.data as BridgeToPageMessage | undefined
    if (!data || data.source !== BRIDGE_SOURCE) return

    switch (data.type) {
        case "requestTree":
            post({ source: PAGE_HOOK_SOURCE, type: "tree", requestId: data.requestId, tree: buildTree() })
            break
        case "requestDetails":
            post({ source: PAGE_HOOK_SOURCE, type: "details", requestId: data.requestId, details: buildDetails(data.id) })
            break
        case "requestHighlight":
            post({ source: PAGE_HOOK_SOURCE, type: "highlightRects", requestId: data.requestId, rects: buildHighlightRects(data.id) })
            break
        case "requestHookStatus":
            pushHookStatus()
            break
        case "requestEvents":
            post({ source: PAGE_HOOK_SOURCE, type: "events", requestId: data.requestId, events: buildEventsSnapshot() })
            break
        case "startBodyCapture":
            startBodyCapture(body => post({ source: PAGE_HOOK_SOURCE, type: "capturedBody", body }))
            break
        case "stopBodyCapture":
            stopBodyCapture()
            break
        case "startEventTrace":
            startEventTrace()
            break
        case "stopEventTrace":
            stopEventTrace()
            break
        case "requestFieldChildren":
            post({ source: PAGE_HOOK_SOURCE, type: "fieldChildren", requestId: data.requestId, id: data.id, path: data.path, children: resolveFieldChildren(data.id, data.path) })
            break
    }
})

// The page's Velotype bundle may not have run yet when this script does (document_start), and the
// hook's instance set can change as components mount/unmount, so keep polling/observing rather
// than only checking once.
let lastPresence = false
function checkAndMaybePush(): void {
    if (tracing) updateTracing()
    const present = getInstances().length > 0
    if (present !== lastPresence) {
        lastPresence = present
        pushHookStatus()
    }
}
setInterval(checkAndMaybePush, 1000)

const readyObserver = new MutationObserver(() => checkAndMaybePush())
function startObservingOnceBodyExists(): void {
    if (document.body) {
        readyObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: false })
        checkAndMaybePush()
    } else {
        requestAnimationFrame(startObservingOnceBodyExists)
    }
}
startObservingOnceBodyExists()
