# IFC Element View Generator

A Next.js web application for loading, visualizing, and exporting professional technical drawings from IFC (Industry Foundation Classes) building models. Built with Three.js and web-ifc for high-performance BIM visualization.

## Features

### 3D Viewer
- **High-performance IFC loading** using [@thatopen/fragments](https://github.com/ThatOpen/engine_fragment) for optimized rendering
- **Camera controls** - Orbit, pan, zoom with smooth transitions
- **View presets** - Top, bottom, front, back, left, right, isometric (keyboard shortcuts 1-7)
- **Section planes** - Draw section cuts through the model
- **Zoom window** - Box selection for quick zoom (Z key)
- **Spatial hierarchy panel** - Navigate by building structure (Site > Building > Storey > Space)
- **Element filtering** - Filter by IFC class or product type

### Element Analysis
- **Automatic element detection** - Identifies doors, walls, electrical devices, and other IFC classes
- **Spatial context extraction** - Associates elements with their building storey
- **Host element detection** - Links doors to their host walls
- **Nearby device detection** - Finds electrical devices within proximity of elements

### SVG Export
- **Professional technical drawings** - Generate front, back, and plan views
- **High-quality geometry** - Uses detailed web-ifc geometry for accurate line work
- **Configurable rendering** - Adjust line weights, colors, margins, and labels
- **Batch export** - Process multiple elements and download as ZIP
- **Door swing arcs** - Automatic swing direction visualization based on IFC OperationType

### Integrations
- **Airtable** - Optional integration to sync element data and images to Airtable
- **Vercel Blob** - Cloud storage for exported images

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

```bash
# Clone the repository
git clone https://github.com/louistrue/door-view-creator.git
cd door-view-creator

# Install dependencies
npm install
```

The `postinstall` script automatically copies required WASM files and web workers.

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Production Build

```bash
npm run build
npm run start
```

## Usage

1. **Load IFC Model** - Click the upload area or drag and drop an IFC file
2. **Browse Elements** - Use the side panel to filter and select elements
3. **Generate Views** - Select elements and click to generate SVG views
4. **Export** - Download individual SVGs or batch export as ZIP

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| 1-7 | View presets (top, bottom, front, back, left, right, iso) |
| Z | Toggle zoom window mode |
| R | Reset view (clear sections, show all) |
| F | Flip section plane direction |
| Esc | Cancel current operation |

## Configuration

### Environment Variables

Create a `.env.local` file for local development:

```bash
# Airtable Integration (optional)
AIRTABLE_TOKEN=your_personal_access_token
AIRTABLE_BASE_ID=your_base_id
AIRTABLE_TABLE_NAME=Elements

# Vercel Blob Storage (optional, for image uploads)
BLOB_READ_WRITE_TOKEN=your_blob_token
```

### SVG Render Options

The SVG renderer supports these customization options:

| Option | Default | Description |
|--------|---------|-------------|
| width | 1000 | SVG width in pixels |
| height | 1000 | SVG height in pixels |
| margin | 0.5 | Margin around element (meters) |
| doorColor | #333333 | Primary element fill color |
| wallColor | #888888 | Secondary element fill color |
| deviceColor | #CC0000 | Device/equipment fill color |
| lineWidth | 1.5 | Stroke width for edges |
| lineColor | #000000 | Stroke color for edges |
| showFills | true | Render filled polygons |
| showLegend | true | Include legend in output |
| showLabels | true | Include labels/annotations |

## Project Structure

```
door-view-creator/
├── app/
│   ├── api/
│   │   └── airtable/       # Airtable API integration
│   ├── layout.tsx          # Root layout
│   ├── page.tsx            # Main page
│   └── globals.css         # Global styles
├── components/
│   ├── IFCViewer.tsx       # Main 3D viewer component
│   ├── DoorPanel.tsx       # Element selection and export panel
│   ├── ViewerToolbar.tsx   # Viewer controls
│   ├── ViewPresets.tsx     # Camera view presets
│   ├── SpatialHierarchyPanel.tsx  # Building hierarchy browser
│   ├── TypeFilterPanel.tsx # Filter by product type
│   └── IFCClassFilterPanel.tsx    # Filter by IFC class
├── lib/
│   ├── fragments-loader.ts # Optimized IFC loading with Fragments
│   ├── ifc-loader.ts       # Web-ifc direct loading (for detailed geometry)
│   ├── door-analyzer.ts    # Element analysis and context extraction
│   ├── svg-renderer.ts     # SVG generation from 3D geometry
│   ├── spatial-structure.ts # Building hierarchy extraction
│   ├── navigation-manager.ts # Camera controls
│   ├── element-visibility-manager.ts # Show/hide elements
│   └── section-plane.ts    # Section cut functionality
├── scripts/
│   ├── setup-airtable.js   # Airtable base setup helper
│   ├── import-doors-to-airtable.js # Batch import to Airtable
│   └── analyze-door-opening.js     # IFC analysis utility
└── public/
    ├── wasm/web-ifc/       # WASM files (copied by postinstall)
    └── fragments-worker/   # Web worker (copied by postinstall)
```

## Technology Stack

- **[Next.js 14](https://nextjs.org/)** - React framework with App Router
- **[Three.js](https://threejs.org/)** - 3D graphics library
- **[web-ifc](https://github.com/IFCjs/web-ifc)** - IFC file parser (WASM-based)
- **[@thatopen/fragments](https://github.com/ThatOpen/engine_fragment)** - High-performance BIM fragments
- **[camera-controls](https://github.com/yomotsu/camera-controls)** - Smooth camera interactions
- **TypeScript** - Type safety throughout

## Scripts

### Utility Scripts

```bash
# Analyze door operation types in an IFC file
node scripts/analyze-door-opening.js ./path/to/model.ifc

# Import doors to Airtable
node scripts/import-doors-to-airtable.js ./path/to/model.ifc
```

### Build Scripts

```bash
npm run dev          # Start development server
npm run build        # Production build
npm run start        # Start production server
npm run lint         # Run ESLint
npm run setup-wasm   # Copy WASM files to public/
npm run setup-fragments-worker  # Copy worker to public/
```

## Extending to Other IFC Classes

The architecture supports expansion to additional IFC element types. Key extension points:

1. **Element Detection** (`lib/door-analyzer.ts`)
   - Add type detection functions (e.g., `isWindowType()`, `isStairType()`)
   - Extend `analyzeDoors()` or create new analyzer functions

2. **Context Extraction**
   - Define context interfaces for new element types
   - Implement host element detection (e.g., windows in walls)

3. **SVG Rendering** (`lib/svg-renderer.ts`)
   - Add view-specific rendering functions
   - Customize camera setup for different element types
   - Add element-specific annotations (e.g., window schedules)

4. **UI Components**
   - Create element-specific panels similar to `DoorPanel.tsx`
   - Add filtering options for new element types

## Performance Notes

- **Fragments-based loading** is ~10x faster than direct web-ifc for large models
- **On-demand rendering** - Only renders when camera moves or changes occur
- **LOD (Level of Detail)** - Automatic detail reduction for distant objects
- **Frustum culling** - Only renders visible geometry

## Browser Support

- Chrome (recommended)
- Firefox
- Safari
- Edge

Requires WebGL 2.0 and WebAssembly support.

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is private. All rights reserved.

## Acknowledgments

- [IFC.js](https://ifcjs.github.io/info/) - The IFC.js ecosystem
- [That Open Company](https://github.com/ThatOpen) - Open BIM tools
- [Three.js](https://threejs.org/) - 3D library
