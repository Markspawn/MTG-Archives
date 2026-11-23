import { NextRequest, NextResponse } from "next/server";

// Presence is only a routing hint; server auth validates the opaque credential.
const SESSION_COOKIE_NAMES = ["mtg_inventory_session"];
const PUBLIC_PREFIXES = ["/", "/login", "/public", "/u", "/api/public"];
const PROTECTED_PREFIXES = [
  "/admin",
  "/change-password",
  "/imports",
  "/inventory",
  "/locations",
  "/settings",
  "/trades",
  "/api/imports",
  "/api/inventory",
  "/api/admin",
  "/api/scryfall",
];

function hasSession(request: NextRequest) {
  return SESSION_COOKIE_NAMES.some((name) =>
    Boolean(request.cookies.get(name)),
  );
}

function pathStartsWith(pathname: string, prefixes: string[]) {
  return prefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const protectConsent = (response: NextResponse) => {
    if (pathname === "/settings/connections/authorize") {
      response.headers.set("X-Frame-Options", "DENY");
      response.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
      response.headers.set("Referrer-Policy", "no-referrer");
      response.headers.set("Cache-Control", "no-store");
    }
    return response;
  };

  if (pathStartsWith(pathname, PUBLIC_PREFIXES)) {
    return NextResponse.next();
  }

  if (pathStartsWith(pathname, PROTECTED_PREFIXES) && !hasSession(request)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401 },
      );
    }
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
    return protectConsent(NextResponse.redirect(loginUrl));
  }

  return protectConsent(NextResponse.next());
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
