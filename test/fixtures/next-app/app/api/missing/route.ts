export const dynamic = "force-dynamic";

// Always 404s with a JSON body — exercises the error debug injection.
export async function GET() {
  return Response.json({ error: "no such widget" }, { status: 404 });
}
