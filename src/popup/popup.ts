import { TREE_PORT_NAME, type HookStatus, type PanelResponse } from "../shared/protocol.ts"

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
    port.onMessage.addListener((message: PanelResponse) => {
        if (message.type === "hookStatus") renderStatus(message.status)
        else if (message.type === "contentScriptGone") statusEl.textContent = "Could not reach this page (try reloading it)."
    })
    setTimeout(() => {
        if (statusEl.textContent === "Checking this page…") {
            statusEl.innerHTML = '<span class="muted">No response yet — try reloading the page.</span>'
        }
    }, 1500)
})

function renderStatus(status: HookStatus): void {
    if (!status.present) {
        statusEl.textContent = "No Velotype instance detected on this page."
        return
    }
    const items = status.instances
        .map(i => `<li>instance #${i.instanceId} — ${i.componentCount} tracked object(s)</li>`)
        .join("")
    statusEl.innerHTML = `Velotype detected (${status.instances.length} instance(s)):<ul>${items}</ul>`
}
