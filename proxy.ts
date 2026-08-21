import { NextRequest, NextResponse } from "next/server";
import { ADMIN_COOKIE, CLIENT_COOKIE, verifySessionToken } from "@/lib/session";

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith("/admin")) {
    if (pathname === "/admin/login") return NextResponse.next();

    const session = await verifySessionToken(req.cookies.get(ADMIN_COOKIE)?.value);
    if (!session || session.role !== "admin") {
      return NextResponse.redirect(new URL("/admin/login", req.url));
    }
    return NextResponse.next();
  }

  if (pathname === "/" || pathname === "/parametres") {
    const session = await verifySessionToken(req.cookies.get(CLIENT_COOKIE)?.value);
    if (!session || session.role !== "client") {
      return NextResponse.redirect(new URL("/login", req.url));
    }
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/parametres", "/admin/:path*"],
};
