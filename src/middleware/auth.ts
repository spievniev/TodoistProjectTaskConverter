import { createHmac } from "crypto";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

const VERIFICATION_TOKEN = process.env.VERIFICATION_TOKEN;
if (!VERIFICATION_TOKEN) {
    console.error('Environment variable "VERIFICATION_TOKEN" is not set!');
    process.exit(1);
}

export type AuthEnv = {
    Variables: {
        token: string;
    };
};

const auth = createMiddleware<AuthEnv>(async (c, next) => {
    const requestHash = c.req.header("x-todoist-hmac-sha256");
    if (!requestHash) throw new HTTPException(401, { message: "Unauthorized" });

    const hash = createHmac("sha256", VERIFICATION_TOKEN)
        .update(await c.req.text())
        .digest("base64");
    if (hash !== requestHash) throw new HTTPException(401, { message: "Unauthorized" });

    const token = c.req.header("x-todoist-apptoken");
    if (!token) throw new HTTPException(400, { message: "Bad Request" });
    c.set("token", token);

    return next();
});

export default auth;
