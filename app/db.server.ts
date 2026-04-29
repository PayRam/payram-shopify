import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient;

declare global {
  // Allows reuse across hot-reloads in dev without exhausting connections.
  // eslint-disable-next-line no-var
  var __db__: PrismaClient | undefined;
}

if (process.env.NODE_ENV === "production") {
  prisma = new PrismaClient();
} else {
  if (!global.__db__) {
    global.__db__ = new PrismaClient();
  }
  prisma = global.__db__;
  prisma.$connect();
}

export default prisma;
