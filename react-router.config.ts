import type { Config } from "@react-router/dev/config";
import { vercelPreset } from "@vercel/react-router/vite";

// Vercel deployment preset: makes `react-router build` emit Vercel serverless
// output instead of a standalone Node server. SSR stays on.
export default {
  ssr: true,
  presets: [vercelPreset()],
} satisfies Config;
