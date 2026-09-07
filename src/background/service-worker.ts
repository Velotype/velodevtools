/**
 * Pure message relay, keyed by tabId, between:
 *   - bridge.ts content-script Ports (one per tab; `port.sender.tab.id` is set automatically)
 *   - panel-tree / popup Ports (DevTools pages have no `sender.tab`, so they announce their
 *     target tabId as their first message -- see PanelInitMessage in shared/protocol.ts)
 *
 * Neither side needs to know about the other directly; this just does the bookkeeping so
 * multiple panels/popups for the same tab all receive the same content script's responses.
 */
import { TREE_PORT_NAME, type PanelPortMessage, type PanelResponse } from "../shared/protocol.ts"

const contentPorts = new Map<number, chrome.runtime.Port>()
const panelPorts = new Map<number, Set<chrome.runtime.Port>>()

function panelsFor(tabId: number): Set<chrome.runtime.Port> {
    let set = panelPorts.get(tabId)
    if (!set) {
        set = new Set()
        panelPorts.set(tabId, set)
    }
    return set
}

chrome.runtime.onConnect.addListener(port => {
    if (port.name !== TREE_PORT_NAME) return

    const tabIdFromSender = port.sender?.tab?.id
    if (tabIdFromSender !== undefined) {
        // A bridge.ts content script connected.
        contentPorts.set(tabIdFromSender, port)
        port.onMessage.addListener((message: PanelResponse) => {
            for (const panelPort of panelsFor(tabIdFromSender)) {
                try {
                    panelPort.postMessage(message)
                } catch {
                    // Panel port closing; it'll be cleaned up by its own onDisconnect.
                }
            }
        })
        port.onDisconnect.addListener(() => {
            if (contentPorts.get(tabIdFromSender) === port) {
                contentPorts.delete(tabIdFromSender)
            }
        })
        return
    }

    // A panel or popup connected; it must announce its tabId before sending anything else.
    let boundTabId: number | null = null
    port.onMessage.addListener((message: PanelPortMessage) => {
        if (message.type === "init") {
            boundTabId = message.tabId
            panelsFor(boundTabId).add(port)
            return
        }
        if (boundTabId === null) return
        const contentPort = contentPorts.get(boundTabId)
        if (contentPort) {
            try {
                contentPort.postMessage(message)
            } catch {
                try {
                    port.postMessage({ type: "contentScriptGone" } satisfies PanelResponse)
                } catch {
                    // Panel port already closing.
                }
            }
        } else {
            try {
                port.postMessage({ type: "contentScriptGone" } satisfies PanelResponse)
            } catch {
                // Panel port already closing.
            }
        }
    })
    port.onDisconnect.addListener(() => {
        if (boundTabId !== null) panelsFor(boundTabId).delete(port)
    })
})
