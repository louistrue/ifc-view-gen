#!/usr/bin/env node

/**
 * Standalone script to set up Airtable for door image integration
 * 
 * This script creates an Airtable base/table structure for storing door images.
 * 
 * Usage:
 *   node scripts/setup-airtable.js
 * 
 * Required environment variable:
 *   AIRTABLE_TOKEN - Your Airtable Personal Access Token
 */

require('dotenv').config();

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;

if (!AIRTABLE_TOKEN) {
    console.error('❌ AIRTABLE_TOKEN environment variable is required');
    process.exit(1);
}

const AIRTABLE_API_BASE = 'https://api.airtable.com/v0';

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

async function listBases() {
    console.log('📋 Fetching available bases...\n');
    const data = await fetchWithAuth(`${AIRTABLE_API_BASE}/meta/bases`);
    return data.bases;
}

async function getBaseSchema(baseId) {
    const data = await fetchWithAuth(`${AIRTABLE_API_BASE}/meta/bases/${baseId}/tables`);
    return data.tables;
}

async function createTable(baseId, tableName) {
    console.log(`📝 Creating table "${tableName}"...`);

    const tableSchema = {
        name: tableName,
        description: 'Door images from IFC model analysis',
        fields: [
            {
                name: 'Door ID',
                type: 'singleLineText',
                description: 'Unique door identifier (GlobalId from IFC)',
            },
            {
                name: 'Door Type',
                type: 'singleLineText',
                description: 'Door type name from IFC model',
            },
            {
                name: 'Opening Direction',
                type: 'singleSelect',
                description: 'Door opening direction',
                options: {
                    choices: [
                        { name: 'SINGLE_SWING_LEFT' },
                        { name: 'SINGLE_SWING_RIGHT' },
                        { name: 'DOUBLE_SWING_LEFT' },
                        { name: 'DOUBLE_SWING_RIGHT' },
                        { name: 'SLIDING' },
                        { name: 'FOLDING' },
                        { name: 'REVOLVING' },
                        { name: 'OTHER' },
                    ],
                },
            },
            {
                name: 'Front View',
                type: 'multipleAttachments',
                description: 'Front view image of the door',
            },
            {
                name: 'Back View',
                type: 'multipleAttachments',
                description: 'Back view image of the door',
            },
            {
                name: 'Top View',
                type: 'multipleAttachments',
                description: 'Top/plan view of the door',
            },
            {
                name: 'Model Source',
                type: 'singleLineText',
                description: 'IFC model filename',
            },
            {
                name: 'Created At',
                type: 'dateTime',
                description: 'When the door record was created',
                options: {
                    timeZone: 'client',
                    dateFormat: { name: 'iso' },
                    timeFormat: { name: '24hour' },
                },
            },
        ],
    };

    const data = await fetchWithAuth(`${AIRTABLE_API_BASE}/meta/bases/${baseId}/tables`, {
        method: 'POST',
        body: JSON.stringify(tableSchema),
    });

    console.log(`✅ Table "${tableName}" created successfully!`);
    return data;
}

async function createDoorRecord(baseId, tableId, door) {
    const fields = {
        'Door ID': door.doorId,
        'Created At': new Date().toISOString(),
    };

    if (door.doorType) fields['Door Type'] = door.doorType;
    if (door.openingDirection) fields['Opening Direction'] = door.openingDirection;
    if (door.modelSource) fields['Model Source'] = door.modelSource;

    const data = await fetchWithAuth(`${AIRTABLE_API_BASE}/${baseId}/${tableId}`, {
        method: 'POST',
        body: JSON.stringify({ fields }),
    });

    return data.id;
}

async function main() {
    console.log('🚀 Airtable Setup Script for Door Images\n');
    console.log('='.repeat(50) + '\n');

    try {
        // List available bases
        const bases = await listBases();

        if (bases.length === 0) {
            console.log('❌ No bases found. Please create a base in Airtable first.');
            console.log('   Go to https://airtable.com and create a new base.');
            process.exit(1);
        }

        console.log('Available bases:');
        bases.forEach((base, i) => {
            console.log(`  ${i + 1}. ${base.name} (${base.id})`);
        });
        console.log('\n');

        // Use first base or let user specify
        const targetBase = bases[0];
        console.log(`📦 Using base: "${targetBase.name}" (${targetBase.id})\n`);

        // Check existing tables
        const tables = await getBaseSchema(targetBase.id);
        console.log('Existing tables:');
        tables.forEach(table => {
            console.log(`  - ${table.name} (${table.id})`);
        });
        console.log('\n');

        // Check if Doors table exists
        let doorsTable = tables.find(t => t.name === 'Doors');

        if (doorsTable) {
            console.log('✅ "Doors" table already exists!');
            console.log('\nTable fields:');
            doorsTable.fields.forEach(field => {
                console.log(`  - ${field.name} (${field.type})`);
            });
        } else {
            // Create the Doors table
            doorsTable = await createTable(targetBase.id, 'Doors');
            console.log('\nTable fields:');
            doorsTable.fields.forEach(field => {
                console.log(`  - ${field.name} (${field.type})`);
            });
        }

        // Print configuration for the app
        console.log('\n' + '='.repeat(50));
        console.log('\n📋 Configuration for your app:\n');
        console.log(`AIRTABLE_BASE_ID=${targetBase.id}`);
        console.log(`AIRTABLE_TABLE_NAME=Doors`);
        console.log('\nAdd these to your .env file!');

        // Create a sample door record
        console.log('\n' + '='.repeat(50));
        console.log('\n🧪 Creating a sample door record...\n');

        const sampleRecordId = await createDoorRecord(
            targetBase.id,
            doorsTable.id || 'Doors',
            {
                doorId: 'SAMPLE-DOOR-001',
                doorType: 'Single Swing Door',
                openingDirection: 'SINGLE_SWING_LEFT',
                modelSource: 'test-model.ifc',
            }
        );

        console.log(`✅ Sample record created: ${sampleRecordId}`);
        console.log('\n🎉 Setup complete! Your Airtable is ready for door images.\n');

    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

main();
