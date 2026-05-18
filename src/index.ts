import { Hono } from "hono";
import { log } from "./store/redis";
import auth from "./middleware/auth";
import toTask from "./handlers/to_task";
import toProject from "./handlers/to_project";

process.on("uncaughtException", (error) => log("Uncaught exception: " + JSON.stringify(error)));

const app = new Hono().use(auth);

app.post("/to_task", toTask);
app.post("/to_project", toProject);

app.notFound(async (c) => c.text("Not Found", 404));

export default app;
