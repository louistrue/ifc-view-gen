// `@resvg/resvg-js` is a native-addon package with platform-specific optional
// dependencies; load it lazily so ts-node doesn't blow up at import time on a
// machine where only the main package (and not its platform addon) is present.
type ResvgCtor = new (svg: string, options: { fitTo: { mode: 'width'; value: number } }) => {
    render: () => { asPng: () => Buffer | Uint8Array }
}

let cachedResvg: ResvgCtor | null = null
function getResvg(): ResvgCtor {
    if (cachedResvg) return cachedResvg
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@resvg/resvg-js') as { Resvg: ResvgCtor }
    cachedResvg = mod.Resvg
    return cachedResvg
}

/** Pixel width the Airtable round script standardises on for rasterised views. */
export const DEFAULT_RASTER_WIDTH_PX = 1400

export function rasterizeSvgToPng(svg: string, widthPx: number = DEFAULT_RASTER_WIDTH_PX): Buffer {
    const Resvg = getResvg()
    const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: widthPx } })
    const out = resvg.render().asPng()
    return Buffer.isBuffer(out) ? out : Buffer.from(out)
}
