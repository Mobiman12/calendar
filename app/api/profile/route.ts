import { NextResponse } from "next/server";

import { getPrismaClient } from "@/lib/prisma";
import { clearSessionCookie, verifySessionToken } from "@/lib/session";
import { hashPassword, isPasswordStrong, verifyPassword } from "@/lib/password";

const prisma = getPrismaClient();

export async function GET(request: Request) {
  const token = request.headers.get("cookie")?.split(";").find((c) => c.trim().startsWith("calendar_session="));
  const value = token?.split("=")[1] ?? null;
  const session = verifySessionToken(value);
  if (!session) return NextResponse.json(null, { status: 401 });
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true, role: true },
  });
  return NextResponse.json(user);
}

export async function PUT(request: Request) {
  const token = request.headers.get("cookie")?.split(";").find((c) => c.trim().startsWith("calendar_session="));
  const value = token?.split("=")[1] ?? null;
  const session = verifySessionToken(value);
  if (!session) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const newEmail = typeof body.email === "string" ? body.email.trim().toLowerCase() : undefined;
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : undefined;
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : undefined;

  const updates: Record<string, unknown> = {};

  // E-Mail ändern
  if (newEmail) {
    const exists = await prisma.user.findUnique({ where: { email: newEmail } });
    if (exists && exists.id !== session.userId) {
      return NextResponse.json({ error: "E-Mail bereits vergeben." }, { status: 400 });
    }
    updates.email = newEmail;
  }

  // Passwort ändern (optional, aber nur mit aktuellem Passwort)
  if (newPassword) {
    if (!currentPassword) {
      return NextResponse.json({ error: "Aktuelles Passwort erforderlich." }, { status: 400 });
    }
    if (!isPasswordStrong(newPassword)) {
      return NextResponse.json(
        { error: "Passwort muss mind. 8 Zeichen mit Buchstaben, Zahlen und Sonderzeichen enthalten." },
        { status: 400 },
      );
    }
    const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { hashedPassword: true } });
    if (!user || !verifyPassword(currentPassword, user.hashedPassword ?? null)) {
      return NextResponse.json({ error: "Aktuelles Passwort ist falsch." }, { status: 400 });
    }
    updates.hashedPassword = hashPassword(newPassword);
  }

  if (!Object.keys(updates).length) {
    return NextResponse.json({ ok: true });
  }

  await prisma.user.update({ where: { id: session.userId }, data: updates });

  // Session invalidieren, wenn Passwort geändert wurde
  if (updates.hashedPassword) {
    await clearSessionCookie();
    return NextResponse.json({ ok: true, sessionInvalidated: true });
  }

  return NextResponse.json({ ok: true });
}
