#!/usr/bin/env node

/**
 * Script to analyze and list doors from an IFC file with filtering options
 *
 * This script:
 * 1. Parses the IFC file to extract all doors
 * 2. Gets door GlobalId, type name, opening direction, and building storey
 * 3. Optionally filters doors by type, storey, or specific GUIDs
 * 4. Displays detailed information about the filtered doors
 *
 * Usage:
 *   node scripts/analyze-doors-filtered.js [ifc-file-path] [options]
 *
 * Options:
 *   --door-types <types>     Filter by door type names (comma-separated)
 *   --storeys <storeys>      Filter by building storeys (comma-separated)
 *   --guids <guids>          Filter by specific door GUIDs (comma-separated)
 *   --list-types             List all door types found in the model
 *   --list-storeys           List all building storeys found in the model
 *
 * Examples:
 *   # Analyze all doors
 *   node scripts/analyze-doors-filtered.js model.ifc
 *
 *   # List all door types and storeys
 *   node scripts/analyze-doors-filtered.js model.ifc --list-types --list-storeys
 *
 *   # Analyze only specific door types
 *   node scripts/analyze-doors-filtered.js model.ifc --door-types "T30,T60"
 *
 *   # Analyze doors from specific storeys
 *   node scripts/analyze-doors-filtered.js model.ifc --storeys "EG,OG1"
 *
 *   # Analyze specific doors by GUID
 *   node scripts/analyze-doors-filtered.js model.ifc --guids "2O2Fr$t4X7Zf8NOew3FLOH,1S8LodzGX8dRt2NjBjEZHe"
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const WebIFC = require('web-ifc');

/**
 * Parse command-line arguments
 */
function parseArguments() {
    const args = process.argv.slice(2)
    const options = {
        filePath: null,
        doorTypes: null,
        storeys: null,
        guids: null,
        listTypes: false,
        listStoreys: false,
    }

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]

        if (arg === '--door-types' && i + 1 < args.length) {
            options.doorTypes = args[++i]
        } else if (arg === '--storeys' && i + 1 < args.length) {
            options.storeys = args[++i]
        } else if (arg === '--guids' && i + 1 < args.length) {
            options.guids = args[++i]
        } else if (arg === '--list-types') {
            options.listTypes = true
        } else if (arg === '--list-storeys') {
            options.listStoreys = true
        } else if (!arg.startsWith('--')) {
            // Assume it's the file path
            options.filePath = arg
        }
    }

    return options
}

/**
 * Get the building storey name for a door
 */
function getDoorStorey(ifcApi, modelID, doorExpressID) {
    try {
        // Get all IFCRELCONTAINEDINSPATIALSTRUCTURE relationships
        const relLines = ifcApi.GetLineIDsWithType(modelID, WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE)

        for (let i = 0; i < relLines.size(); i++) {
            const relID = relLines.get(i)
            const rel = ifcApi.GetLine(modelID, relID)

            if (!rel.RelatedElements) continue

            const relatedIds = Array.isArray(rel.RelatedElements) ? rel.RelatedElements : [rel.RelatedElements]

            for (const related of relatedIds) {
                if (related.value === doorExpressID) {
                    // Found the spatial container relation
                    const containerID = rel.RelatingStructure.value
                    const container = ifcApi.GetLine(modelID, containerID)

                    // Check if this is a building storey
                    if (container.type === WebIFC.IFCBUILDINGSTOREY) {
                        return container.Name?.value || container.LongName?.value || `Storey_${containerID}`
                    }
                }
            }
        }

        return null
    } catch (e) {
        console.warn('Error getting door storey:', e)
        return null
    }
}

/**
 * Apply filters to doors
 */
function applyFilters(doors, filters) {
    if (!filters || (!filters.doorTypes && !filters.storeys && !filters.guids)) {
        return doors
    }

    let filtered = doors

    // Filter by door types
    if (filters.doorTypes) {
        const types = filters.doorTypes.split(',').map(t => t.trim())
        filtered = filtered.filter(door =>
            door.typeName && types.some(type =>
                door.typeName.toLowerCase().includes(type.toLowerCase())
            )
        )
    }

    // Filter by storeys
    if (filters.storeys) {
        const storeys = filters.storeys.split(',').map(s => s.trim())
        filtered = filtered.filter(door =>
            door.storeyName && storeys.some(storey =>
                door.storeyName.toLowerCase().includes(storey.toLowerCase())
            )
        )
    }

    // Filter by GUIDs
    if (filters.guids) {
        const guids = filters.guids.split(',').map(g => g.trim())
        filtered = filtered.filter(door =>
            guids.includes(door.globalId)
        )
    }

    return filtered
}

