export const runtime = "edge";

// Edge routes are skipped by the loader in v1 — the build must still
// succeed and the route must serve, just uncaptured.
export async function GET() {
  return Response.json({ edge: true });
}
