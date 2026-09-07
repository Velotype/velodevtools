// One-off dev utility (not part of `deno task build`) to regenerate public/icons/*.png from
// assets/velotype-logo.svg -- the real Velotype project logo, copied from the velotype repo's own
// assets/logo.svg. Rasterizes via a real headless Chrome (astral) rather than a hand-rolled SVG
// renderer, since the logo has an arc in it. Re-run this manually if the logo ever changes; the
// checked-in PNGs are what actually ships.
import { launch } from "jsr:@astral/astral@^0.5.4"

const svgText = await Deno.readTextFile(new URL("../assets/velotype-logo.svg", import.meta.url))
const svgDataUrl = `data:image/svg+xml;base64,${btoa(svgText)}`

const browser = await launch({ headless: true, args: ["--no-sandbox"] })
const page = await browser.newPage()

for (const size of [16, 32, 48, 128]) {
    const dataUrl = await page.evaluate(
        ({ svgDataUrl, size }: { svgDataUrl: string; size: number }) => {
            return new Promise<string>((resolve, reject) => {
                const img = new Image()
                img.onload = () => {
                    const canvas = document.createElement("canvas")
                    canvas.width = size
                    canvas.height = size
                    const ctx = canvas.getContext("2d")
                    if (!ctx) {
                        reject(new Error("no 2d context"))
                        return
                    }
                    ctx.drawImage(img, 0, 0, size, size)
                    resolve(canvas.toDataURL("image/png"))
                }
                img.onerror = () => reject(new Error("image load failed"))
                img.src = svgDataUrl
            })
        },
        { args: [{ svgDataUrl, size }] }
    )
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1)
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
    const outPath = new URL(`../public/icons/icon${size}.png`, import.meta.url)
    await Deno.writeFile(outPath, bytes)
    console.log(`wrote ${outPath.pathname} (${bytes.length} bytes)`)
}

await page.close()
await browser.close()
