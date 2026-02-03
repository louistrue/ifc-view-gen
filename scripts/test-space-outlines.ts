import * as fs from 'fs'
import * as path from 'path'
import { IfcAPI } from 'web-ifc'
import * as THREE from 'three'
import { extractSpaceProfileOutlines } from '../lib/ifc-loader'

/**
 * Standalone test script to extract and visualize space outlines from IFC file
 * Compares real profile outlines vs bounding boxes
 */
async function testSpaceOutlines() {
    console.log('=== Space Outline Extraction Test ===\n')

    // Initialize web-ifc API
    const api = new IfcAPI()
    await api.Init()
    api.SetWasmPath(path.join(__dirname, '../public/wasm/web-ifc/'), true)

    // Load IFC file
    const filePath = path.join(__dirname, '../01_Snowdon_Towers_Sample_Structural(1).ifc')

    if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`)
        process.exit(1)
    }

    console.log(`Loading IFC file: ${filePath}`)
    const fileData = fs.readFileSync(filePath)
    const modelID = api.OpenModel(new Uint8Array(fileData))

    if (modelID === -1) {
        console.error('Failed to open IFC model')
        process.exit(1)
    }

    console.log(`Model loaded with ID: ${modelID}\n`)

    // Get all IFCSPACE entities
    // Try to get IFCSPACE constant from web-ifc, fallback to known value
    const WebIFC = require('web-ifc')
    const IFCSPACE = (WebIFC as any).IFCSPACE || 242 // Fallback to 242 if constant not found
    const spaceIds = api.GetLineIDsWithType(modelID, IFCSPACE)
    console.log(`Found ${spaceIds.size()} spaces\n`)

    const results: Array<{
        expressID: number
        name: string
        profilePoints: THREE.Vector2[] | null
        boundingBox: { min: THREE.Vector2; max: THREE.Vector2; width: number; depth: number } | null
    }> = []

    // Extract outlines for each space
    for (let i = 0; i < spaceIds.size(); i++) {
        const spaceID = spaceIds.get(i)
        const space = api.GetLine(modelID, spaceID)

        if (!space) continue

        // Get space name
        const name = (space as any).Name?.value ||
            (space as any).LongName?.value ||
            `Space ${spaceID}`

        console.log(`\n[${i + 1}/${spaceIds.size()}] Processing: ${name} (ID: ${spaceID})`)

        // Extract profile outline
        let profilePoints: THREE.Vector2[] | null = null
        try {
            profilePoints = await extractSpaceProfileOutlines(api, modelID, spaceID)
            if (profilePoints) {
                console.log(`  ✓ Extracted ${profilePoints.length}-point profile outline`)
                console.log(`    Points: ${profilePoints.slice(0, 3).map(p => `(${p.x.toFixed(2)}, ${p.y.toFixed(2)})`).join(', ')}...`)
            } else {
                console.log(`  ✗ No profile outline extracted`)
            }
        } catch (error) {
            console.log(`  ✗ Error extracting profile: ${error}`)
        }

        // Get bounding box from geometry (if available)
        let boundingBox: { min: THREE.Vector2; max: THREE.Vector2; width: number; depth: number } | null = null
        try {
            // Try to get bounding box from geometry
            // For now, we'll calculate from profile points if available
            if (profilePoints && profilePoints.length > 0) {
                let minX = Infinity, maxX = -Infinity
                let minY = Infinity, maxY = -Infinity

                for (const point of profilePoints) {
                    minX = Math.min(minX, point.x)
                    maxX = Math.max(maxX, point.x)
                    minY = Math.min(minY, point.y)
                    maxY = Math.max(maxY, point.y)
                }

                boundingBox = {
                    min: new THREE.Vector2(minX, minY),
                    max: new THREE.Vector2(maxX, maxY),
                    width: maxX - minX,
                    depth: maxY - minY,
                }
            }
        } catch (error) {
            console.log(`  ✗ Error calculating bounding box: ${error}`)
        }

        results.push({
            expressID: spaceID,
            name,
            profilePoints,
            boundingBox,
        })
    }

    // Generate comparison SVG
    console.log(`\n=== Generating Comparison SVG ===`)
    const outputDir = path.join(__dirname, '../test-output')
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true })
    }

    for (const result of results) {
        if (!result.profilePoints || result.profilePoints.length < 3) {
            console.log(`Skipping ${result.name} - no valid profile`)
            continue
        }

        const svg = generateComparisonSVG(result.name, result.profilePoints, result.boundingBox)
        const filename = `space-${result.expressID}-${result.name.replace(/[^a-zA-Z0-9]/g, '_')}.svg`
        const filepath = path.join(outputDir, filename)
        fs.writeFileSync(filepath, svg)
        console.log(`Generated: ${filename}`)
    }

    // Summary
    console.log(`\n=== Summary ===`)
    console.log(`Total spaces: ${results.length}`)
    console.log(`Spaces with profile outlines: ${results.filter(r => r.profilePoints && r.profilePoints.length >= 3).length}`)
    console.log(`Spaces without profiles: ${results.filter(r => !r.profilePoints || r.profilePoints.length < 3).length}`)

    if (results.some(r => r.profilePoints && r.profilePoints.length >= 3)) {
        const withProfiles = results.filter(r => r.profilePoints && r.profilePoints.length >= 3)
        console.log(`\nProfile point counts:`)
        for (const r of withProfiles) {
            console.log(`  ${r.name}: ${r.profilePoints!.length} points`)
        }
    }

    // Cleanup
    api.CloseModel(modelID)
    console.log(`\nTest complete! Check ${outputDir} for SVG files.`)
}

/**
 * Generate SVG comparing real outline vs bounding box
 */
function generateComparisonSVG(
    name: string,
    profilePoints: THREE.Vector2[],
    boundingBox: { min: THREE.Vector2; max: THREE.Vector2; width: number; depth: number } | null
): string {
    const width = 1200
    const height = 800
    const margin = 50

    // Calculate bounds
    let minX = Infinity, maxX = -Infinity
    let minY = Infinity, maxY = -Infinity

    for (const point of profilePoints) {
        minX = Math.min(minX, point.x)
        maxX = Math.max(maxX, point.x)
        minY = Math.min(minY, point.y)
        maxY = Math.max(maxY, point.y)
    }

    if (boundingBox) {
        minX = Math.min(minX, boundingBox.min.x)
        maxX = Math.max(maxX, boundingBox.max.x)
        minY = Math.min(minY, boundingBox.min.y)
        maxY = Math.max(maxY, boundingBox.max.y)
    }

    const worldWidth = maxX - minX
    const worldHeight = maxY - minY
    const scale = Math.min(
        (width - margin * 2) / worldWidth,
        (height - margin * 2) / worldHeight
    ) * 0.9

    const offsetX = (width - worldWidth * scale) / 2
    const offsetY = (height - worldHeight * scale) / 2

    const toSVG = (p: THREE.Vector2) => ({
        x: (p.x - minX) * scale + offsetX,
        y: height - ((p.y - minY) * scale + offsetY), // Flip Y
    })

    // Build SVG
    let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <style>
      .bbox { fill: none; stroke: #ff0000; stroke-width: 2; stroke-dasharray: 8,4; opacity: 0.7; }
      .profile { fill: #e3f2fd; stroke: #1976d2; stroke-width: 3; }
      .label { font-family: Arial, sans-serif; font-size: 16px; fill: #333; }
    </style>
  </defs>
  <rect width="100%" height="100%" fill="#f5f5f5"/>
  
  <!-- Bounding box (dashed red) -->
`

    if (boundingBox) {
        const bboxPoints = [
            new THREE.Vector2(boundingBox.min.x, boundingBox.min.y),
            new THREE.Vector2(boundingBox.max.x, boundingBox.min.y),
            new THREE.Vector2(boundingBox.max.x, boundingBox.max.y),
            new THREE.Vector2(boundingBox.min.x, boundingBox.max.y),
        ]
        const bboxPath = bboxPoints.map((p, i) => {
            const svgP = toSVG(p)
            return i === 0 ? `M ${svgP.x.toFixed(2)} ${svgP.y.toFixed(2)}` : `L ${svgP.x.toFixed(2)} ${svgP.y.toFixed(2)}`
        }).join(' ') + ' Z'
        svg += `  <path d="${bboxPath}" class="bbox"/>\n`
    }

    // Profile outline (solid blue)
    const profilePath = profilePoints.map((p, i) => {
        const svgP = toSVG(p)
        return i === 0 ? `M ${svgP.x.toFixed(2)} ${svgP.y.toFixed(2)}` : `L ${svgP.x.toFixed(2)} ${svgP.y.toFixed(2)}`
    }).join(' ') + ' Z'
    svg += `  <path d="${profilePath}" class="profile"/>\n`

    // Labels
    svg += `  <text x="${width / 2}" y="30" text-anchor="middle" class="label" font-weight="bold">${escapeXml(name)}</text>\n`
    svg += `  <text x="${width / 2}" y="55" text-anchor="middle" class="label" font-size="14">Profile: ${profilePoints.length} points</text>\n`

    if (boundingBox) {
        svg += `  <text x="${width / 2}" y="75" text-anchor="middle" class="label" font-size="14">Bounding Box: ${boundingBox.width.toFixed(2)} × ${boundingBox.depth.toFixed(2)}</text>\n`
    }

    svg += `  <text x="20" y="${height - 40}" class="label" font-size="12" fill="#1976d2">Real Outline (${profilePoints.length} points)</text>\n`
    svg += `  <text x="20" y="${height - 20}" class="label" font-size="12" fill="#ff0000">Bounding Box (4 points)</text>\n`

    svg += `</svg>`
    return svg
}

function escapeXml(str: string): string {
    return str.replace(/[<>&'"]/g, c => ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        "'": '&apos;',
        '"': '&quot;'
    }[c] || c))
}

// Run the test
testSpaceOutlines().catch(error => {
    console.error('Test failed:', error)
    process.exit(1)
})
