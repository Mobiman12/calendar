import { EventEmitter } from "events";
import type Redis from "ioredis";

import { getRedisClient } from "@/lib/redis";

export type AppointmentSyncMessage = {
  locationId: string;
  timestamp: number;
  action?: string;
  appointmentId?: string;
  appointmentIds?: string[];
};

declare global {
  // eslint-disable-next-line no-var
  var __calendarAppointmentSyncEmitter: EventEmitter | undefined;
  // eslint-disable-next-line no-var
  var __calendarAppointmentSyncSubscriber: Redis | null | undefined;
  // eslint-disable-next-line no-var
  var __calendarAppointmentSyncSubscriberReady: boolean | undefined;
}

const CHANNEL_PREFIX = "appointments:sync";

function getEmitter() {
  if (!global.__calendarAppointmentSyncEmitter) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);
    global.__calendarAppointmentSyncEmitter = emitter;
  }
  return global.__calendarAppointmentSyncEmitter;
}

async function ensureRedisSubscriber() {
  if (global.__calendarAppointmentSyncSubscriberReady) {
    return;
  }
  const redis = getRedisClient();
  if (!redis) {
    return;
  }
  if (!global.__calendarAppointmentSyncSubscriber) {
    const subscriber = redis.duplicate();
    global.__calendarAppointmentSyncSubscriber = subscriber;
    subscriber.on("pmessage", (_pattern, _channel, message) => {
      try {
        const payload = JSON.parse(message) as AppointmentSyncMessage;
        if (!payload?.locationId) return;
        getEmitter().emit("sync", payload);
      } catch {
        // ignore malformed payloads
      }
    });
    subscriber.on("error", (error) => {
      console.warn("[appointments:sync] redis subscribe error", error);
    });
    await subscriber.connect();
  }
  const subscriber = global.__calendarAppointmentSyncSubscriber;
  if (!subscriber) return;
  await subscriber.psubscribe(`${CHANNEL_PREFIX}:*`);
  global.__calendarAppointmentSyncSubscriberReady = true;
}

export function subscribeAppointmentSync(
  locationId: string,
  handler: (message: AppointmentSyncMessage) => void,
): () => void {
  const emitter = getEmitter();
  const listener = (message: AppointmentSyncMessage) => {
    if (message.locationId !== locationId) return;
    handler(message);
  };
  emitter.on("sync", listener);
  void ensureRedisSubscriber();
  return () => {
    emitter.off("sync", listener);
  };
}

export async function publishAppointmentSync(message: AppointmentSyncMessage) {
  const payload = { ...message, timestamp: message.timestamp || Date.now() };
  getEmitter().emit("sync", payload);

  const redis = getRedisClient();
  if (!redis) {
    return;
  }
  try {
    if (!redis.status || redis.status === "end") {
      await redis.connect();
    }
    await redis.publish(`${CHANNEL_PREFIX}:${payload.locationId}`, JSON.stringify(payload));
  } catch (error) {
    console.warn("[appointments:sync] redis publish failed", error);
  }
}
