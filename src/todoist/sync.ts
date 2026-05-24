import { SyncCommand, TodoistApi } from "@doist/todoist-sdk";
import { log } from "../store/redis";

export const MAX_SYNC_SIZE = 200;

const BATCH_SIZE = 50;

// Todoist's sync limits the number of commands so sync in batches.
const sync = async (api: TodoistApi, commands: SyncCommand[]) => {
    let tempIdMap: Record<string, string> = {};
    let syncToken: string | undefined = undefined;
    for (let i = 0; i < commands.length; i += BATCH_SIZE) {
        const batch = commands.slice(i, i + BATCH_SIZE);

        for (const command of batch) {
            for (const key of Object.keys(command.args)) {
                const id = tempIdMap[key];
                if (id) command.args[key] = id;
            }
        }

        const response = await api.sync({ commands: batch, resourceTypes: [], syncToken });
        tempIdMap = { ...tempIdMap, ...response.tempIdMapping };
        syncToken = response.syncToken;

        for (const [id, status] of Object.entries(response.syncStatus || {})) {
            if (status === "ok") continue;

            const command = batch.find((command) => command.uuid === id);
            if (!command) throw new Error("Unable to find failed command");

            log(`
Error during sync:
Command: ${JSON.stringify(command)}
Status: ${JSON.stringify(status)}
        `);
        }
    }
};

export default sync;
