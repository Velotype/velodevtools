/**
 * Pure message relay, keyed by tabId and frameId, between:
 *   - bridge.ts content-script Ports (one per frame: every frame runs its own content scripts and
 *     has its own Velotype instances; `port.sender.tab.id` and `port.sender.frameId` are set
 *     automatically)
 *   - panel-tree / popup Ports (DevTools pages have no `sender.tab`, so they announce their
 *     target tabId as their first message -- see PanelInitMessage in shared/protocol.ts)
 *
 * Neither side needs to know about the other directly; this just does the bookkeeping so
 * multiple panels/popups for the same tab all receive the responses of every frame, each tagged
 * with the frame it came from.
 */
import {
    TREE_PORT_NAME,
    type ContentResponse,
    type FrameInfo,
    type PanelPortMessage,
    type PanelRequest,
    type PanelResponse
} from "../shared/protocol.ts"

interface ContentFrame {
    port: chrome.runtime.Port
    frame: FrameInfo
}

/** tabId -> frameId -> that frame's content script */
const contentFrames = new Map<number, Map<number, ContentFrame>>()
const panelPorts = new Map<number, Set<chrome.runtime.Port>>()
/**
 * Features that run in the pages only while a panel wants them: how many panels of a tab have
 * asked (the VeloJSON panel for body capture, the Events panel for the event trace)
 */
const FEATURES = [
    { start: "startBodyCapture", stop: "stopBodyCapture", wanted: new Map<number, number>() },
    { start: "startEventTrace", stop: "stopEventTrace", wanted: new Map<number, number>() },
] as const

function panelsFor(tabId: number): Set<chrome.runtime.Port> {
    let set = panelPorts.get(tabId)
    if (!set) {
        set = new Set()
        panelPorts.set(tabId, set)
    }
    return set
}

function framesFor(tabId: number): Map<number, ContentFrame> {
    let map = contentFrames.get(tabId)
    if (!map) {
        map = new Map()
        contentFrames.set(tabId, map)
    }
    return map
}

function tell(port: chrome.runtime.Port, message: PanelResponse): void {
    try {
        port.postMessage(message)
    } catch {
        // Port closing; it'll be cleaned up by its own onDisconnect.
    }
}

function tellPanels(tabId: number, message: PanelResponse): void {
    for (const panelPort of panelsFor(tabId)) tell(panelPort, message)
}

chrome.runtime.onConnect.addListener(port => {
    if (port.name !== TREE_PORT_NAME) return

    const tabIdFromSender = port.sender?.tab?.id
    if (tabIdFromSender !== undefined) {
        // A bridge.ts content script connected, from the top frame or from an iframe.
        const frame: FrameInfo = { frameId: port.sender?.frameId ?? 0, url: port.sender?.url ?? "" }
        framesFor(tabIdFromSender).set(frame.frameId, { port, frame })
        // A frame that loads while a panel wants a feature (an iframe, or after a navigation) joins in
        for (const feature of FEATURES) {
            if ((feature.wanted.get(tabIdFromSender) ?? 0) > 0) port.postMessage({ type: feature.start })
        }
        port.onMessage.addListener((message: ContentResponse) => {
            tellPanels(tabIdFromSender, { ...message, frame })
        })
        port.onDisconnect.addListener(() => {
            const frames = framesFor(tabIdFromSender)
            // A frame that navigated has already connected again under the same id
            if (frames.get(frame.frameId)?.port === port) {
                frames.delete(frame.frameId)
                if (frames.size === 0) contentFrames.delete(tabIdFromSender)
                tellPanels(tabIdFromSender, { type: "frameGone", frame })
            }
        })
        return
    }

    // A panel or popup connected; it must announce its tabId before sending anything else.
    let boundTabId: number | null = null
    /** The features this panel has started */
    const started = new Set<(typeof FEATURES)[number]>()
    port.onMessage.addListener((message: PanelPortMessage) => {
        if (message.type === "init") {
            boundTabId = message.tabId
            panelsFor(boundTabId).add(port)
            return
        }
        if (boundTabId === null) return
        for (const feature of FEATURES) {
            if (message.type === feature.start && !started.has(feature)) {
                started.add(feature)
                feature.wanted.set(boundTabId, (feature.wanted.get(boundTabId) ?? 0) + 1)
            } else if (message.type === feature.stop) {
                // Only the last panel to stop wanting a feature stops it in the pages
                if (started.delete(feature) && stopWanting(feature, boundTabId)) send([...framesFor(boundTabId).values()], message)
                return
            }
        }
        const frames = [...framesFor(boundTabId).values()]
        if (frames.length === 0) {
            tell(port, { type: "contentScriptGone" })
            return
        }
        send(frames, message)
    })
    port.onDisconnect.addListener(() => {
        if (boundTabId === null) return
        panelsFor(boundTabId).delete(port)
        for (const feature of started) {
            if (stopWanting(feature, boundTabId)) send([...framesFor(boundTabId).values()], { type: feature.stop })
        }
    })
})

/** One panel less wants a feature: true when none does, so that it should stop in the pages */
function stopWanting(feature: (typeof FEATURES)[number], tabId: number): boolean {
    const remaining = (feature.wanted.get(tabId) ?? 1) - 1
    if (remaining > 0) {
        feature.wanted.set(tabId, remaining)
        return false
    }
    feature.wanted.delete(tabId)
    return true
}

function send(frames: ContentFrame[], request: PanelRequest): void {
    const frameId = "frameId" in request ? request.frameId : undefined
    for (const { port, frame } of frames) {
        let toSend: PanelRequest = request
        if (frameId !== undefined && frame.frameId !== frameId) {
            // Only the frame that owns the node answers, but a highlight elsewhere has to go
            if (request.type !== "requestHighlight") continue
            toSend = { type: "requestHighlight", id: null }
        }
        try {
            port.postMessage(toSend)
        } catch {
            // That frame is going away; its onDisconnect tells the panels.
        }
    }
}
