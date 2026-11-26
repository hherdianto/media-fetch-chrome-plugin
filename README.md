# Social Media Data Extractor (Chrome Extension)

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Version](https://img.shields.io/badge/version-1.4.1-green.svg)](manifest.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A powerful, privacy-first Google Chrome extension (Manifest V3) designed to extract posts, videos, reels, tweets, comments/replies, and engagement metrics directly from **Instagram**, **TikTok**, **Threads**, and **X (formerly Twitter)**.

Data is stored locally in your browser and categorized by platform into separate datasets (`ig.json`, `tiktok.json`, `threads.json`, and `x.json`).

---

## 🌟 Key Features

- **Multi-Platform Support**:
  - 📸 **Instagram**: Single image/video posts, carousels, and Reels with full captions, author info, timestamps, like counts, and comments.
  - 🎵 **TikTok**: Video posts, captions, sound metadata, view/like/comment/share counts, and top comments.
  - 🧵 **Threads**: Thread posts, replies, author profiles, and engagement statistics.
  - 𝕏 **X (Twitter)**: Tweets, replies, quotes, view counts, likes, retweets, bookmarks, and thread context.
- **Instant Extraction**:
  - Trigger with the universal shortcut: `Alt + Shift + S` (macOS: `Option + Shift + S` or customizable).
  - Or click the **Scrape Current Page** button inside the popup dashboard.
- **Smart Metric Normalization**:
  - Automatically parses international and regional number formats (e.g., `14.2K`, `1.5M`, `2B`, as well as Indonesian format `14,2 rb`, `1,5 jt`, `2 miliar`) into precise integers.
- **Isolated Platform Storage & Auto-Export**:
  - Manages data per platform so datasets stay clean and organized.
  - Automatically exports or manually downloads to `ig.json`, `tiktok.json`, `threads.json`, and `x.json`.
- **Deduplication & Concurrency Safe**:
  - Automatically deduplicates records based on unique post/media IDs.
  - Uses a sequential Promise queue to eliminate race conditions when writing to storage.
- **Data Management Hub (Popup UI)**:
  - Platform tabs to switch views seamlessly.
  - Copy all platform data as JSON directly to your clipboard.
  - Download individual JSON files on demand.
  - Import & merge external JSON files back into your collection.
  - Search, inspect, delete individual entries, or clear all data.
- **Non-Intrusive Visual Feedback**:
  - Modern in-page toast notifications showing extraction status, metrics count, and warning/error details without breaking page layout.

---

## 📥 Installation

1. **Clone or Download this repository**:
   ```bash
   git clone https://github.com/<your-username>/media-fetch-chrome-plugin.git
   ```
2. Open Google Chrome (or any Chromium-based browser like Brave, Edge, or Arc).
3. Navigate to `chrome://extensions/`.
4. Enable **Developer mode** via the toggle in the top-right corner.
5. Click **Load unpacked** in the top-left corner.
6. Select the folder containing `manifest.json` (`media-fetch-chrome-plugin`).
7. The extension icon will appear in your Chrome toolbar. Pin it for quick access!

---

## 🚀 How to Use

### 1. Extracting Content
1. Navigate to any supported post URL:
   - Instagram: `https://www.instagram.com/p/...` or `/reel/...`
   - TikTok: `https://www.tiktok.com/@user/video/...`
   - Threads: `https://www.threads.net/@user/post/...`
   - X: `https://x.com/user/status/...`
2. Press `Alt + Shift + S` (default shortcut) or click the extension icon and select **Scrape Current Page**.
3. A toast notification will pop up in the corner of your screen indicating whether the extraction was successful.

### 2. Managing & Exporting Data
- Click the extension icon in your browser toolbar to open the popup dashboard.
- Select the active platform tab (IG, TikTok, Threads, or X).
- **Download JSON**: Saves the current platform dataset (`ig.json`, `tiktok.json`, etc.) to your `Downloads` folder.
- **Copy JSON**: Copies the entire formatted JSON payload to your clipboard for quick paste into scripts or LLMs.
- **Import / Merge**: Upload an existing JSON export to merge it with your local storage without duplicate records.
- **Clear All**: Resets local storage for the selected platform.

### 3. Customizing Shortcuts
To change the default keyboard shortcut:
1. Open Chrome and go to `chrome://extensions/shortcuts`.
2. Locate **Social Media Data Extractor**.
3. Assign your preferred key combination for **Extract active Instagram, TikTok, Threads, or X post**.

---

## 📊 Sample Output Schema

Each item saved contains rich metadata structured for downstream processing:

```json
{
  "id": "184649201948201",
  "shortcode": "CxYz12345",
  "platform": "instagram",
  "url": "https://www.instagram.com/p/CxYz12345/",
  "author": {
    "username": "creator",
    "name": "Creator Name",
    "profileUrl": "https://www.instagram.com/creator/"
  },
  "caption": "Exploring data extraction with Chrome Extension #dev #automation",
  "timestamp": "2026-11-26T07:15:00.000Z",
  "stats": {
    "likes": 14250,
    "comments": 380,
    "views": 95000,
    "shares": 120
  },
  "media": [
    {
      "type": "image",
      "url": "https://..."
    }
  ],
  "comments": [
    {
      "id": "c1",
      "username": "commenter",
      "text": "Great tool!",
      "timestamp": "2026-11-26T07:30:00.000Z",
      "likes": 12
    }
  ],
  "extractedAt": "2026-11-26T07:16:00.000Z"
}
```

---

## 🔒 Permissions Justification

| Permission | Purpose |
| :--- | :--- |
| `storage` & `unlimitedStorage` | Store extracted social media posts locally in the browser without capacity limitations. |
| `downloads` | Save exported JSON files (`ig.json`, `tiktok.json`, etc.) directly to your device. |
| `activeTab` & `scripting` | Detect the current active social media URL and trigger content extraction scripts. |
| `host_permissions` | Required to communicate with DOM elements on Instagram, TikTok, Threads, and X/Twitter. |

> **Privacy Note**: All data extraction, parsing, and storage runs 100% locally on your machine. No data is ever sent to external servers or telemetry endpoints.

---

## 📁 Repository Structure

```text
media-fetch-chrome-plugin/
├── background.js          # Service worker managing downloads & storage queue
├── content.js             # Content script & DOM extractor for Instagram
├── content.css            # Styles for in-page toast alerts
├── tiktok-content.js      # Content script & DOM extractor for TikTok
├── threads-content.js     # Content script & DOM extractor for Threads
├── x-content.js           # Content script & DOM extractor for X / Twitter
├── manifest.json          # Chrome Extension Manifest V3 configuration
├── LICENSE                # MIT License
├── README.md              # Documentation
├── icons/                 # Extension toolbar & browser icons
└── popup/
    ├── popup.html         # Extension popup interface
    ├── popup.css          # Styling for popup dashboard & platform tabs
    └── popup.js           # UI logic, import/export, and collection viewer
```

---

## 📄 License

This project is open-source and licensed under the [MIT License](LICENSE). Feel free to use, modify, and distribute it as needed.
