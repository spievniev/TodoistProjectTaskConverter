import { Redis } from "@upstash/redis";
import { waitUntil } from "@vercel/functions";

const LOG_EXPIRATION_SECONDS = 30 * 24 * 60 * 60; // 30d

const isVercel = !!process.env.VERCEL;

const getRedis = (() => {
    let redis: Redis | null = null;
    return () => {
        if (redis === null) redis = Redis.fromEnv();
        return redis;
    };
})();

// Persist log because Vercel's free tier provides only 1h.
// Redis is chosen for simplicity and due to Upstash integration.
export const log = (message: string) => {
    console.log(message);
    if (!isVercel) return;

    const redis = getRedis();
    const key = `logs:${new Date().toISOString().slice(0, 10)}`;

    waitUntil(
        (async () => {
            await redis.rpush(key, message);
            // Set expiry if it is the first entry
            await redis.expire(key, LOG_EXPIRATION_SECONDS, "NX");
        })()
    );
};
