import { TREE_PORT_NAME, type EventPartyRef, type EventsSnapshot, type HookStatus, type PanelResponse } from "../shared/protocol.ts"

const statusBar = document.getElementById("status-bar") as HTMLDivElement
const eventsBody = document.getElementById("events-body") as HTMLTableSectionElement

const port = chrome.runtime.connect({ name: TREE_PORT_NAME })
port.postMessage({ type: "init", tabId: chrome.devtools.inspectedWindow.tabId })

port.onMessage.addListener((message: PanelResponse) => {
    if (message.type === "hookStatus") renderStatus(message.status)
    else if (message.type === "events") renderEvents(message.events)
    else if (message.type === "contentScriptGone") renderStatus({ present: false, instances: [] }, true)
})

function refresh(): void {
    port.postMessage({ type: "requestHookStatus" })
    port.postMessage({ type: "requestEvents" })
}
refresh()
setInterval(refresh, 1500)

window.addEventListener("beforeunload", () => {
    try {
        port.postMessage({ type: "requestHighlight", id: null })
    } catch {
        // Panel is closing anyway.
    }
})

function renderStatus(status: HookStatus, contentScriptGone = false): void {
    if (contentScriptGone) {
        statusBar.textContent = "Lost connection to this tab (navigated or reloaded?). Reopen DevTools to reconnect."
        return
    }
    if (!status.present) {
        statusBar.textContent = "No Velotype instance detected on this page yet."
        return
    }
    statusBar.innerHTML = ""
    for (const instance of status.instances) {
        const span = document.createElement("span")
        span.className = "instance"
        span.textContent = `instance #${instance.instanceId} (attr "${instance.domKeyName}"): ${instance.componentCount} tracked object(s)`
        statusBar.appendChild(span)
    }
}

function chip(party: EventPartyRef | { id: string; label: null; kind: null }): HTMLSpanElement {
    const span = document.createElement("span")
    if (party.label === null) {
        span.className = "chip unresolved"
        span.textContent = "(unresolved)"
        return span
    }
    span.className = "chip"
    span.textContent = party.label
    const kindSpan = document.createElement("span")
    kindSpan.className = "chip-kind"
    kindSpan.textContent = party.kind
    span.appendChild(kindSpan)
    span.addEventListener("mouseenter", () => port.postMessage({ type: "requestHighlight", id: party.id }))
    span.addEventListener("mouseleave", () => port.postMessage({ type: "requestHighlight", id: null }))
    return span
}

function renderEvents(events: EventsSnapshot): void {
    eventsBody.innerHTML = ""
    const rows = events.instances.flatMap(instance => instance.keys.map(key => ({ instanceId: instance.instanceId, ...key })))
    if (rows.length === 0) {
        const tr = document.createElement("tr")
        const td = document.createElement("td")
        td.colSpan = 3
        td.className = "empty-note"
        td.textContent = "No registered event listeners found."
        tr.appendChild(td)
        eventsBody.appendChild(tr)
        return
    }
    for (const row of rows) {
        const tr = document.createElement("tr")

        const keyTd = document.createElement("td")
        keyTd.className = "key-cell"
        keyTd.textContent = events.instances.length > 1 ? `#${row.instanceId} ${row.key}` : row.key
        tr.appendChild(keyTd)

        const ownerTd = document.createElement("td")
        if (row.owner) ownerTd.appendChild(chip(row.owner))
        else ownerTd.textContent = "—"
        tr.appendChild(ownerTd)

        const listenersTd = document.createElement("td")
        listenersTd.textContent = ""
        for (const listener of row.listeners) listenersTd.appendChild(chip(listener))
        tr.appendChild(listenersTd)

        eventsBody.appendChild(tr)
    }
}
