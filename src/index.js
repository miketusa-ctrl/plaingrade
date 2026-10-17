import { createApp } from './app.js';
// 1200x630 social preview image, bundled as an ArrayBuffer via the [[rules]] Data entry in wrangler.toml.
import ogPng from '../assets/og-image.png';

export default createApp({ ogPng });
