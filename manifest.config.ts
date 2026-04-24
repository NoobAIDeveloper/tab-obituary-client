import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'Tab Obituary',
  short_name: 'Tab Obituary',
  description: 'A chronicle of your curiosity. A weekly story about your browsing.',
  version: '0.0.1',
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'Tab Obituary',
  },
  options_page: 'src/options/index.html',
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  permissions: ['tabs', 'history', 'idle', 'storage', 'alarms'],
  host_permissions: ['<all_urls>'],
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/input-beacon.ts'],
      run_at: 'document_start',
      all_frames: false,
    },
  ],
});
