import { defineConfig, mask } from "@restlessai/sdk/next";

export default defineConfig({
  setup: (req) => ({
    apiKey: mask(req.headers.get("x-api-key")),
    owner: req.headers.get("x-workspace")
      ? {
          id: req.headers.get("x-workspace")!,
          enrich: (id) => ({ label: `Workspace ${id}` }),
        }
      : undefined,
  }),
});
