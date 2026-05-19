import { Choice, ChoiceSetInput, DoistCard, SubmitAction, TextInput, ToggleInput } from "@doist/ui-extensions-core";
import type { Context } from "hono";
import { AuthEnv } from "../middleware/auth";
import { createCommand, SyncCommand, TodoistApi } from "@doist/todoist-sdk";
import { errorResponse, successResponse } from "../todoist/response";
import { isSynced, Project } from "../todoist/utils";
import { retryInfoCard, syncInfoCard } from "../todoist/info_card";
import { log } from "../store/redis";
import paginatedRequest from "../todoist/paginated_request";
import { randomUUID } from "node:crypto";

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

const convertTaskToProject = async (api: TodoistApi, taskId: string, projectId: string, options: Options) => {
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

    const subtasks = await paginatedRequest(api, api.getTasks, { parentId: task.id, limit: 200 });
    commands.push(...subtasks.map(({ id }) => createCommand("item_move", { id, projectId })));

    const response = await api.sync({ commands });
    log(JSON.stringify(response));
};

const toProject = async (c: Context<AuthEnv>) => {
    try {
        const token = c.get("token");
        if (!token) return c.json(errorResponse("Internal server error: no token."));
        const api = new TodoistApi(token);

        const body = await c.req.json();
        const { actionType, actionId, params, inputs, data } = body.action;
        const { contentPlain: taskTitle, sourceId: taskId } = params;

        if (actionType === "initial") {
            if (!isSynced(taskId)) return c.json({ card: retryInfoCard(ACTION.close, "task") });

            const projects: Project[] = (await api.getProjects({ limit: 200 })).results;
            return c.json({ card: selectionCard(projects) });
        } else if (actionId === ACTION.selectProject) {
            const createRedirect = inputs[INPUT.createRedirect];
            const moveDescription = inputs[INPUT.moveDescription];
            const projectId = inputs[INPUT.projectId];
            if (!createRedirect || !moveDescription || !projectId) {
                return c.json(errorResponse("Invalid request: missing input."));
            }

            const options = {
                createRedirect: createRedirect === "true",
                moveDescription: moveDescription === "true",
            };
            if (projectId === CREATE_NEW_PROJECT) {
                const projects: Project[] = (await api.getProjects({ limit: 200 })).results;
                return c.json({ card: creationCard(taskTitle, projects, options) });
            } else {
                await convertTaskToProject(api, taskId, projectId, options);
                return c.json({ card: syncInfoCard(ACTION.close, "task") });
            }
        } else if (actionId === ACTION.createProject) {
            const projectName = inputs[INPUT.projectName];
            const parentId = inputs[INPUT.parentId];
            if (!projectName || !parentId) return c.json(errorResponse("Invalid request: missing input."));

            const project = await api.addProject({
                name: projectName,
                parentId: parentId === NO_PARENT_PROJECT ? null : parentId,
            });

            await convertTaskToProject(api, taskId, project.id, data.options);
            return c.json({ card: syncInfoCard(ACTION.close, "task") });
        } else if (actionId === ACTION.close) {
            return c.json(successResponse());
        } else {
            return c.json(errorResponse("Unknown action type."));
        }
    } catch (error) {
        log("Unexpected error while converting task to project: " + JSON.stringify(error));
        return c.json(errorResponse("Unexpected error during conversion."));
    }
};

export default toProject;
