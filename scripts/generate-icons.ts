// Generates the extension's toolbar/devtools icons as plain PNGs using only Web-standard APIs
// (CompressionStream) -- no image library, no npm. Draws a solid background square with a white
// "V" chevron.

const outDir = new URL("../public/icons/", import.meta.url)
await Deno.mkdir(outDir, { recursive: true })

const BG: [number, number, number] = [0x4f, 0x46, 0xe5] // indigo-600
const FG: [number, number, number] = [0xff, 0xff, 0xff]

const CRC_TABLE = (() => {
    const table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
        }
        table[n] = c >>> 0
    }
    return table
})()

function crc32(buf: Uint8Array): number {
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i++) {
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    }
    return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
    const typeBytes = new TextEncoder().encode(type)
    const len = new Uint8Array(4)
    new DataView(len.buffer).setUint32(0, data.length, false)
    const crcInput = new Uint8Array(typeBytes.length + data.length)
    crcInput.set(typeBytes)
    crcInput.set(data, typeBytes.length)
    const crc = new Uint8Array(4)
    new DataView(crc.buffer).setUint32(0, crc32(crcInput), false)
    return concat([len, typeBytes, data, crc])
}

function concat(parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, p) => sum + p.length, 0)
    const result = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
        result.set(part, offset)
        offset += part.length
    }
    return result
}

/** zlib-wrapped deflate, matching what a PNG IDAT chunk needs -- CompressionStream's "deflate"
 *  format is zlib (RFC 1950), as opposed to "deflate-raw" which omits the zlib wrapper. */
async function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"))
    return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Signed distance-ish test for a chevron ("V") shape centered in a size x size box */
function isChevronPixel(x: number, y: number, size: number): boolean {
    const nx = x / size
    const ny = y / size
    const thickness = 0.22
    // Two diagonal strokes meeting at the bottom-center, like a checkmark/V
    const leftStroke = Math.abs((ny - 0.22) - (nx - 0.18) * 1.35) < thickness && nx < 0.52 && ny > 0.18 && ny < 0.82
    const rightStroke = Math.abs((ny - 0.82) - (0.82 - nx) * 1.35) < thickness && nx >= 0.48 && ny > 0.18 && ny < 0.82
    return leftStroke || rightStroke
}

async function generatePng(size: number): Promise<Uint8Array> {
    const raw = new Uint8Array((size * 4 + 1) * size)
    let pos = 0
    for (let y = 0; y < size; y++) {
        raw[pos++] = 0 // filter type: none
        for (let x = 0; x < size; x++) {
            const [r, g, b] = isChevronPixel(x, y, size) ? FG : BG
            raw[pos++] = r
            raw[pos++] = g
            raw[pos++] = b
            raw[pos++] = 255
        }
    }

    const ihdr = new Uint8Array(13)
    const ihdrView = new DataView(ihdr.buffer)
    ihdrView.setUint32(0, size, false)
    ihdrView.setUint32(4, size, false)
    ihdr[8] = 8 // bit depth
    ihdr[9] = 6 // color type: RGBA

    const idat = await zlibDeflate(raw)
    const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    return concat([signature, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array())])
}

for (const size of [16, 32, 48, 128]) {
    const png = await generatePng(size)
    const path = new URL(`icon${size}.png`, outDir)
    await Deno.writeFile(path, png)
    console.log(`wrote ${path.pathname} (${png.length} bytes)`)
}
