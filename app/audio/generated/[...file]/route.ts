import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

const ROOT = path.join(process.cwd(), "audio-cache");

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ file: string[] }> }
) {
  const { file } = await params;
  const filePath = path.join(ROOT, ...file);
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath)) {
    return new NextResponse("Not found", { status: 404 });
  }
  const data = fs.readFileSync(filePath);
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