async function extractDoorsFromIFC(filePath, filters) {
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

        // Get building storey
        const storeyName = getDoorStorey(ifcApi, modelID, expressID)

        doors.push({
            expressID,
            globalId,
            typeName,
            openingDirection,
            storeyName,
        });
    }

    console.log(`\n📊 Door distribution by storey:`);
    const storeyCount = new Map();
    doors.forEach(door => {
        const storey = door.storeyName || 'Unknown';
        storeyCount.set(storey, (storeyCount.get(storey) || 0) + 1);
    });
    storeyCount.forEach((count, storey) => {
        console.log(`  ${storey}: ${count} doors`);
    });

    console.log(`\n📊 Door distribution by type:`);
    const typeCount = new Map();
    doors.forEach(door => {
        const type = door.typeName || 'Unknown';
        typeCount.set(type, (typeCount.get(type) || 0) + 1);
    });
    typeCount.forEach((count, type) => {
        console.log(`  ${type}: ${count} doors`);
    });

    // Apply filters
    const filteredDoors = applyFilters(doors, filters);

    if (filteredDoors.length < doors.length) {
        console.log(`\n🔍 Filtering applied: ${filteredDoors.length} of ${doors.length} doors selected`);
        if (filters.doorTypes) {
            console.log(`  Door types: ${filters.doorTypes}`);
        }
        if (filters.storeys) {
            console.log(`  Storeys: ${filters.storeys}`);
        }
        if (filters.guids) {
            console.log(`  GUIDs: ${filters.guids.split(',').length} specified`);
        }
    }

    ifcApi.CloseModel(modelID);

    return { allDoors: doors, filteredDoors };
}

async function main() {
    console.log('🔍 IFC Door Analysis Tool\n');
    console.log('='.repeat(50) + '\n');

    // Parse command-line arguments
    const options = parseArguments();
    let filePath = options.filePath;

    if (!filePath) {
        // Default to the IFC file in the project root
        filePath = path.join(__dirname, '../Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_251119.ifc');
    }

    if (!fs.existsSync(filePath)) {
        console.error(`❌ File not found: ${filePath}`);
        process.exit(1);
    }

    // Show filter options if any
    if (options.doorTypes || options.storeys || options.guids) {
        console.log('🔍 Filter options:');
        if (options.doorTypes) console.log(`  Door types: ${options.doorTypes}`);
        if (options.storeys) console.log(`  Storeys: ${options.storeys}`);
        if (options.guids) console.log(`  GUIDs: ${options.guids.split(',').length} specified`);
        console.log('');
    }

    try {
        // Extract doors from IFC with filters
        const { allDoors, filteredDoors } = await extractDoorsFromIFC(filePath, options);

        // List types and storeys if requested
        if (options.listTypes) {
            console.log('\n📋 All door types in model:');
            const types = new Set();
            allDoors.forEach(door => {
                if (door.typeName) types.add(door.typeName);
            });
            Array.from(types).sort().forEach(type => {
                console.log(`  - ${type}`);
            });
        }

        if (options.listStoreys) {
            console.log('\n📋 All building storeys in model:');
            const storeys = new Set();
            allDoors.forEach(door => {
                if (door.storeyName) storeys.add(door.storeyName);
            });
            Array.from(storeys).sort().forEach(storey => {
                console.log(`  - ${storey}`);
            });
        }

        // Show detailed door list
        if (filteredDoors.length === 0) {
            console.log('\n❌ No doors match the filter criteria');
            process.exit(1);
        }

        console.log(`\n📋 Filtered doors (${filteredDoors.length}):`);
        console.log('-'.repeat(100));
        console.log(
            'GUID'.padEnd(30) +
            'Type'.padEnd(25) +
            'Direction'.padEnd(25) +
            'Storey'.padEnd(20)
        );
        console.log('-'.repeat(100));

        filteredDoors.forEach((door, i) => {
            console.log(
                (door.globalId || 'N/A').padEnd(30) +
                (door.typeName || 'N/A').padEnd(25) +
                (door.openingDirection || 'N/A').padEnd(25) +
                (door.storeyName || 'N/A').padEnd(20)
            );
        });

        console.log('\n' + '='.repeat(50));
        console.log(`\n✅ Analysis complete!`);
        console.log(`   Total doors: ${allDoors.length}`);
        console.log(`   Filtered doors: ${filteredDoors.length}`);

        // Output GUIDs for easy copying
        if (filteredDoors.length > 0 && filteredDoors.length <= 20) {
            console.log('\n📋 Filtered door GUIDs (comma-separated):');
            console.log(filteredDoors.map(d => d.globalId).join(','));
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
