"use server";

import { redirect } from "next/navigation";
import { randomUUID } from "crypto";

import { getPrismaClient } from "@/lib/prisma";
import { getRedisClient } from "@/lib/redis";
import { hashPassword, isPasswordStrong } from "@/lib/password";
import { sendMail } from "@/lib/notifications/smtp";

const prisma = getPrismaClient();

const TOKEN_TTL_SECONDS = 60 * 60; // 1 Stunde

async function createResetToken(userId: string) {
  const redis = getRedisClient();
  if (!redis) {
    throw new Error("Passwort-Reset nicht verfügbar (kein Redis konfiguriert).");
  }
  const token = randomUUID();
  await redis.set(`pwd-reset:${token}`, userId, "EX", TOKEN_TTL_SECONDS);
  return token;
}

async function consumeResetToken(token: string): Promise<string | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  const key = `pwd-reset:${token}`;
  const userId = await redis.get(key);
  if (!userId) return null;
  await redis.del(key);
  return userId;
}

export async function requestResetAction(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email) return { ok: false, message: "E-Mail erforderlich." };

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
  if (!user) {
    // absichtlich kein Fehler, um enum darauf hinzuweisen
    return { ok: true, message: "Falls die E-Mail existiert, wurde ein Reset-Link gesendet." };
  }

  try {
    const token = await createResetToken(user.id);
    const baseUrl = process.env.APP_BASE_URL?.replace(/\/+$/, "") || "http://localhost:3002";
    const resetLink = `${baseUrl}/auth/reset/${token}`;
    await sendMail({
      to: email,
      subject: "Passwort zurücksetzen",
      text: `Hallo,\n\nbitte klicke auf den folgenden Link, um dein Passwort zurückzusetzen:\n${resetLink}\n\nDer Link ist 1 Stunde gültig.\n`,
      html: `<p>Hallo,</p><p>bitte klicke auf den folgenden Link, um dein Passwort zurückzusetzen:</p><p><a href="${resetLink}">${resetLink}</a></p><p>Der Link ist 1 Stunde gültig.</p>`,
    });
  } catch (error) {
    console.error("[pwd-reset] Token konnte nicht erstellt werden", error);
    return { ok: false, message: "Passwort-Reset aktuell nicht möglich." };
  }

  return { ok: true, message: "Falls die E-Mail existiert, wurde ein Reset-Link gesendet." };
}

export async function confirmResetAction(formData: FormData) {
  const token = String(formData.get("token") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!token || !password) {
    return { ok: false, message: "Token und neues Passwort sind erforderlich." };
  }
  if (!isPasswordStrong(password)) {
    return { ok: false, message: "Passwort muss mind. 8 Zeichen mit Buchstaben, Zahlen und Sonderzeichen enthalten." };
  }

  const userId = await consumeResetToken(token);
  if (!userId) {
    return { ok: false, message: "Reset-Link ist ungültig oder abgelaufen." };
  }

  await prisma.user.update({
    where: { id: userId },
    data: { hashedPassword: hashPassword(password) },
  });

  redirect("/auth/login");
}
