/* eslint-disable */
/**
 * Side-by-side comparison HTML between the most recent legacy round backup
 * (`test-output/airtable-rounds/<latest>`) and the most recent ifclite round
 * backup (`test-output/ifclite-rounds/<latest>`).
 *
 * Output: `test-output/compare-<roundId>.html` — one row per GUID that exists
 * in BOTH backups, with three columns (front / back / plan), each cell showing
 * legacy on top + ifclite below.
 */
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { resolve, basename } from 'node:path'

function latestSubdir(parent: string): string | null {
    const entries = readdirSync(parent, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, mtime: statSync(resolve(parent, e.name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
    return entries[0]?.name ?? null
}

function listGuids(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
}

function main(): void {
    const root = resolve(process.cwd(), 'test-output')
    const legacyParent = resolve(root, 'airtable-rounds')
    const newParent = resolve(root, 'ifclite-rounds')
    const legacyName = latestSubdir(legacyParent)
    const newName = latestSubdir(newParent)
    if (!legacyName) { console.error(`No legacy backup in ${legacyParent}`); process.exit(1) }
    if (!newName)    { console.error(`No ifclite backup in ${newParent}`); process.exit(1) }
    const legacyDir = resolve(legacyParent, legacyName)
    const newDir = resolve(newParent, newName)
    console.log(`Legacy: ${legacyDir}`)
    console.log(`New:    ${newDir}`)
    const legacyGuids = new Set(listGuids(legacyDir))
    const newGuids = new Set(listGuids(newDir))
    const both: string[] = []
    for (const g of newGuids) if (legacyGuids.has(g)) both.push(g)
    both.sort()
    console.log(`Common GUIDs: ${both.length} (legacy=${legacyGuids.size}, new=${newGuids.size})`)

    const rel = (abs: string) => abs.replace(root + '/', 'test-output/')

    const rows = both.map((g) => `
      <tr>
        <td class="guid">${g}</td>
        <td><div class="pair"><img src="${rel(resolve(legacyDir, g, 'front.png'))}"><img src="${rel(resolve(newDir, g, 'front.png'))}"></div></td>
        <td><div class="pair"><img src="${rel(resolve(legacyDir, g, 'back.png'))}"><img src="${rel(resolve(newDir, g, 'back.png'))}"></div></td>
        <td><div class="pair"><img src="${rel(resolve(legacyDir, g, 'plan.png'))}"><img src="${rel(resolve(newDir, g, 'plan.png'))}"></div></td>
      </tr>
    `).join('')

    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Door render compare — ${both.length} doors</title>
<style>
body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 16px; background: #f6f6f6; }
h1 { font-size: 16px; }
.note { color: #555; margin-bottom: 16px; font-size: 13px; }
table { border-collapse: collapse; width: 100%; }
th, td { vertical-align: top; padding: 4px; }
th { font-size: 12px; text-align: left; background: #fff; position: sticky; top: 0; z-index: 1; }
td.guid { font-family: ui-monospace, monospace; font-size: 11px; padding: 8px; min-width: 200px; }
.pair { display: flex; flex-direction: column; gap: 4px; }
.pair img { width: 100%; max-width: 320px; height: auto; border: 1px solid #ddd; background: #fff; display: block; }
.legend { font-size: 11px; color: #777; }
</style>
</head><body>
<h1>Door renders — legacy (top) vs ifclite (bottom)</h1>
<div class="note">
  Legacy: ${rel(legacyDir)}<br>
  New: ${rel(newDir)}<br>
  Common GUIDs: ${both.length} (legacy=${legacyGuids.size}, new=${newGuids.size}).<br>
  Each cell stacks legacy PNG on top of the new ifclite PNG.
</div>
<table>
  <thead><tr><th>GUID</th><th>front</th><th>back</th><th>plan</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</body></html>`
    const outPath = resolve(root, `compare-${newName}.html`)
    writeFileSync(outPath, html, 'utf8')
    console.log(`Wrote ${outPath}`)
}

main()
