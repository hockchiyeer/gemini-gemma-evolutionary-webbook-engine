import http from "node:http";
import express from "express";
import path from "node:path";
import { createApiCompatibilityMiddleware } from "./googleSearchFallback.ts";
import { createGeminiMiddleware, setupGeminiLiveWebSocket } from "./geminiService.ts";

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const PORT = Number(process.env.PORT) || 3000;

  // API routes FIRST
  app.use(createGeminiMiddleware() as any);
  app.use(createApiCompatibilityMiddleware() as any);
  setupGeminiLiveWebSocket(server);

  app.post("/__pdf", express.json({ limit: "50mb" }), async (req, res) => {
    try {
      const { html, fileName } = req.body;
      
      // Lazy load generatePdf to avoid top-level puppeteer import
      const { generatePdf } = await import("./pdfBridge.ts");
      
      const pdfBuffer = await generatePdf(html);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileName || "webbook"}.pdf"`
      );
      res.send(pdfBuffer);
    } catch (err) {
      console.error(err);
      res.status(500).send("PDF generation failed");
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
