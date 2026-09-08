/**
 * Runs in the ISOLATED world (the normal content-script world): it has `chrome.*` APIs but does
 * NOT share a JS heap with the page, so it can't see `window.__VELOTYPE_DEVTOOLS_HOOK__` directly
 * -- only page-hook.ts (running in the MAIN world) can. This script is the relay between the two:
 *
 *   panel (DevTools page) <--Port--> background <--Port--> bridge.ts <--postMessage--> page-hook.ts
 *
 * It also owns the on-page highlight overlay, since drawing into the document is something an
 * ISOLATED-world content script can do directly (the DOM is shared across worlds, only the JS
 * heap is isolated).
 */
import {
    BRIDGE_SOURCE,
    PAGE_HOOK_SOURCE,
    TREE_PORT_NAME,
    type BridgeToPageMessage,
    type DOMRectSummary,
    type PageToBridgeMessage,
    type PanelRequest,
    type PanelResponse
} from "../shared/protocol.ts"

let requestCounter = 0
function nextRequestId(): string {
    requestCounter += 1
    return `r${requestCounter}`
}

const pendingRequests = new Map<string, (message: PageToBridgeMessage) => void>()

function requestFromPage(build: (requestId: string) => BridgeToPageMessage): Promise<PageToBridgeMessage> {
    const requestId = nextRequestId()
    return new Promise(resolve => {
        pendingRequests.set(requestId, resolve)
        window.postMessage(build(requestId), "*")
    })
}

window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return
    const data = event.data as PageToBridgeMessage | undefined
    if (!data || data.source !== PAGE_HOOK_SOURCE) return

    if (data.type === "hookStatus") {
        sendToPanel({ type: "hookStatus", status: data.status })
        return
    }
    if (data.type === "highlightRects") {
        drawOverlay(data.rects)
    }
    const resolver = pendingRequests.get(data.requestId)
    if (resolver) {
        pendingRequests.delete(data.requestId)
        resolver(data)
    }
})

// ---- Port to the background worker (which relays to/from the DevTools panel) ----------------

let port: chrome.runtime.Port | null = null

function sendToPanel(message: PanelResponse): void {
    try {
        port?.postMessage(message)
    } catch {
        // Port may be mid-reconnect; the panel will re-request on its next poll.
    }
}

function connect(): void {
    port = chrome.runtime.connect({ name: TREE_PORT_NAME })
    port.onMessage.addListener(async (message: PanelRequest) => {
        if (message.type === "requestHookStatus") {
            window.postMessage({ source: BRIDGE_SOURCE, type: "requestHookStatus" }, "*")
            return
        }
        if (message.type === "requestTree") {
            const response = await requestFromPage(requestId => ({ source: BRIDGE_SOURCE, type: "requestTree", requestId }))
            if (response.type === "tree") sendToPanel({ type: "tree", tree: response.tree })
            return
        }
        if (message.type === "requestDetails") {
            const response = await requestFromPage(requestId => ({ source: BRIDGE_SOURCE, type: "requestDetails", requestId, id: message.id }))
            if (response.type === "details") sendToPanel({ type: "details", details: response.details })
            return
        }
        if (message.type === "requestHighlight") {
            const response = await requestFromPage(requestId => ({ source: BRIDGE_SOURCE, type: "requestHighlight", requestId, id: message.id }))
            if (response.type === "highlightRects") drawOverlay(response.rects)
            return
        }
        if (message.type === "requestEvents") {
            const response = await requestFromPage(requestId => ({ source: BRIDGE_SOURCE, type: "requestEvents", requestId }))
            if (response.type === "events") sendToPanel({ type: "events", events: response.events })
            return
        }
        if (message.type === "requestFieldChildren") {
            const response = await requestFromPage(requestId => ({ source: BRIDGE_SOURCE, type: "requestFieldChildren", requestId, id: message.id, path: message.path }))
            if (response.type === "fieldChildren") sendToPanel({ type: "fieldChildren", id: response.id, path: response.path, children: response.children })
        }
    })
    port.onDisconnect.addListener(() => {
        port = null
    })
}
connect()

// ---- On-page highlight overlay ----------------------------------------------------------------

let overlayRoot: HTMLElement | null = null
let shadow: ShadowRoot | null = null

function ensureOverlay(): ShadowRoot {
    if (shadow) return shadow
    overlayRoot = document.createElement("div")
    overlayRoot.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;"
    shadow = overlayRoot.attachShadow({ mode: "open" })
    document.documentElement.appendChild(overlayRoot)
    return shadow
}

function drawOverlay(rects: DOMRectSummary[]): void {
    const root = ensureOverlay()
    root.innerHTML = ""
    for (const rect of rects) {
        const box = document.createElement("div")
        box.style.cssText = [
            "position:fixed",
            `top:${rect.top}px`,
            `left:${rect.left}px`,
            `width:${rect.width}px`,
            `height:${rect.height}px`,
            "background:rgba(79,70,229,0.25)",
            "border:1.5px solid rgb(79,70,229)",
            "box-sizing:border-box",
            "pointer-events:none"
        ].join(";")
        root.appendChild(box)
    }
}
