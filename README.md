# ClipboardLan - Local Network Clipboard Sharing

ClipboardLan is a browser extension that enables seamless clipboard sharing between multiple devices (Linux, Windows, macOS) on the same local network.

## Features

- Cross-platform clipboard synchronization (Linux, Windows, macOS)
- Real-time updates across all connected devices
- Secure local network communication
- Simple and intuitive interface
- Preserves formatting of copied content
## Requirements


## Installation
### 1. Server Setup (Linux)

1. Copy the project folder to your Linux machine
2. Start the server:
   ```bash
   python server/http_server.py
   ```
   The server will start on `0.0.0.0:24900` by default.

### 2. Browser Extension Installation

1. Open Chrome/Brave and go to `chrome://extensions/`
2. Enable "Developer mode" in the top right corner
3. Click "Load unpacked"
4. Select the `extension` folder from the project

## Usage

1. Install the extension on each device
2. On client devices, click the extension icon
3. Enter the server's IP address (the machine running `http_server.py`)
4. Click "Connect"

## Troubleshooting

- **Firewall Configuration**:
  - On the server machine, allow incoming TCP connections on port 24900

- **Network**:
  - Ensure all devices are on the same local network

- **Logs**:
  - Check server logs for connection attempts
  - Check browser's developer console (F12 > Console) for WebSocket errors

## How It Works

1. Copy text on any device (Ctrl+C)
2. The text will automatically appear in the extension on other connected devices
3. Click the "Copy" button to copy the text to your clipboard

> **Note:** Currently, only text content is supported (no images or files)

## Project Structure

```
clipboardlan/
├── extension/             # Browser extension files
│   ├── icons/             # Extension icons
│   │   ├── icon48.png     # 48x48 icon
│   │   └── icon128.png    # 128x128 icon
│   ├── popup/             # Popup interface
│   │   ├── popup.html     # Popup HTML
│   │   └── popup.js       # Popup JavaScript
│   ├── background.js      # Background service worker
│   ├── content.js         # Content script for clipboard detection
│   └── manifest.json      # Extension manifest
└── server/                # Server files
    └── http_server.py     # Python WebSocket server
```

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## To do list features for next release
- Extension must retrieve Items even if popup of extension is closed (in background mode)
- Sync Items from server with local clipboard on machines running the extension (with toggle sync button)
- Copy files (images, etc ...)

## Last done feature(s)
- ON / OFF badge for status indicator on extension icon
