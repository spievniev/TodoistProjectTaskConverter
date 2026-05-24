import { Choice, ChoiceSetInput, DoistCard, SubmitAction, TextInput, ToggleInput } from "@doist/ui-extensions-core";
import type { Context } from "hono";
import { AuthEnv } from "../middleware/auth";
import { createCommand, SyncCommand, TodoistApi } from "@doist/todoist-sdk";
import { errorResponse, successResponse } from "../todoist/response";
import { isSynced, MAX_PAGE_SIZE, Project } from "../todoist/utils";
import { retryInfoCard, syncInfoCard, syncTooLargeCard } from "../todoist/info_card";
import { countUser, log } from "../store/redis";
import { waitUntil } from "@vercel/functions";
import { randomUUID } from "node:crypto";
import sync, { MAX_SYNC_SIZE } from "../todoist/sync";
import { errorToString } from "../utils/stringify";

const CREATE_NEW_PROJECT = "new_project";
const NO_PARENT_PROJECT = "none";

const INPUT = {
    projectId: "Input.ProjectId",
    projectName: "Input.ProjectName",
    createRedirect: "Input.CreateRedirect",
    moveDescription: "Input.MoveDescription",
    parentId: "Input.ParentId",
};

const ACTION = {
    selectProject: "Submit.SelectProject",
    createProject: "Submit.CreateProject",
    close: "Submit.Close",
};

type Options = {
    createRedirect: boolean;
    moveDescription: boolean;
};

const selectionCard = (projects: Project[]): DoistCard => {
    const card = new DoistCard();

    const choices = [
        Choice.from({ title: "New project", value: CREATE_NEW_PROJECT }),
        ...projects.map(({ id, name }) => Choice.from({ title: name, value: id })),
    ];
    card.addItem(
        ChoiceSetInput.from({
            id: INPUT.projectId,
            label: "Project",
            isRequired: true,
            errorMessage: "Invalid project.",
            defaultValue: CREATE_NEW_PROJECT,
            choices,
            isSearchable: false,
            isMultiSelect: false,
        })
    );

    card.addItem(
        ToggleInput.from({
            id: INPUT.createRedirect,
            title: "Replace with link to the project",
            defaultValue: "true",
        })
    );
    card.addItem(
        ToggleInput.from({
            id: INPUT.moveDescription,
            title: "Move description by creating a new task",
            defaultValue: "true",
        })
    );

    card.addAction(
        SubmitAction.from({
            id: ACTION.selectProject,
            title: "Next",
            style: "positive",
        })
    );

    return card;
};

const creationCard = (defaultProjectName: string, projects: Project[], options: Options): DoistCard => {
    const card = new DoistCard();

    card.addItem(
        TextInput.from({
            id: INPUT.projectName,
            label: "New project name",
            isRequired: true,
            errorMessage: "Invalid project name.",
            defaultValue: defaultProjectName,
        })
    );

    const choices = [
        Choice.from({ title: "None", value: NO_PARENT_PROJECT }),
        ...projects
            .filter(({ inboxProject }) => !inboxProject)
            .map(({ id, name }) => Choice.from({ title: name, value: id })),
    ];
    card.addItem(
        ChoiceSetInput.from({
            id: INPUT.parentId,
            label: "Parent project",
            isRequired: true,
            errorMessage: "Invalid project.",
            defaultValue: NO_PARENT_PROJECT,
            choices,
            isSearchable: false,
            isMultiSelect: false,
        })
    );

    card.addAction(
        SubmitAction.from({
            id: ACTION.createProject,
            title: "Next",
            style: "positive",
            data: { options },
        })
    );

    return card;
};

