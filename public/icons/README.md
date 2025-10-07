# PWA Icons

Place progressive web app icon images in this directory when ready.

Required files referenced by the manifest:

- 192×192 PNG for Android round icon
- 512×512 PNG for iOS square icon

Until branded artwork is available, the application serves inline transparent
placeholders so the PWA install flow still works. Replace the data URI entries
in `public/manifest.webmanifest` and the `<link rel="apple-touch-icon">` tags
once the production-ready assets are ready.
