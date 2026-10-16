import type { FrameInfo } from "./protocol.ts"

/** How a frame is named in the panels: "Top frame", or "iframe" and its address */
export function frameLabel(frame: FrameInfo): string {
    return frame.frameId === 0 ? "Top frame" : `iframe ${frame.url}`
}
