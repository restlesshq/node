import { NextRequest } from "next/server";

// Non-handler segment exports must survive the facade.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return Response.json({ ok: true, path: req.nextUrl.pathname });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  return Response.json({ echoed: body }, { status: 201 });
}
