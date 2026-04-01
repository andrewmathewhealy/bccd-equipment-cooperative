# BCCD Equipment Cooperative

Web-based equipment rental tool for the Bennington County Conservation District.

## Quick Start

```bash
npm install
npm run dev
```

Open http://localhost:5173 to see the tool.

## Configuration

All configuration is in `src/EquipmentCooperative.jsx` at the top of the file. After your meeting, fill in these values:

### Google Form
```js
const GOOGLE_FORM_URL = ""; // Paste your form's action URL here
const GOOGLE_FORM_FIELDS = {
  name: "",        // e.g. "entry.123456789"
  email: "",       // Find these in the form's HTML source
  phone: "",       // or use a Google Forms URL builder tool
  // ... etc
};
```

### Google Calendar
```js
const GOOGLE_API_KEY = "";  // From Google Cloud Console
const GOOGLE_CALENDAR_IDS = {
  "no-till-drill": "",      // e.g. "abc123@group.calendar.google.com"
  "bcs-tractor": "",        // Found in Calendar Settings → Integrate calendar
};
```

### Storage Location
```js
const STORAGE_LOCATION = { lat: 42.8781, lng: -73.1968 };
// Update with actual equipment storage coordinates
```

### Pricing
```js
const NONRESIDENT_DAILY_RATE = 65;
const DELIVERY_FEE = 40;
const PICKUP_FEE = 40;
const COST_PER_MILE = 1;
```

## Deploy to Cloudflare Pages

1. Push this repo to GitHub (under a BCCD organization)
2. Go to dash.cloudflare.com → Pages → Create a project
3. Connect your GitHub repo
4. Build settings:
   - Build command: `npm run build`
   - Build output directory: `dist`
5. Deploy

## Embed on BCCD Website

Add this iframe to the Streamline equipment cooperative page:

```html
<iframe
  src="https://your-cloudflare-pages-url.pages.dev"
  width="100%"
  height="800"
  frameborder="0"
  style="border: none; min-height: 800px;"
></iframe>
```

## Files

- `src/EquipmentCooperative.jsx` — The entire tool (single component)
- `src/main.jsx` — Entry point
- `index.html` — HTML shell

## Maintenance

This is a static site — once deployed, it requires no server maintenance.
To update: edit the code, push to GitHub, Cloudflare auto-deploys.

### What your boss manages (no code needed):
- **Google Sheet** — Review requests, change Status to APPROVED/DENIED
- **Stripe Dashboard** — Create Payment Links for approved requests
- **Google Calendar** — Auto-updated by the Apps Script when requests are approved
