export const dynamic = "force-static";

// Prerendered at build time: the wrapper's NEXT_PHASE guard must pass
// through, so the cached static output carries no injected headers.
export async function GET() {
  return Response.json({ static: true });
}
