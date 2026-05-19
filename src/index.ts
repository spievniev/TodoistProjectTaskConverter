import { Hono } from "hono";
import { log } from "./store/redis";
import auth from "./middleware/auth";
import toTask from "./handlers/to_task";
import toProject from "./handlers/to_project";
import { HTTPException } from "hono/http-exception";
import { errorToString } from "./utils/stringify";

const app = new Hono().use(auth);

app.post("/to_task", toTask);
app.post("/to_project", toProject);

app.notFound((c) => c.text("Not Found", 404));

process.on("uncaughtException", (error) => log("Uncaught exception: " + errorToString(error)));
process.on("unhandledRejection", (error) => log("Unhandled rejection: " + errorToString(error)));

app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();

    log("Error: " + errorToString(error));
    return c.text("Internal Server Error", 500);
});

export default app;
