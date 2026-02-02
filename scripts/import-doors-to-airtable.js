#!/usr/bin/env node

/**
 * Script to import all doors from an IFC file into Airtable
 * 
 * This script:
 * 1. Parses the IFC file to extract all doors
 * 2. Gets door GlobalId, type name, and opening direction
 * 3. Creates a record in Airtable for each door
 * 
 * Usage:
 *   node scripts/import-doors-to-airtable.js [ifc-file-path]
 * 
 * Required environment variables:
 *   AIRTABLE_TOKEN - Your Airtable Personal Access Token
 *   AIRTABLE_BASE_ID - Your Airtable Base ID
 *   AIRTABLE_TABLE_NAME - Table name (defaults to "Doors")
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const WebIFC = require('web-ifc');

// Airtable configuration
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Doors';
const AIRTABLE_API_BASE = 'https://api.airtable.com/v0';

if (!AIRTABLE_TOKEN) {
    console.error('❌ AIRTABLE_TOKEN environment variable is required');
    process.exit(1);
}

if (!AIRTABLE_BASE_ID) {
    console.error('❌ AIRTABLE_BASE_ID environment variable is required');
    console.error('   Run the setup script first: node scripts/setup-airtable.js');
    process.exit(1);
}

async function fetchWithAuth(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
            'Content-Type': 'application/json',
            ...options.headers,
        },
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Airtable API error: ${response.status} - ${error}`);
    }

    return response.json();
}

async function createDoorRecords(doors, modelSource) {
    console.log(`\n📤 Uploading ${doors.length} doors to Airtable...\n`);

    let created = 0;
    let failed = 0;

    // Airtable allows batch creates of up to 10 records at a time
    const batchSize = 10;

    for (let i = 0; i < doors.length; i += batchSize) {
        const batch = doors.slice(i, i + batchSize);

        const records = batch.map(door => ({
            fields: {
                'Door ID': door.globalId,
                'Door Type': door.typeName || '',
                'Opening Direction': door.openingDirection || '',
                'Model Source': modelSource,
                'Created At': new Date().toISOString(),
            }
        }));

        try {
            await fetchWithAuth(`${AIRTABLE_API_BASE}/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`, {
                method: 'POST',
                body: JSON.stringify({
                    records,
                    typecast: true
                }),
            });

            created += batch.length;
            process.stdout.write(`\r  Progress: ${created}/${doors.length} doors created`);
        } catch (error) {
            console.error(`\n  ❌ Batch failed: ${error.message}`);
            failed += batch.length;
        }

        // Small delay to avoid rate limiting
        if (i + batchSize < doors.length) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    console.log(`\n\n✅ Created ${created} door records`);
    if (failed > 0) {
        console.log(`❌ Failed to create ${failed} records`);
    }

    return { created, failed };
}

async function extractDoorsFromIFC(filePath) {
    const ifcApi = new WebIFC.IfcAPI();

    // Initialize WASM
    await ifcApi.Init();

    console.log(`📂 Loading IFC file: ${filePath}`);
    const fileData = fs.readFileSync(filePath);

    // Load model
    const modelID = ifcApi.OpenModel(new Uint8Array(fileData));
    console.log(`✅ Model loaded\n`);

    // Get all IFCDOOR entities
    const doorLines = ifcApi.GetLineIDsWithType(modelID, WebIFC.IFCDOOR);
    console.log(`🚪 Found ${doorLines.size()} doors in the model`);

    // Build door-to-type mapping
    const relDefinesType = ifcApi.GetLineIDsWithType(modelID, WebIFC.IFCRELDEFINESBYTYPE);
    const doorToType = new Map();

    for (let i = 0; i < relDefinesType.size(); i++) {
        const relID = relDefinesType.get(i);
        const rel = ifcApi.GetLine(modelID, relID);
        if (!rel.RelatedObjects) continue;
        const relatedIds = Array.isArray(rel.RelatedObjects) ? rel.RelatedObjects : [rel.RelatedObjects];
        for (const related of relatedIds) {
            doorToType.set(related.value, rel.RelatingType.value);
        }
    }

    // Extract door information
    const doors = [];

    for (let i = 0; i < doorLines.size(); i++) {
        const expressID = doorLines.get(i);
        const door = ifcApi.GetLine(modelID, expressID);

        // Get GlobalId
        const globalId = door.GlobalId?.value || `EXPRESS_${expressID}`;

        // Get operation type from instance or type
        let openingDirection = door.OperationType?.value || null;
        let typeName = null;

        const typeID = doorToType.get(expressID);
        if (typeID) {
            const type = ifcApi.GetLine(modelID, typeID);
            typeName = type.Name?.value || null;
            if (!openingDirection && type.OperationType?.value) {
                openingDirection = type.OperationType.value;
            }
        }

        doors.push({
            expressID,
            globalId,
            typeName,
            openingDirection,
        });
    }

    ifcApi.CloseModel(modelID);

    return doors;
}

async function main() {
    console.log('🚀 IFC Door Import to Airtable\n');
    console.log('='.repeat(50) + '\n');

    // Get IFC file path from command line argument
    const filePath = process.argv[2];

    if (!filePath) {
        console.error('❌ Usage: node import-doors-to-airtable.js <path-to-ifc-file>');
        console.error('   Example: node import-doors-to-airtable.js ./model.ifc');
        process.exit(1);
    }

    if (!fs.existsSync(filePath)) {
        console.error(`❌ File not found: ${filePath}`);
        process.exit(1);
    }

    const modelSource = path.basename(filePath);

    try {
        // Extract doors from IFC
        const doors = await extractDoorsFromIFC(filePath);

        if (doors.length === 0) {
            console.log('❌ No doors found in the IFC file');
            process.exit(1);
        }

        // Show sample of doors
        console.log('\n📋 Sample doors:');
        doors.slice(0, 5).forEach((door, i) => {
            console.log(`  ${i + 1}. ${door.globalId} - Type: ${door.typeName || 'N/A'} - Direction: ${door.openingDirection || 'N/A'}`);
        });
        if (doors.length > 5) {
            console.log(`  ... and ${doors.length - 5} more\n`);
        }

        // Upload to Airtable
        const result = await createDoorRecords(doors, modelSource);

        console.log('\n' + '='.repeat(50));
        console.log('\n🎉 Import complete!');
        console.log(`   Base: ${AIRTABLE_BASE_ID}`);
        console.log(`   Table: ${AIRTABLE_TABLE_NAME}`);
        console.log(`   Doors imported: ${result.created}`);
        console.log('\nYou can now use the door app to send images to each door!\n');

    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

main();
