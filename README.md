# AffiliFind

Shows affiliate discounts on product pages and suggests similar products with deals.

## Install on Chrome

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top right)
4. Click "Load unpacked"
5. Select the `extension` folder from this project

## Usage

Once installed, the extension automatically:
- Detects product pages you visit
- Shows available affiliate deals and discounts
- Suggests similar products with better prices

Click the extension icon in your toolbar to view all available deals.

## Development

Run the mock API server:
```bash
npm install
npm run dev:api
```

The API runs on `http://localhost:8787`
