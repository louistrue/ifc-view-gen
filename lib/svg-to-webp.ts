/**
 * Rasterize SVG strings to WebP data URLs in the browser (for Airtable attachments).
 * Falls back to PNG if `image/webp` is not encodable in this browser.
 */

function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image()
        img.decoding = 'async'
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error('Failed to decode SVG as image'))
        img.src = src
    })
}

function canvasToDataUrl(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<string | null> {
    return new Promise((resolve) => {
        canvas.toBlob(
            (blob) => {
                if (!blob) {
                    resolve(null)
                    return
                }
                const reader = new FileReader()
                reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
                reader.onerror = () => resolve(null)
                reader.readAsDataURL(blob)
            },
            mime,
            quality
        )
    })
}

export interface SvgToWebpOptions {
    /** WebP quality 0–1 (default 0.92) */
    quality?: number
}

/**
 * Converts an SVG document string to `data:image/webp;base64,...` (or PNG fallback).
 * Must run in a browser (uses Image + Canvas).
 */
export async function svgStringToWebpDataUrl(svg: string, options?: SvgToWebpOptions): Promise<string> {
    if (typeof document === 'undefined') {
        throw new Error('svgStringToWebpDataUrl requires a browser environment')
    }

    const quality = options?.quality ?? 0.92
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    const objectUrl = URL.createObjectURL(blob)

    try {
        const img = await loadImage(objectUrl)
        const w = Math.max(1, Math.round(img.naturalWidth || img.width))
        const h = Math.max(1, Math.round(img.naturalHeight || img.height))

        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) {
            throw new Error('Canvas 2D context not available')
        }

        ctx.drawImage(img, 0, 0)

        const webp = await canvasToDataUrl(canvas, 'image/webp', quality)
        if (webp) {
            return webp
        }

        const png = await canvasToDataUrl(canvas, 'image/png')
        if (png) {
            return png
        }

        throw new Error('Failed to encode raster image from SVG')
    } finally {
        URL.revokeObjectURL(objectUrl)
    }
}
