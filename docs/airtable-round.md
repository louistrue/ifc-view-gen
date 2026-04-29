# Airtable render round

Local-only pipeline: render door views from the IFC, overwrite the attachments
on an Airtable Doors table, human reviews, rerun.

## One-time setup

1. Create an Airtable Personal Access Token with scopes:
   - `data.records:read`
   - `data.records:write`
   - `schema.bases:write` (only needed for the first `airtable:setup` run)
   - access to the target base.

2. Populate `.env` at the repo root:

   ```
   AIRTABLE_TOKEN=pat_...
   AIRTABLE_BASE_ID=app...           # leave blank first; setup script lists bases
   AIRTABLE_TABLE_NAME=Doors
   ARCH_IFC_PATH=scripts/Flu21_A_AR_..._260421.ifc
   ELEC_IFC_PATH=scripts/Flu21_A_EL_..._IFC Elektro.ifc
   ```

3. Create the table schema:

   ```
   npm run airtable:setup
   ```

   Safe to re-run: existing fields are kept, missing ones are added.

4. Seed door GUIDs from the IFC (optional — you can also paste GUIDs by hand):

   ```
   npm run airtable:import-doors
   ```

   Writes new rows with `Valid=no`; leaves existing rows alone.

## Per round

```
npm run round
```

Fetches every record with `Valid != yes`, renders plan + front + back from the
IFC, rasterises each SVG to a 1400 px-wide PNG, and overwrites the Plan /
Front / Back attachment columns. A timestamped SVG/PNG backup of every render
is kept under `test-output/airtable-rounds/<timestamp>/<guid>/` (gitignored).

Review the results in Airtable, flip `Valid=yes` on good ones, edit `Comment`
and `Category` on bad ones. Run `npm run round` again to pick up only the
non-yes queue.

## Variants

| Command | Purpose |
| --- | --- |
| `npm run round:dry` | List targets, render nothing. |
| `npm run round:local` | Render + rasterise + local backup, skip Airtable. |
| `npm run round:force` | Include `Valid=yes` (regression re-renders). |
| `npm run round:subset` | Read GUIDs from `scripts/guid.json`. |
| `npm run round -- --guids=ID1,ID2` | Subset via CLI. |
| `npm run round -- --only=plan` | Re-render just one view. |
| `npm run round -- --limit=3` | Smoke-test the first few. |

## Airtable schema

Seven fields only — everything machine-unfriendly is deliberate:

| Field | Type | Writer |
| --- | --- | --- |
| GUID | Single line (primary) | human / seed |
| Valid | Single select: yes, no | human |
| Comment | Long text | human |
| Category | Single line text (free-form) | human |
| Plan / Front / Back | Attachment | script |

No status fields, no diagnostics, no log. If a render fails you notice because
the PNG didn't update; the full error and the SVG/PNG are in the backup dir.

## Safety notes

- `.airtable-round.lock` in the repo root prevents concurrent rounds (60 min
  TTL; stale locks are auto-stolen with a warning).
- Attachment uploads go directly to `content.airtable.com` — no public URL or
  blob host involved. 5 MB per file is the hard ceiling; the script retries at
  width 1000 if a render comes out larger.
- All Airtable traffic is rate-limited to ≤5 req/s per base; 429s are retried
  with exponential backoff.
