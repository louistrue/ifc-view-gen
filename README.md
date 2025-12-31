# IFC Door View Creator

A Next.js application for loading and analyzing IFC (Industry Foundation Classes) files, generating door view diagrams, and optionally uploading them to Airtable.

## Features

- 🏗️ Load and parse IFC files with web-ifc
- 🚪 Automatically detect and analyze doors
- 📐 Generate SVG diagrams (front view, back view, plan view)
- 📦 Batch export to ZIP files
- ☁️ Upload to Airtable via secure OAuth (session-based, no data persistence)

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

### 3. Configure Environment Variables

Copy the example environment file and configure it:

```bash
cp .env.example .env.local
```

Edit `.env.local` and set:

- **AIRTABLE_CLIENT_ID**: Your Airtable OAuth Client ID (required for Airtable integration)
- **AIRTABLE_CLIENT_SECRET**: Your Airtable OAuth Client Secret (optional, recommended for server-side apps)
- **SESSION_SECRET**: A random 32+ character string for encrypting session cookies
- **BLOB_READ_WRITE_TOKEN**: Vercel Blob storage token (optional, for uploading images)

#### Setting Up Airtable OAuth

1. Go to https://airtable.com/create/oauth
2. Create a new OAuth integration with:
   - **Name**: Türbilder (or your preferred name)
   - **Redirect URL**: `https://your-domain.vercel.app/api/auth/callback/airtable`
   - **Scopes**: `data.records:read` and `data.records:write`
3. Copy the Client ID (and optionally Client Secret) to your `.env.local`
4. Add Privacy Policy URL: `https://your-domain.vercel.app/privacy-policy`
5. Add Terms of Service URL: `https://your-domain.vercel.app/terms-of-service`

### 4. Run the Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Usage

### Loading IFC Files

1. Click the "Select IFC File" button
2. Choose an IFC file from your computer
3. The model will load and display in the 3D viewer
4. Doors are automatically detected and analyzed

### Generating Door Views

1. After loading an IFC file, scroll down to the **Door View Generator** section
2. Customize style options (colors, line width, fonts, etc.)
3. Choose between:
   - **Test Mode**: Process 10 random doors for quick preview
   - **All Mode**: Process all detected doors
4. Generate individual door views or batch export to ZIP

### Using Airtable Integration (Optional)

1. In the **Airtable Connection** section, click **Connect to Airtable**
2. Authorize the application to access your Airtable workspace
3. After authentication, enter your:
   - **Base ID**: Found in your Airtable base URL (e.g., `appXXXXXXXXXXXXXX`)
   - **Table Name**: Name of the table to upload to (default: "Doors")
4. Upload individual doors or batch upload all doors
5. Your session lasts 8 hours, then you'll need to reconnect

**Security Notes:**
- Your IFC files are processed entirely in your browser and never uploaded to our servers
- OAuth tokens are stored in encrypted session cookies for 8 hours maximum
- No credentials are persisted on our servers
- Click "Disconnect" to immediately clear your session

### 3D Viewer Controls

- **Click and drag**: Rotate the camera around the model
- **Scroll wheel**: Zoom in/out

## Project Structure

```
door-view-creator/
├── app/
│   ├── api/
│   │   ├── airtable/
│   │   │   └── route.ts              # Airtable API endpoints
│   │   └── auth/
│   │       ├── airtable/
│   │       │   └── authorize/
│   │       │       └── route.ts      # OAuth authorization
│   │       ├── callback/
│   │       │   └── airtable/
│   │       │       └── route.ts      # OAuth callback
│   │       └── logout/
│   │           └── route.ts          # Session logout
│   ├── privacy-policy/
│   │   └── page.tsx                  # Privacy Policy
│   ├── terms-of-service/
│   │   └── page.tsx                  # Terms of Service
│   ├── layout.tsx                    # Root layout
│   ├── page.tsx                      # Home page
│   └── globals.css                   # Global styles
├── components/
│   ├── IFCViewer.tsx                 # Main viewer component
│   └── BatchProcessor.tsx            # Door processing & Airtable upload
├── lib/
│   ├── door-analyzer.ts              # Door detection and analysis
│   ├── ifc-loader.ts                 # IFC loading utilities
│   ├── ifc-types.ts                  # TypeScript interfaces
│   ├── svg-renderer.ts               # SVG generation
│   └── session.ts                    # Session configuration
├── scripts/
│   ├── setup-airtable.js             # Create Airtable base (legacy)
│   └── import-doors-to-airtable.js   # Batch import (legacy)
├── public/
│   └── wasm/
│       └── web-ifc/                  # WASM files (must be copied)
├── .env.example                      # Environment variables template
└── package.json
```

## Technologies

- **Next.js 14** - React framework with App Router
- **Three.js** - 3D graphics library
- **web-ifc** - IFC file parser
- **TypeScript** - Type safety
- **iron-session** - Encrypted session cookies
- **Airtable API** - OAuth integration for data storage
- **Vercel Blob** - Image storage for SVG attachments

## Security & Privacy

This application is designed with security and privacy as top priorities:

### Client-Side IFC Processing
- All IFC file parsing happens locally in your browser using WebAssembly
- IFC files are **never uploaded** to our servers
- No IFC data leaves your device unless you explicitly choose to upload to Airtable

### OAuth Session Management
- Uses OAuth 2.0 for secure Airtable authentication
- Access tokens are stored in encrypted, HTTP-only cookies
- Sessions automatically expire after 8 hours
- No credentials are persisted on our servers
- Click "Disconnect" anytime to immediately clear your session

### Data You Control
- You choose which Base ID and Table Name to use
- You control which doors to upload
- You can revoke access from your Airtable account settings at any time

See our [Privacy Policy](/privacy-policy) and [Terms of Service](/terms-of-service) for more details.

## Notes

- The WASM files must be in `public/wasm/web-ifc/` for the application to work
- Large IFC files may take some time to load
- The viewer automatically centers and scales models to fit the viewport
- Airtable integration is optional - you can use the app without connecting


