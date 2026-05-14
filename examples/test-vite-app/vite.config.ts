import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import lazyHandler from "lazy-handler-plugin/vite";

// The lazy-handler plugin must run BEFORE @vitejs/plugin-react so it sees
// raw JSX (our `enforce: 'pre'` already ensures this, but ordering by hand
// makes the intent obvious).
export default defineConfig({
  plugins: [
    lazyHandler({
      eventProps: [
        "onClick", "onSubmit", "onChange", "onKeyDown", "onKeyUp",
        "onBlur", "onFocus", "onMouseEnter", "onMouseLeave",
        "onPointerDown", "onDrop", "onDragStart",
      ],
      minHandlerLines: 3,
      belowFoldThreshold: 600,
      nuggetDir: "static/nuggets",
    }),
    react(),
  ],
});
