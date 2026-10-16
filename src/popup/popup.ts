import { frameLabel } from "../shared/frames.ts"
import { TREE_PORT_NAME, type FrameInfo, type HookStatus, type PanelResponse } from "../shared/protocol.ts"

const statusEl = document.getElementById("status") as HTMLDivElement

chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tabId = tabs[0]?.id
    if (tabId === undefined) {
        statusEl.textContent = "No active tab."
        return
    }
    const port = chrome.runtime.connect({ name: TREE_PORT_NAME })
    port.postMessage({ type: "init", tabId })
    port.postMessage({ type: "requestHookStatus" })
    const reports = new Map<number, { frame: FrameInfo; status: HookStatus }>()
    port.onMessage.addListener((message: PanelResponse) => {
        if (message.type === "hookStatus") {
            reports.set(message.frame.frameId, { frame: message.frame, status: message.status })
            renderStatus([...reports.values()].sort((a, b) => a.frame.frameId - b.frame.frameId))
        } else if (message.type === "contentScriptGone") statusEl.textContent = "Could not reach this page (try reloading it)."
    })
    setTimeout(() => {
        if (statusEl.textContent === "Checking this page…") {
            statusEl.innerHTML = '<span class="muted">No response yet — try reloading the page.</span>'
        }
    }, 1500)
})

function renderStatus(reports: Array<{ frame: FrameInfo; status: HookStatus }>): void {
    // Every frame of the page answers, and most of them have no Velotype
    const withVelotype = reports.filter(report => report.status.present)
    if (withVelotype.length === 0) {
        statusEl.textContent = "No Velotype instance detected on this page."
        return
    }
    // Built with textContent, since version and url are strings from the page
    const list = document.createElement("ul")
    for (const { frame, status } of withVelotype) {
        for (const i of status.instances) {
            const item = document.createElement("li")
            const where = withVelotype.length > 1 ? `${frameLabel(frame)}: ` : ""
            item.textContent = `${where}instance #${i.instanceId} (velotype ${i.version}) — ${i.componentCount} tracked object(s)`
            list.appendChild(item)
        }
    }
    const count = withVelotype.reduce((sum, report) => sum + report.status.instances.length, 0)
    statusEl.textContent = `Velotype detected (${count} instance(s)):`
    statusEl.appendChild(list)
}
