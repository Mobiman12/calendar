import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

export function getPrismaClient(): PrismaClient {
  if (!global.prisma) {
    global.prisma = new PrismaClient();
  }
  return global.prisma;
}
