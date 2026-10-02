import { defineConfig, type Plugin } from "vite";

/**
 * PPTB loads tools in an iframe from file:// URLs. ES modules and crossorigin
 * attributes break there, so emit a single IIFE bundle and move the script tag
 * to the end of <body>. Same approach as PowerPlatformToolBox/sample-tools.
 */
function fixHtmlForPPTB(): Plugin {
  return {
    name: "fix-html-for-pptb",
    enforce: "post",
    transformIndexHtml(html) {
      html = html.replace(/\s*type="module"/g, "").replace(/\s*crossorigin/g, "").replace(/\s+>/g, ">");
      const scripts: string[] = [];
      html = html.replace(/(<script[^>]*src="[^"]*"[^>]*><\/script>)/g, (m) => {
        scripts.push(m);
        return "";
      });
      if (scripts.length) html = html.replace("</body>", "\n  " + scripts.join("\n  ") + "\n</body>");
      return html;
    },
  };
}

export default defineConfig(({ mode }) => ({
  root: "src",
  base: "./",
  publicDir: "../public",
  plugins: [fixHtmlForPPTB()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    assetsDir: "assets",
    cssCodeSplit: false,
    sourcemap: mode === "development",
    rollupOptions: {
      output: { format: "iife", inlineDynamicImports: true, manualChunks: undefined },
    },
  },
}));
