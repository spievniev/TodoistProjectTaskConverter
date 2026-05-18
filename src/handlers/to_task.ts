import { Choice, ChoiceSetInput, DoistCard, SubmitAction, ToggleInput } from "@doist/ui-extensions-core";
import type { Context } from "hono";
import { AuthEnv } from "../middleware/auth";
import { createCommand, SyncCommand, TodoistApi } from "@doist/todoist-sdk";
import { log } from "../store/redis";
import { errorResponse, successResponse } from "../todoist/response";
import { retryInfoCard, syncInfoCard } from "../todoist/info_card";
import { isSynced, Project } from "../todoist/utils";
import { randomUUID } from "node:crypto";
import paginatedRequest from "../todoist/paginated_request";

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
) => {
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

    const tasks = await paginatedRequest(api, api.getTasks, { projectId, limit: 200 });
    const topLevelTasks = tasks.filter((task) => task.parentId === null);
    if (groupBySections) {
        const tasksWithoutSection = topLevelTasks.filter((task) => !task.sectionId);
        commands.push(
            ...tasksWithoutSection.map((task) => createCommand("item_move", { id: task.id, parentId: "root" }))
        );

        const sections = await paginatedRequest(api, api.getSections, { projectId: projectId, limit: 200 });
        await Promise.all(
            sections.map(async (section) => {
                const sectionTasks = await paginatedRequest(api, api.getTasks, { sectionId: section.id, limit: 200 });
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

    const response = await api.sync({ commands });
    log(JSON.stringify(response));
};

const toTask = async (c: Context<AuthEnv>) => {
    try {
        const token = c.get("token");
        if (!token) return c.json(errorResponse("Internal server error: no token."));
        const api = new TodoistApi(token);

        const body = await c.req.json();
        const { actionType, actionId, params, inputs } = body.action;
        const { sourceId: projectId } = params;

        if (actionType === "initial") {
            if (!isSynced(projectId)) return c.json({ card: retryInfoCard(ACTION.close, "project") });

            const projects: Project[] = (await api.getProjects({ limit: 200 })).results;
            return c.json({ card: inputCard(projects) });
        } else if (actionId === ACTION.convert) {
            const newTaskProjectId = inputs[INPUT.projectId];
            const groupBySections = inputs[INPUT.groupBySections];
            if (!newTaskProjectId || !groupBySections) return c.json(errorResponse("Invalid request: missing input."));

            await convertProjectToTask(api, groupBySections === "true", projectId, newTaskProjectId);
            return c.json({ card: syncInfoCard(ACTION.close, "project") });
        } else if (actionId === ACTION.close) {
            return c.json(successResponse());
        } else {
            return c.json(errorResponse("Unknown action type."));
        }
    } catch (error) {
        log("Unexpected error while converting project to task: " + JSON.stringify(error));
        return c.json(errorResponse("Unexpected error during conversion."));
    }
};

export default toTask;
