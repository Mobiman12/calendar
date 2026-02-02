import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifySessionToken } from "@/lib/session";
import { getPrismaClient } from "@/lib/prisma";

const prisma = getPrismaClient();

export async function GET() {
  const cookieStore = await cookies();
  const token = cookieStore.get("calendar_session")?.value ?? null;
  const session = verifySessionToken(token);
  if (!session) return NextResponse.json(null);
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { email: true },
  });
  return NextResponse.json({
    userId: session.userId,
    tenantId: session.tenantId,
    role: session.role,
    email: user?.email ?? null,
  });
}
