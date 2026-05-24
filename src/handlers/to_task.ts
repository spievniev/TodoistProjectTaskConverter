import { Choice, ChoiceSetInput, DoistCard, SubmitAction, ToggleInput } from "@doist/ui-extensions-core";
import type { Context } from "hono";
import { AuthEnv } from "../middleware/auth";
import { createCommand, SyncCommand, TodoistApi } from "@doist/todoist-sdk";
import { countUser, log } from "../store/redis";
import { errorResponse, successResponse } from "../todoist/response";
import { retryInfoCard, syncInfoCard, syncTooLargeCard } from "../todoist/info_card";
import { isSynced, MAX_PAGE_SIZE, Project } from "../todoist/utils";
import { randomUUID } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import sync, { MAX_SYNC_SIZE } from "../todoist/sync";
import { errorToString } from "../utils/stringify";

const INPUT = {
    projectId: "Input.ProjectId",
    groupBySections: "Input.GroupBySections",
};

const ACTION = {
    convert: "Submit.Convert",
    close: "Submit.Close",
};

const inputCard = (projects: Project[]): DoistCard => {
    const card = new DoistCard();

    const inboxProject = projects.find((project) => project.inboxProject)?.id || projects[0].id;
    const choices = [...projects.map(({ id, name }) => Choice.from({ title: name, value: id }))];
    card.addItem(
        ChoiceSetInput.from({
            id: INPUT.projectId,
            label: "Where to create task",
            isRequired: true,
            errorMessage: "Invalid project.",
            defaultValue: inboxProject,
            choices,
            isSearchable: false,
            isMultiSelect: false,
        })
    );

    card.addItem(
        ToggleInput.from({
            id: INPUT.groupBySections,
            title: "Group by sections",
            defaultValue: "true",
        })
    );

    card.addAction(
        SubmitAction.from({
            id: ACTION.convert,
            title: "Next",
            style: "positive",
        })
    );

    return card;
};

const convertProjectToTask = async (
    api: TodoistApi,
    groupBySections: boolean,
    projectId: string,
    newTaskProjectId: string
): Promise<DoistCard> => {
    const commands: SyncCommand[] = [];
    const project = await api.getProject(projectId);

    commands.push(
        createCommand(
            "item_add",
            {
                content: project.name,
                projectId: newTaskProjectId,
            },
            "root"
        )
    );

    const tasks = (await api.getTasks({ projectId, limit: MAX_PAGE_SIZE })).results;
    if (tasks.length >= MAX_PAGE_SIZE) return syncTooLargeCard(ACTION.close, "project");

    const topLevelTasks = tasks.filter((task) => task.parentId === null);
    if (groupBySections) {
        const tasksWithoutSection = topLevelTasks.filter((task) => !task.sectionId);
        commands.push(
            ...tasksWithoutSection.map((task) => createCommand("item_move", { id: task.id, parentId: "root" }))
        );

        const sections = (await api.getSections({ projectId: projectId, limit: MAX_PAGE_SIZE })).results;
        await Promise.all(
            sections.map(async (section) => {
                const sectionTasks = (await api.getTasks({ sectionId: section.id, limit: MAX_PAGE_SIZE })).results;
                const sectionTaskId = randomUUID();

                commands.push(
                    createCommand(
                        "item_add",
                        {
                            content: section.name,
                            parentId: "root",
                        },
                        sectionTaskId
                    )
                );

                commands.push(
                    ...sectionTasks.map((task) => createCommand("item_move", { id: task.id, parentId: sectionTaskId }))
                );
            })
        );
    } else {
        commands.push(...topLevelTasks.map((task) => createCommand("item_move", { id: task.id, parentId: "root" })));
    }

    if (commands.length > MAX_SYNC_SIZE) return syncTooLargeCard(ACTION.close, "project");

    // Don't wait for sync to complete or the response will timeout.
    waitUntil(sync(api, commands));
    return syncInfoCard(ACTION.close, "project");
};

const toTask = async (c: Context<AuthEnv>) => {
    let userId = null;
    try {
        const token = c.get("token");
        if (!token) return c.json(errorResponse("Internal server error: no token."));
        const api = new TodoistApi(token);

        const body = await c.req.json();
        userId = body.context.user.id;
        if (!userId) return c.json(errorResponse("Invalid request: no user id."));

        const { actionType, actionId, params, inputs } = body.action;
        const { sourceId: projectId } = params;

        if (actionType === "initial") {
            if (!isSynced(projectId)) return c.json({ card: retryInfoCard(ACTION.close, "project") });
            log(`${userId}: toTask/initial`);

            const projects: Project[] = (await api.getProjects({ limit: 200 })).results;
            return c.json({ card: inputCard(projects) });
        } else if (actionId === ACTION.convert) {
            const newTaskProjectId: string | undefined = inputs[INPUT.projectId];
            const groupBySections: string | undefined = inputs[INPUT.groupBySections];
            if (!newTaskProjectId || !groupBySections) return c.json(errorResponse("Invalid request: missing input."));
            log(`${userId}: toTask/convert ${newTaskProjectId} ${groupBySections}`);

            const card = await convertProjectToTask(api, groupBySections === "true", projectId, newTaskProjectId);
            return c.json({ card });
        } else if (actionId === ACTION.close) {
            log(`${userId}: toTask/close`);
            countUser(userId);
            return c.json(successResponse());
        } else {
            log(`${userId}: toTask/error unknown action type`);
            return c.json(errorResponse("Unknown action type."));
        }
    } catch (error) {
        log(`${userId}: toTask/error unexpected error: ${errorToString(error)}`);
        return c.json(errorResponse("Unexpected error during conversion."));
    }
};

export default toTask;
