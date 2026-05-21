import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Tailwind v4 uses the CSS-first config (`@import "tailwindcss"` in
// src/index.css) plus the Vite plugin — no tailwind.config.js or
// postcss.config.js required.
export default defineConfig({
  plugins: [react(), tailwindcss()],
});
