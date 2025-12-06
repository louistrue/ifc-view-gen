# IFC Viewer - Next.js Three.js Application

A Next.js application for loading and visualizing IFC (Industry Foundation Classes) files using Three.js and web-ifc.

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Setup WASM Files

The web-ifc library requires WASM files to be served from the public directory. You need to copy the WASM files from `node_modules/web-ifc` to `public/wasm/web-ifc/`.

#### Option 1: Manual Copy

After installing dependencies, copy the WASM files:

```bash
mkdir -p public/wasm/web-ifc
cp node_modules/web-ifc/wasm/* public/wasm/web-ifc/
```

#### Option 2: Use the Setup Script

Run the setup script:

```bash
npm run setup-wasm
```

This will automatically copy the WASM files to the correct location.

### 3. Run the Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Usage

1. Click the "Select IFC File" button
2. Choose an IFC file from your computer
3. The model will load and display in the 3D viewer
4. Use mouse controls:
   - **Click and drag**: Rotate the camera around the model
   - **Scroll wheel**: Zoom in/out

## Project Structure

```
door-view-creator/
├── app/
│   ├── layout.tsx       # Root layout
│   ├── page.tsx         # Home page
│   └── globals.css      # Global styles
├── components/
│   └── IFCViewer.tsx    # Main viewer component
├── lib/
│   └── ifc-loader.ts    # IFC loading utilities
├── public/
│   └── wasm/
│       └── web-ifc/     # WASM files (must be copied)
└── package.json
```

## Technologies

- **Next.js 14** - React framework
- **Three.js** - 3D graphics library
- **web-ifc** - IFC file parser
- **TypeScript** - Type safety

## Notes

- The WASM files must be in `public/wasm/web-ifc/` for the application to work
- Large IFC files may take some time to load
- The viewer automatically centers and scales models to fit the viewport