const convertTaskToProject = async (
    api: TodoistApi,
    taskId: string,
    projectId: string,
    options: Options
): Promise<DoistCard> => {
    const commands: SyncCommand[] = [];
    const task = await api.getTask(taskId);

    if (options.createRedirect) {
        commands.push(
            createCommand("item_update", {
                id: task.id,
                content: `[[Converted to Project](https://app.todoist.com/app/project/${projectId})] ${task.content}`,
            })
        );
    }

    if (options.moveDescription && task.description) {
        commands.push(
            createCommand(
                "item_add",
                {
                    content: "* [Description]",
                    description: task.description,
                    projectId,
                },
                // Temp ID is required to create task.
                randomUUID()
            ),
            createCommand("item_update", {
                id: task.id,
                description: "",
            })
        );
    }

    const subtasks = (await api.getTasks({ parentId: task.id, limit: MAX_PAGE_SIZE })).results;
    if (subtasks.length >= MAX_PAGE_SIZE) return syncTooLargeCard(ACTION.close, "task");
    commands.push(...subtasks.map(({ id }) => createCommand("item_move", { id, projectId })));

    if (commands.length > MAX_SYNC_SIZE) return syncTooLargeCard(ACTION.close, "task");

    // Don't wait for sync to complete or the response will timeout.
    waitUntil(sync(api, commands));
    return syncInfoCard(ACTION.close, "task");
};

const toProject = async (c: Context<AuthEnv>) => {
    let userId = null;
    try {
        const token = c.get("token");
        if (!token) return c.json(errorResponse("Internal server error: no token."));
        const api = new TodoistApi(token);

        const body = await c.req.json();
        userId = body.context.user.id;
        if (!userId) return c.json(errorResponse("Invalid request: no user id."));

        const { actionType, actionId, params, inputs, data } = body.action;
        const { contentPlain: taskTitle, sourceId: taskId } = params;

        if (actionType === "initial") {
            if (!isSynced(taskId)) return c.json({ card: retryInfoCard(ACTION.close, "task") });
            log(`${userId}: toProject/initial`);

            const projects: Project[] = (await api.getProjects({ limit: 200 })).results;
            return c.json({ card: selectionCard(projects) });
        } else if (actionId === ACTION.selectProject) {
            const createRedirect: string | undefined = inputs[INPUT.createRedirect];
            const moveDescription: string | undefined = inputs[INPUT.moveDescription];
            const projectId: string | undefined = inputs[INPUT.projectId];
            if (!createRedirect || !moveDescription || !projectId) {
                return c.json(errorResponse("Invalid request: missing input."));
            }
            log(`${userId}: toProject/select ${projectId} ${createRedirect} ${moveDescription}`);

            const options = {
                createRedirect: createRedirect === "true",
                moveDescription: moveDescription === "true",
            };
            if (projectId === CREATE_NEW_PROJECT) {
                const projects: Project[] = (await api.getProjects({ limit: 200 })).results;
                return c.json({ card: creationCard(taskTitle, projects, options) });
            } else {
                const card = await convertTaskToProject(api, taskId, projectId, options);
                return c.json({ card });
            }
        } else if (actionId === ACTION.createProject) {
            const projectName: string | undefined = inputs[INPUT.projectName];
            const parentId: string | undefined = inputs[INPUT.parentId];
            if (!projectName || !parentId) return c.json(errorResponse("Invalid request: missing input."));
            log(`${userId}: toProject/create ${projectName.length} ${parentId}`);

            const project = await api.addProject({
                name: projectName,
                parentId: parentId === NO_PARENT_PROJECT ? undefined : parentId,
            });

            const card = await convertTaskToProject(api, taskId, project.id, data.options);
            return c.json({ card });
        } else if (actionId === ACTION.close) {
            log(`${userId}: toProject/close`);
            countUser(userId);
            return c.json(successResponse());
        } else {
            log(`${userId}: toProject/error unknown action type`);
            return c.json(errorResponse("Unknown action type."));
        }
    } catch (error) {
        log(`${userId}: toProject/error unexpected error: ${errorToString(error)}`);
        return c.json(errorResponse("Unexpected error during conversion."));
    }
};

export default toProject;
