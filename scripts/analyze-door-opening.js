const fs = require('fs');
const path = require('path');
const WebIFC = require('web-ifc');

async function analyzeDoors() {
    const ifcApi = new WebIFC.IfcAPI();

    // Initialize WASM
    await ifcApi.Init();

    const filePath = path.join(__dirname, '../Flu21_A_AR_51_ARM_0000_A-AR-0000-0001_251119.ifc');

    if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        return;
    }

    console.log(`Loading IFC file: ${filePath}`);
    const fileData = fs.readFileSync(filePath);

    // Load model
    const modelID = ifcApi.OpenModel(new Uint8Array(fileData));
    console.log(`Model loaded with ID: ${modelID}`);

    // Get all IFCDOOR entities
    const doorLines = ifcApi.GetLineIDsWithType(modelID, WebIFC.IFCDOOR);
    console.log(`Found ${doorLines.size()} doors`);

    // Helper to find type
    console.log('\nSearching for Door Types...');
    const relDefinesType = ifcApi.GetLineIDsWithType(modelID, WebIFC.IFCRELDEFINESBYTYPE);

    // Map door ID to Type ID
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

    // Helper to find properties (pre-fetch all RelDefinesByProperties for efficiency in the loop)
    const relDefinesProps = ifcApi.GetLineIDsWithType(modelID, WebIFC.IFCRELDEFINESBYPROPERTIES);

    // Analyze first 5 doors
    // Aggregate OperationTypes
    const opTypesInstance = new Map();
    const opTypesType = new Map();

    for (let i = 0; i < doorLines.size(); i++) {
        const expressID = doorLines.get(i);
        const door = ifcApi.GetLine(modelID, expressID);

        const opInstance = door.OperationType ? door.OperationType.value : 'N/A';
        opTypesInstance.set(opInstance, (opTypesInstance.get(opInstance) || 0) + 1);

        const typeID = doorToType.get(expressID);
        if (typeID) {
            const type = ifcApi.GetLine(modelID, typeID);
            const opType = type.OperationType ? type.OperationType.value : 'N/A';
            opTypesType.set(opType, (opTypesType.get(opType) || 0) + 1);
        } else {
            opTypesType.set('No Type', (opTypesType.get('No Type') || 0) + 1);
        }
    }

    console.log('\n=== OperationType Summary ===');
    console.log('Instance Level:');
    opTypesInstance.forEach((count, op) => console.log(`  ${op}: ${count}`));

    console.log('Type Level:');
    opTypesType.forEach((count, op) => console.log(`  ${op}: ${count}`));

    ifcApi.CloseModel(modelID);
}

analyzeDoors().catch(console.error);
