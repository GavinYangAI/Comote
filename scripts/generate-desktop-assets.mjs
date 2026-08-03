import { join } from "node:path";

import { generateDesktopIcons } from "./desktop-icon-assets.mjs";

const iconsDir = join(process.cwd(), "src-tauri", "icons");
await generateDesktopIcons(iconsDir);

console.log(`Generated desktop assets in ${iconsDir}`);
