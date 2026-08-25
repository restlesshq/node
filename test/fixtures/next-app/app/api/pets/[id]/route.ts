import { NextRequest } from "next/server";

// A parameterized route, which is what the recovered route pattern exists
// for: the SDK has to see `/api/pets/{id}` rather than the concrete path, or
// the 404 below groups as an unknown endpoint instead of a missing resource.
export const dynamic = "force-dynamic";

const PETS: Record<string, string> = { "1": "fluffy" };

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const name = PETS[id];
  if (!name) {
    return Response.json({ error: "no such pet" }, { status: 404 });
  }
  return Response.json({ id, name });
}
