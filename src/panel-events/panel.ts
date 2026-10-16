import { frameLabel } from "../shared/frames.ts"
import { TREE_PORT_NAME, type EventPartyRef, type EventsSnapshot, type FrameInfo, type HookStatus, type PanelResponse, type TracedEvent } from "../shared/protocol.ts"

const statusBar = document.getElementById("status-bar") as HTMLDivElement
const eventsBody = document.getElementById("events-body") as HTMLTableSectionElement

const port = chrome.runtime.connect({ name: TREE_PORT_NAME })
port.postMessage({ type: "init", tabId: chrome.devtools.inspectedWindow.tabId })

/** What each frame last sent: every frame has its own Velotype instances and event bus */
interface FrameState {
    frame: FrameInfo
    status: HookStatus
    events: EventsSnapshot
}
const frames = new Map<number, FrameState>()
let lostConnection = false

function present(): FrameState[] {
    return [...frames.values()].filter(state => state.status.present).sort((a, b) => a.frame.frameId - b.frame.frameId)
}

port.onMessage.addListener((message: PanelResponse) => {
    if (message.type === "contentScriptGone") {
        frames.clear()
        lostConnection = true
    } else if (message.type === "frameGone") {
        frames.delete(message.frame.frameId)
    } else if (message.type === "tracedEvents") {
        for (const event of message.events) trace.push({ frame: message.frame, event })
        if (trace.length > MAX_TRACE) trace.splice(0, trace.length - MAX_TRACE)
        renderTrace()
        return
    } else if (message.type === "hookStatus" || message.type === "events") {
        lostConnection = false
        let state = frames.get(message.frame.frameId)
        if (!state) {
            state = { frame: message.frame, status: { present: false, instances: [] }, events: { instances: [] } }
            frames.set(message.frame.frameId, state)
        }
        if (message.type === "hookStatus") state.status = message.status
        else state.events = message.events
    } else {
        return
    }
    renderStatus()
    renderEvents()
})

// ---- Event trace ----------------------------------------------------------------------------------

const MAX_TRACE = 1000
const trace: Array<{ frame: FrameInfo; event: TracedEvent }> = []
let tracing = false
const traceToggle = document.getElementById("trace-toggle") as HTMLButtonElement
const traceClear = document.getElementById("trace-clear") as HTMLButtonElement
const tracePane = document.getElementById("trace-pane") as HTMLDivElement
const traceBody = document.getElementById("trace-body") as HTMLTableSectionElement

traceToggle.addEventListener("click", () => {
    tracing = !tracing
    port.postMessage({ type: tracing ? "startEventTrace" : "stopEventTrace" })
    traceToggle.textContent = tracing ? "Stop trace" : "Start trace"
    traceToggle.classList.toggle("on", tracing)
    renderTrace()
})
traceClear.addEventListener("click", () => {
    trace.length = 0
    renderTrace()
})

function renderTrace(): void {
    tracePane.hidden = !tracing && trace.length === 0
    traceBody.innerHTML = ""
    const multipleFrames = new Set(trace.map(entry => entry.frame.frameId)).size > 1
    // The newest first, so that what just happened is at the top
    for (let i = trace.length - 1; i >= 0; i--) {
        const { frame, event } = trace[i]!
        const tr = document.createElement("tr")
        const time = document.createElement("td")
        time.className = "time-cell"
        const date = new Date(event.time)
        time.textContent = `${date.toLocaleTimeString([], { hour12: false })}.${String(date.getMilliseconds()).padStart(3, "0")}`
        const key = document.createElement("td")
        key.className = "key-cell"
        key.textContent = multipleFrames ? `${frameLabel(frame)} #${event.instanceId} ${event.key}` : event.key
        const name = document.createElement("td")
        name.textContent = event.name
        const emitter = document.createElement("td")
        if (event.emitter.label !== null) emitter.appendChild(chip(event.emitter, frame.frameId))
        else emitter.textContent = "—"
        const data = document.createElement("td")
        data.className = "data-cell"
        data.textContent = event.data ?? "—"
        const listeners = document.createElement("td")
        if (event.listeners.length === 0) listeners.textContent = "none"
        for (const listener of event.listeners) listeners.appendChild(chip(listener, frame.frameId))
        tr.append(time, key, name, emitter, data, listeners)
        traceBody.appendChild(tr)
    }
}

function refresh(): void {
    port.postMessage({ type: "requestHookStatus" })
    port.postMessage({ type: "requestEvents" })
}
refresh()
setInterval(refresh, 1500)

window.addEventListener("beforeunload", () => {
    try {
        if (tracing) port.postMessage({ type: "stopEventTrace" })
        port.postMessage({ type: "requestHighlight", id: null })
    } catch {
        // Panel is closing anyway.
    }
})

function renderStatus(): void {
    if (lostConnection) {
        statusBar.textContent = "Lost connection to this tab (navigated or reloaded?). Reopen DevTools to reconnect."
        return
    }
    const withVelotype = present()
    if (withVelotype.length === 0) {
        statusBar.textContent = "No Velotype instance detected on this page yet."
        return
    }
    statusBar.innerHTML = ""
    for (const { frame, status } of withVelotype) {
        for (const instance of status.instances) {
            const span = document.createElement("span")
            span.className = "instance"
            const where = withVelotype.length > 1 ? `${frameLabel(frame)}, ` : ""
            span.textContent = `${where}instance #${instance.instanceId} (velotype ${instance.version}): ${instance.componentCount} tracked object(s)`
            statusBar.appendChild(span)
        }
    }
}

function chip(party: EventPartyRef | { id: string; label: null; kind: null }, frameId: number): HTMLSpanElement {
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
    span.addEventListener("mouseenter", () => port.postMessage({ type: "requestHighlight", id: party.id, frameId }))
    span.addEventListener("mouseleave", () => port.postMessage({ type: "requestHighlight", id: null }))
    return span
}

function renderEvents(): void {
    eventsBody.innerHTML = ""
    const withVelotype = present()
    const crowded = withVelotype.length > 1 || withVelotype.some(state => state.events.instances.length > 1)
    const rows = withVelotype.flatMap(state => state.events.instances.flatMap(instance =>
        instance.keys.map(key => ({ frame: state.frame, instanceId: instance.instanceId, ...key }))))
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
        keyTd.textContent = withVelotype.length > 1 ? `${frameLabel(row.frame)} #${row.instanceId} ${row.key}`
            : crowded ? `#${row.instanceId} ${row.key}` : row.key
        tr.appendChild(keyTd)

        const ownerTd = document.createElement("td")
        if (row.owner) ownerTd.appendChild(chip(row.owner, row.frame.frameId))
        else ownerTd.textContent = "—"
        tr.appendChild(ownerTd)

        const listenersTd = document.createElement("td")
        listenersTd.textContent = ""
        for (const listener of row.listeners) listenersTd.appendChild(chip(listener, row.frame.frameId))
        tr.appendChild(listenersTd)

        eventsBody.appendChild(tr)
    }
}
